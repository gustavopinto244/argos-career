import { z } from "zod";
import { Profile } from "../../profile/domain/profile";
import { MatchesRepository } from "../../persistence/infrastructure/matches-repository";
import {
  isEvidenceApplicableToRequirement,
  isKnownProfileEvidence,
} from "../domain/evidence-provenance";
import { sanitizeLogLabel } from "../domain/log-label";
import { hashRequirements } from "../domain/requirements-hash";
import { LlmFailureDiagnostic } from "../domain/failure-diagnostic";
import {
  createMatch,
  Match,
  MAX_MATCH_EVIDENCE_CHARS,
  Requirement,
} from "../domain/types";
import { AskModel, parseModelOutputWithRetries } from "./llm-output";
import { createStageBPromptBuilder, STAGE_B_PROMPT_VERSION } from "./prompts";

const MatchOutputSchema = z.object({
  status: z.enum(["met", "partial", "not_met"]),
  evidence: z.string().min(1).max(MAX_MATCH_EVIDENCE_CHARS).nullable(),
});

/**
 * Used when `criteria.yaml` says nothing. Eight is deliberately modest: the
 * bound exists to cut wall-clock, not to extract maximum throughput from a
 * shared API, and every unit of concurrency is one more prompt that may be
 * in flight before the cached prefix it wants has landed (ADR-022).
 */
export const DEFAULT_STAGE_B_CONCURRENCY = 8;

export type MatchingResult =
  | {
      readonly ok: true;
      readonly matches: readonly Match[];
      readonly cacheHit: boolean;
      readonly evidenceRejectedCount: number;
    }
  | {
      readonly ok: false;
      readonly reason: "matching_failed";
      readonly attempts: number;
      /** docs/audit PR-007 — see `ExtractionResult`'s matching field for the
       * full reasoning. True only when `parseModelOutputWithRetries`
       * itself reported `permanent_error`, never for the local
       * `buildStageBPrompt` template-read failure below. */
      readonly permanent: boolean;
      readonly diagnostic: LlmFailureDiagnostic;
    };

/** One requirement's answer, or the attempt count that failed to produce it. */
type Answer =
  | {
      readonly ok: true;
      readonly match: Match;
      readonly evidenceRejected: boolean;
    }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly permanent: boolean;
      readonly diagnostic: LlmFailureDiagnostic;
    };

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving input
 * order in the result. Stops handing out new work as soon as one task
 * reports failure — calls already in flight still settle, but the remaining
 * requirements are never asked, which is the sequential loop's behaviour
 * held onto rather than abandoned for concurrency's sake.
 */
async function runBounded(
  items: readonly Requirement[],
  limit: number,
  task: (item: Requirement, index: number) => Promise<Answer>,
  indexOffset: number = 0,
): Promise<(Answer | undefined)[]> {
  const results: (Answer | undefined)[] = new Array<Answer | undefined>(
    items.length,
  );
  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item) return;
      const answer = await task(item, index + indexOffset);
      results[index] = answer;
      if (!answer.ok) stopped = true;
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Stage B (docs/04-scoring-model.md): one model call per requirement,
 * cached whole by `(fingerprint, profileHash, promptVersion, model,
 * requirementsHash)` (ADR-007/042).
 * `evidence: null` is coerced to `not_met` by `createMatch` regardless of
 * what `status` the model returned — ADR-005's rule, enforced in code, not
 * merely requested in the prompt.
 *
 * A failure on any one requirement does not publish the whole-result cache,
 * but each valid answer is checkpointed by requirement index under the same
 * semantic identity. The next run resumes only the missing requirements;
 * the complete cache is published only after every position is present.
 *
 * Those calls run **concurrently**, bounded by `concurrency` (ADR-022). This
 * is the highest-volume stage in the pipeline — one call per requirement,
 * ~25 per posting — and issuing them sequentially measured at 213.8s for a
 * single posting, or ~18h across a 310-posting backlog. Nothing the model
 * sees changes: same prompt per requirement, same isolation between them,
 * same cache keys. Only the waiting overlaps.
 *
 * The first requirement is deliberately asked **alone**, before the rest.
 * ADR-013 restructured this prompt so the large `PROFILE_EVIDENCE` block is
 * a shared prefix every stage B call can hit in the provider's prompt cache
 * (measured at 71% of prompt tokens). A cold prefix launched N ways at once
 * would have all N miss it, trading the cost lever away for the latency one.
 * One warming call costs a few seconds and keeps both.
 */
export class StageBMatcher {
  constructor(
    private readonly ask: AskModel,
    private readonly matchesRepo: MatchesRepository,
    private readonly promptVersion: string = STAGE_B_PROMPT_VERSION,
    private readonly concurrency: number = DEFAULT_STAGE_B_CONCURRENCY,
    /** Which model `ask` actually calls (docs/audit AC-007) — part of the
     * cache key so switching `LLM_MODEL` cannot silently reuse a different
     * model's matches. Defaulted for tests that do not care about model
     * identity; `build-scorer.ts` always passes the real configured value. */
    private readonly model: string = "unknown",
  ) {}

  async match(
    fingerprint: string,
    requirements: readonly Requirement[],
    profile: Profile,
    profileHash: string,
    now: () => Date = () => new Date(),
  ): Promise<MatchingResult> {
    // One immutable instant owns profile hashing (the caller passes the hash
    // computed for this instant), prompt evidence, provenance and cache time.
    // Capturing it once prevents semester-boundary key/prompt drift.
    const evaluatedAt = now();
    const requirementsHash = hashRequirements(requirements);
    const cached = this.matchesRepo.find(
      fingerprint,
      profileHash,
      this.promptVersion,
      this.model,
      requirementsHash,
    );
    // Reconciled against the *current* requirement list, not trusted on the
    // strength of requirementsHash alone (docs/audit PR-013): the hash
    // already makes a coincidental match astronomically unlikely, but it
    // says nothing about a row whose `matches` JSON was corrupted or
    // hand-edited independently of that column (a restore, AC-031's
    // scenario) — a count that no longer matches, or a requirement that no
    // longer lines up positionally, is exactly the "structurally valid
    // JSON, wrong content" shape a bare `Array.isArray`/schema check alone
    // cannot catch. A mismatch here is not fatal -- it degrades to a cache
    // miss, the same cost principle 1 already assigns to any other miss.
    if (
      cached &&
      cached.length === requirements.length &&
      cached.every((match, i) => {
        const current = requirements[i];
        return (
          current !== undefined &&
          match.requirement.text === current.text &&
          match.requirement.category === current.category &&
          match.requirement.weight === current.weight &&
          match.requirement.verifiable === current.verifiable &&
          (match.evidence === null ||
            (isKnownProfileEvidence(match.evidence, profile, evaluatedAt) &&
              isEvidenceApplicableToRequirement(
                match.evidence,
                current,
                profile,
                evaluatedAt,
              )))
        );
      })
    ) {
      return {
        ok: true,
        matches: cached,
        cacheHit: true,
        evidenceRejectedCount: 0,
      };
    }

    let buildPrompt: (requirement: Requirement) => string;
    try {
      buildPrompt = createStageBPromptBuilder(profile, undefined, evaluatedAt);
    } catch {
      return {
        ok: false,
        reason: "matching_failed",
        attempts: 0,
        permanent: false,
        diagnostic: { kind: "prompt_build_failed" },
      };
    }

    const partial = this.matchesRepo.findPartial(
      fingerprint,
      profileHash,
      this.promptVersion,
      this.model,
      requirementsHash,
      requirements,
    );

    /** Whether this requirement is answered from the partial cache and so
     * costs no model call — the predicate `askOne` short-circuits on, named
     * because the warming logic below has to ask the same question before
     * deciding which requirement to warm with. */
    const servedFromPartial = (
      requirement: Requirement,
      requirementIndex: number,
    ): boolean => {
      const saved = partial[requirementIndex];
      return Boolean(
        saved &&
        (saved.evidence === null ||
          (isKnownProfileEvidence(saved.evidence, profile, evaluatedAt) &&
            isEvidenceApplicableToRequirement(
              saved.evidence,
              requirement,
              profile,
              evaluatedAt,
            ))),
      );
    };

    const askOne = async (
      requirement: Requirement,
      requirementIndex: number,
    ): Promise<Answer> => {
      const saved = partial[requirementIndex];
      if (saved && servedFromPartial(requirement, requirementIndex)) {
        return { ok: true, match: saved, evidenceRejected: false };
      }
      // Same disk read, same contract, as stage A — see `StageAExtractor`.
      // `evaluatedAt` is captured once and reused for both the prompt's
      // academic-evidence line and the provenance check below, so the two
      // can never disagree with each other about "what period is it" within
      // a single call. `executeDeliver` also uses this exact instant for
      // `profileHash` and passes it through `ScorerPort.score`, closing the
      // semester-boundary drift described by PR-018.
      const prompt = buildPrompt(requirement);

      const result = await parseModelOutputWithRetries(
        MatchOutputSchema,
        this.ask,
        prompt,
        {
          // `requirement.text` originates in an untrusted posting
          // description (docs/audit PR-010) — sanitized before it can reach
          // a log line, not interpolated raw.
          operationLabel: `stage-b:${fingerprint}:${sanitizeLogLabel(requirement.text)}`,
        },
      );
      if (!result.ok) {
        return {
          ok: false,
          attempts: result.attempts,
          permanent: result.reason === "permanent_error" && result.batchFatal,
          diagnostic: result.diagnostic,
        };
      }

      // Evidence provenance (docs/audit AC-008, SECURITY.md's claim that
      // "it cannot manufacture evidence that is not in the profile" —
      // previously unenforced): `MatchOutputSchema` only checks that
      // `evidence` is a non-empty string, so a prompt-injected instruction
      // returning syntactically valid JSON with fabricated evidence text
      // would otherwise pass straight through to `createMatch` and count
      // toward `mandatoryCoverage`. A quote that does not verbatim-match a
      // real profile evidence line is treated exactly like `evidence: null`
      // — `createMatch` already coerces that to `not_met`.
      const suppliedEvidence = result.data.evidence;
      const evidence =
        suppliedEvidence !== null &&
        isKnownProfileEvidence(suppliedEvidence, profile, evaluatedAt) &&
        isEvidenceApplicableToRequirement(
          suppliedEvidence,
          requirement,
          profile,
          evaluatedAt,
        )
          ? suppliedEvidence
          : null;

      const match = createMatch(requirement, result.data.status, evidence);
      this.matchesRepo.upsertPartial(
        fingerprint,
        profileHash,
        this.promptVersion,
        this.model,
        requirementsHash,
        requirementIndex,
        match,
        evaluatedAt,
      );
      return {
        ok: true,
        match,
        evidenceRejected: suppliedEvidence !== null && evidence === null,
      };
    };

    const answers: (Answer | undefined)[] = [];

    // The warming call (see the class docblock): one cold prefix, paid once,
    // so the concurrent calls behind it hit the provider's cache instead of
    // all racing the same miss.
    //
    // It has to be the first requirement that *actually reaches the model*,
    // not index 0 unconditionally. On a run resumed after a mid-batch
    // failure — precisely when a partial cache exists — index 0 is typically
    // served from `partial` and returns without calling anything, so the
    // remaining N−1 launched straight into a still-cold prefix: the exact
    // stampede this design exists to prevent, in the one case it was most
    // likely to happen.
    let warmIndex = 0;
    while (
      warmIndex < requirements.length &&
      servedFromPartial(requirements[warmIndex]!, warmIndex)
    ) {
      warmIndex++;
    }

    // Everything before the warming index is a cache hit, so awaiting them in
    // order costs nothing and keeps `answers` index-aligned with
    // `requirements`.
    for (let i = 0; i < warmIndex; i++) {
      answers.push(await askOne(requirements[i]!, i));
    }

    const warming = requirements[warmIndex];
    if (warming) answers.push(await askOne(warming, warmIndex));

    if (answers.every((answer) => answer?.ok)) {
      answers.push(
        ...(await runBounded(
          requirements.slice(warmIndex + 1),
          this.concurrency,
          askOne,
          warmIndex + 1,
        )),
      );
    }

    const matches: Match[] = [];
    let evidenceRejectedCount = 0;
    for (const answer of answers) {
      // `undefined` means the requirement was never asked, because an earlier
      // one failed and `runBounded` stopped handing out work.
      if (!answer) break;
      if (!answer.ok) {
        return {
          ok: false,
          reason: "matching_failed",
          attempts: answer.attempts,
          permanent: answer.permanent,
          diagnostic: answer.diagnostic,
        };
      }
      matches.push(answer.match);
      if (answer.evidenceRejected) evidenceRejectedCount += 1;
    }

    // A stopped run leaves fewer answers than requirements. Caching that
    // would poison the key, which covers the full requirement set (ADR-007).
    // Not itself a permanent-transport failure -- the requirement(s) that
    // stopped the run already reported that above; this branch only fires
    // when every answer that came back was ok but the count still fell
    // short (defensive, `runBounded`'s own invariant).
    if (matches.length !== requirements.length) {
      return {
        ok: false,
        reason: "matching_failed",
        attempts: 0,
        permanent: false,
        diagnostic: { kind: "output_schema_rejected" },
      };
    }

    this.matchesRepo.upsert(
      fingerprint,
      profileHash,
      this.promptVersion,
      this.model,
      requirementsHash,
      matches,
      evaluatedAt,
    );
    return { ok: true, matches, cacheHit: false, evidenceRejectedCount };
  }
}

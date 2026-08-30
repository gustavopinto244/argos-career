import { classifyTrack } from "../../prefilter/domain/classify-track";
import { Criteria } from "../../prefilter/domain/criteria";
import { Posting } from "../../posting/domain/posting";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { computeScore } from "../domain/score";
import { computeRecommendation } from "../domain/recommendation";
import { ScorerPort, ScoreResult } from "../domain/ports/scorer.port";
import { Requirement, Track } from "../domain/types";
import { StageAExtractor } from "./stage-a-extractor";
import { StageBMatcher } from "./stage-b-matcher";
import { Profile } from "../../profile/domain/profile";
import { buildScoringConfig } from "./scoring-config";

/**
 * The production scorer (ADR-012/013/016): stage A -> stage B -> stage C,
 * exactly the flow `docs/04-scoring-model.md` specifies, with a hosted model
 * behind `StageAExtractor`/`StageBMatcher`. Track classification is the same
 * deterministic pre-filter function `StubScorer` uses — never an LLM call,
 * per principle 1 of `02-architecture.md`.
 *
 * A failure at either stage returns as a value, never throws — matching
 * `StubScorer` and every other port in this project.
 */
/**
 * The track that feeds `trackAlignment` (ADR-059) — the score's track, which
 * is a different question from the pre-filter's.
 *
 * The pre-filter must classify on the title alone: it runs *before* any LLM
 * call and decides whether to spend one at all, so its input is limited to
 * what is free to read. Scoring runs after Stage A, and by then something
 * strictly better exists — the extracted requirements, which are the
 * posting's own stated demands with the HR boilerplate already stripped out
 * by extraction.
 *
 * Falls back rather than unions, deliberately. A title that already
 * classifies is left completely alone, so this cannot change the score of any
 * posting that was classifying correctly before — it only reaches postings
 * that were scoring `unknown` (86% of the corpus) and getting capped by
 * `unknownTrackCapScore`. Unioning would instead let a stray requirement add
 * a higher-weighted track to a posting whose title was unambiguous, which is
 * a behaviour change nobody asked for.
 *
 * Measured before being written (docs/11-known-issues.md B9): classifying on
 * the raw *description* was tried first and rejected — 438 postings newly
 * classified, almost all off-track ("Operador(a) de Caixa" as `dev`), because
 * descriptions carry the boilerplate extraction removes.
 *
 * `trackExclusions` still apply, now against the joined requirement text. One
 * stray excluded phrase therefore vetoes that track for the whole posting —
 * blunter than it is on a title, and deliberately so: it errs toward
 * `unknown`, which is the conservative direction.
 */
export function resolveScoringTracks(
  titleTracks: readonly Track[],
  requirements: readonly Requirement[],
  criteria: Criteria,
): Track[] {
  if (titleTracks.length > 0) return [...titleTracks];
  return classifyTrack(
    requirements.map((requirement) => requirement.text).join(" . "),
    criteria.tracks,
    criteria.trackExclusions,
  );
}

export class ApiScorer implements ScorerPort {
  constructor(
    private readonly extractor: StageAExtractor,
    private readonly matcher: StageBMatcher,
    private readonly profile: Profile,
    private readonly criteria: Criteria,
    private readonly postingsRepo: PostingsRepository,
  ) {}

  /**
   * Honours `ScorerPort`'s "it never rejects" contract for real, not just in
   * the paths that already return a failure value.
   *
   * Stages A and B convert their own LLM failures into results, but this
   * method also does synchronous better-sqlite3 writes —
   * `postingsRepo.updateExtractedFields` here, `matchesRepo.upsertPartial`
   * and `upsert` inside `StageBMatcher` — and those *throw* on `SQLITE_BUSY`
   * or a full disk. Nothing caught them, and `executeDeliver` treats a throw
   * from the scorer as a whole-run abort: the run row is marked `failed`,
   * claims are released, the error re-raised, and **no digest goes out at
   * all**. One busy write, on one posting, cost the entire nightly batch.
   *
   * That is not hypothetical contention: the nightly backup runs
   * `VACUUM INTO` against this same database file.
   *
   * A caught throw becomes `matching_failed` — the same shape a Stage B
   * failure already produces, so the posting lands in the review section
   * with `lowConfidence` (ADR-006) and every other posting in the batch
   * still gets scored and delivered.
   */
  async score(
    posting: Posting,
    profileHash: string,
    evaluatedAt: Date = new Date(),
  ): Promise<ScoreResult> {
    try {
      return await this.scoreOrThrow(posting, profileHash, evaluatedAt);
    } catch (cause) {
      return {
        ok: false,
        reason: "matching_failed",
        attempts: 1,
        permanent: true,
        diagnostic: {
          stage: "stage-b",
          kind: "permanent_error",
          errorType: cause instanceof Error ? cause.name : typeof cause,
        },
      };
    }
  }

  private async scoreOrThrow(
    posting: Posting,
    profileHash: string,
    evaluatedAt: Date,
  ): Promise<ScoreResult> {
    const titleTracks = classifyTrack(
      posting.title,
      this.criteria.tracks,
      this.criteria.trackExclusions,
    );

    const extraction = await this.extractor.extract(posting);
    if (!extraction.ok) {
      return {
        ok: false,
        reason: extraction.reason,
        attempts: extraction.attempts,
        permanent: extraction.permanent,
        diagnostic: { stage: "stage-a", ...extraction.diagnostic },
      };
    }

    // Written back regardless of cache hit/miss — a cache hit still carries
    // the seniority/experienceYears extracted the first time (05-domain-model.md).
    this.postingsRepo.updateExtractedFields(
      posting.fingerprint,
      extraction.seniority,
      extraction.experienceYears,
    );

    const matching = await this.matcher.match(
      posting.fingerprint,
      extraction.requirements,
      this.profile,
      profileHash,
      () => evaluatedAt,
    );
    if (!matching.ok) {
      return {
        ok: false,
        reason: matching.reason,
        attempts: matching.attempts,
        permanent: matching.permanent,
        diagnostic: { stage: "stage-b", ...matching.diagnostic },
      };
    }

    const outcome = computeScore(
      matching.matches,
      resolveScoringTracks(titleTracks, extraction.requirements, this.criteria),
      buildScoringConfig(this.criteria),
      { courseStart: this.profile.courseStart, today: evaluatedAt },
    );
    const recommendation = computeRecommendation(
      matching.matches,
      this.profile,
    );
    return {
      ok: true,
      ...outcome,
      ...recommendation,
      inputTruncated: extraction.inputTruncated,
      stageACacheHit: extraction.cacheHit,
      stageBCacheHit: matching.cacheHit,
      evidenceRejectedCount: matching.evidenceRejectedCount,
    };
  }
}

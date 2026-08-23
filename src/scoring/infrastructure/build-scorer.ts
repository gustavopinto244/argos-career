import { Db } from "../../persistence/infrastructure/db";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../../persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { Criteria } from "../../prefilter/domain/criteria";
import { Profile } from "../../profile/domain/profile";
import { ScorerPort } from "../domain/ports/scorer.port";
import { ApiScorer } from "./api-scorer";
import {
  DEFAULT_MAX_COMPLETION_TOKENS,
  OpenRouterClient,
  UsageTotals,
} from "./openrouter-client";
import {
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_VERSION,
  verifyPromptTemplates,
} from "./prompts";
import { StageAExtractor } from "./stage-a-extractor";
import { StageBMatcher } from "./stage-b-matcher";
import { StubScorer } from "./stub-scorer";

/** Initial operation-specific limits from the 2026-08-18 incident audit.
 * Stage A produces a full requirement list and has historically taken
 * 40–67s cold; Stage B produces one bounded object per requirement. */
export const STAGE_A_TIMEOUT_MS = 120_000;
export const STAGE_B_TIMEOUT_MS = 30_000;
/** ADR-052 Amendment 1: post-deploy validation showed every Stage A
 * `invalidOutput` failure was `finishReason: "length"` with empty content,
 * uniform across 8 different providers — a token-budget problem, not a
 * transport or provider one. 4x the shared default, generous headroom for
 * reasoning output ahead of the JSON requirement list itself. */
export const STAGE_A_MAX_COMPLETION_TOKENS = DEFAULT_MAX_COMPLETION_TOKENS * 4;
export const STAGE_B_MAX_COMPLETION_TOKENS = 768;
/** ADR-052 Amendment 2: raising the completion ceiling alone (Amendment 1)
 * did not fix the incident — isolated single calls against this project's
 * own failing postings showed `reasoning` alone running 70,000+ characters
 * and exhausting the ceiling before `content` was ever written, reproduced
 * with and without emoji, across providers. `reasoning.max_tokens` bounds
 * that separately, sized so roughly 60% of each stage's completion budget
 * stays reserved for the JSON answer itself: ~37% of the ceiling to
 * reasoning, matching between stages. Not zero (`effort: "none"`) —
 * reasoning plausibly helps classify blocking/mandatory/desirable
 * correctly on an ambiguous posting, and this incident has no evidence one
 * way or the other on that trade-off yet. */
export const STAGE_A_REASONING_MAX_TOKENS = 3_000;
export const STAGE_B_REASONING_MAX_TOKENS = 300;

export type BuildScorerResult =
  | {
      readonly ok: true;
      readonly scorer: ScorerPort;
      /**
       * Present only for the `api` adapter — `StubScorer` makes no network
       * call, so there is no usage to report. Exposed here rather than left
       * reachable only from `scripts/run-calibration.ts`'s own, separately
       * constructed client (docs/audit AC-015): production scoring runs
       * went through this exact function and had no way to answer "what did
       * tonight's run cost" at all before this existed.
       */
      readonly getUsage?: () => UsageTotals;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Reads `SCORER_ADAPTER` and builds the matching `ScorerPort` — the same
 * decision `deliverCommand` (`src/cli/main.ts`) made inline until M8, now
 * shared with the scheduler (`src/scheduling/infrastructure`) so both entry
 * points construct a scorer identically instead of two copies of this
 * switch quietly drifting apart. Returns a value rather than writing to
 * stderr/`process.exitCode` directly — the CLI and the unattended scheduler
 * report a misconfiguration differently (a console message vs. a Telegram
 * alert), so that choice stays with the caller.
 */
export function buildScorer(
  db: Db,
  criteria: Criteria,
  profile: Profile,
): BuildScorerResult {
  const adapter = process.env.SCORER_ADAPTER ?? "stub";

  if (adapter === "stub") {
    return { ok: true, scorer: new StubScorer(criteria) };
  }

  if (adapter === "api") {
    const apiKey = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL;
    if (!apiKey || !model) {
      return {
        ok: false,
        error:
          "SCORER_ADAPTER=api requires LLM_API_KEY and LLM_MODEL (ADR-012)",
      };
    }
    // Before the first posting, not during it: the templates are read from
    // disk at scoring time, and on 2026-08-16 they were not in the container
    // image at all. Checked here so a packaging mistake is reported as a
    // misconfiguration, next to the missing-API-key case, rather than
    // throwing out of `ApiScorer.score` mid-batch.
    const promptError = verifyPromptTemplates();
    if (promptError) {
      return { ok: false, error: promptError };
    }

    const client = new OpenRouterClient({
      apiKey,
      model,
      ...(process.env.LLM_BASE_URL
        ? { baseUrl: process.env.LLM_BASE_URL }
        : {}),
      // ADR-056: pinning the model (ADR-013) does not pin the provider
      // underneath it, and a broken one silently poisons a whole run.
      ignoredProviders: criteria.scoring.ignoredProviders,
    });
    const askStageA = (prompt: string) =>
      client.complete(prompt, {
        stage: "stage-a",
        timeoutMs: STAGE_A_TIMEOUT_MS,
        maxCompletionTokens: STAGE_A_MAX_COMPLETION_TOKENS,
        reasoningMaxTokens: STAGE_A_REASONING_MAX_TOKENS,
      });
    const askStageB = (prompt: string) =>
      client.complete(prompt, {
        stage: "stage-b",
        timeoutMs: STAGE_B_TIMEOUT_MS,
        maxCompletionTokens: STAGE_B_MAX_COMPLETION_TOKENS,
        reasoningMaxTokens: STAGE_B_REASONING_MAX_TOKENS,
      });
    return {
      ok: true,
      scorer: new ApiScorer(
        new StageAExtractor(
          askStageA,
          new ExtractionsRepository(db),
          STAGE_A_PROMPT_VERSION,
          model,
        ),
        new StageBMatcher(
          askStageB,
          new MatchesRepository(db),
          STAGE_B_PROMPT_VERSION,
          criteria.scoring.stageBConcurrency,
          model,
        ),
        profile,
        criteria,
        new PostingsRepository(db),
      ),
      getUsage: () => client.getUsage(),
    };
  }

  return {
    ok: false,
    error: `SCORER_ADAPTER=${adapter} is not implemented — "stub" and "api" are the only adapters (ADR-016)`,
  };
}

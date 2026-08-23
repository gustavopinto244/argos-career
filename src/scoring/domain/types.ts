import { z } from "zod";
import type { PeriodGate } from "./period-gate";

/** weight ∈ {blocking, mandatory, desirable} (docs/04-scoring-model.md) */
export type RequirementWeight = "blocking" | "mandatory" | "desirable";

export type MatchStatus = "met" | "partial" | "not_met";

export const MAX_REQUIREMENT_TEXT_CHARS = 500;
export const MAX_REQUIREMENT_CATEGORY_CHARS = 100;
export const MAX_MATCH_EVIDENCE_CHARS = 2_000;

export interface Requirement {
  readonly text: string;
  readonly category: string;
  readonly weight: RequirementWeight;
  /**
   * Whether a candidate could demonstrate this with anything beyond their own
   * assertion (ADR-015). A personal trait — "proatividade", "dinamismo",
   * "trabalho em equipe" — is `false`: no portfolio can evidence it, stage B
   * can only answer `not_met`, and counting that as a failure measures
   * whether a CV contains the word rather than whether the candidate fits.
   *
   * Optional so requirements cached under `a-v2`, which predates the field,
   * still parse. Absent means verifiable: the conservative reading, since
   * excluding a requirement removes it from scoring entirely.
   */
  readonly verifiable?: boolean;
}

/**
 * The domain shape `Requirement`/`Match` cache rows must satisfy to be
 * trusted (docs/audit PR-013) — `ExtractionsRepository`/`MatchesRepository`
 * parse every stored row through these before returning a hit, rather than
 * the previous `Array.isArray` check alone, which accepted `[{}]`, `[null]`,
 * an invalid `weight`/`status` enum, or any other structurally-valid-JSON,
 * domain-invalid content as if it were a real cached answer. Deliberately
 * loose where `Requirement`'s own field docs already are (`weight`/`status`
 * are still real enums, but nothing here is stricter than the type itself
 * requires) — this validates "is this a `Requirement`/`Match`", not "is
 * this a *good* one," which is a scoring-quality question, not a cache-
 * integrity one.
 */
export const RequirementSchema = z.object({
  text: z.string().min(1).max(MAX_REQUIREMENT_TEXT_CHARS),
  category: z.string().min(1).max(MAX_REQUIREMENT_CATEGORY_CHARS),
  weight: z.enum(["blocking", "mandatory", "desirable"]),
  verifiable: z.boolean().optional(),
});

export const MatchSchema = z
  .object({
    requirement: RequirementSchema,
    status: z.enum(["met", "partial", "not_met"]),
    evidence: z.string().min(1).max(MAX_MATCH_EVIDENCE_CHARS).nullable(),
  })
  .superRefine((match, context) => {
    if (match.evidence === null && match.status !== "not_met") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "evidence: null requires status: not_met",
      });
    }
  });

/** ADR-015: absent means verifiable, so legacy cached requirements keep
 * counting exactly as they did before the field existed. */
export function isVerifiable(requirement: Requirement): boolean {
  return requirement.verifiable !== false;
}

export interface Match {
  readonly requirement: Requirement;
  readonly status: MatchStatus;
  readonly evidence: string | null;
}

/**
 * `evidence: null` forces `not_met`, enforced once here rather than requested
 * of every caller — a `met` with no evidence is an invalid result regardless
 * of who produced it (ADR-005). Stage B (M7) is expected to construct every
 * `Match` through this factory.
 */
export function createMatch(
  requirement: Requirement,
  status: MatchStatus,
  evidence: string | null,
): Match {
  return {
    requirement,
    status: evidence === null ? "not_met" : status,
    evidence,
  };
}

/**
 * `data` (ADR-061, docs/11-known-issues.md B9's supply-side follow-up):
 * data-analyst/data-engineering-flavored postings, weighted below `dev`/
 * `security` on purpose — CLAUDE.md §1's search profile names back-end and
 * security as equal priority 1 and infrastructure/automation as priority
 * 2, with no data-analysis track at all. `trackWeights.data` sits at
 * `automation`'s 0.7, not `dev`'s 1.0, so a genuine data-analyst posting is
 * still visible in the digest without competing on equal footing with the
 * profile's actual first-priority targets.
 */
export type Track = "dev" | "security" | "automation" | "data" | "unknown";

export type Verdict = "apply" | "review" | "discard";

export interface ScoringWeights {
  readonly mandatory: number;
  readonly desirable: number;
  readonly trackAlignment: number;
}

export interface ScoringThresholds {
  readonly apply: number;
  readonly review: number;
}

export interface TrackWeights {
  readonly dev: number;
  readonly security: number;
  readonly automation: number;
  readonly data: number;
  readonly unknown: number;
}

export interface ScoringConfig {
  readonly weights: ScoringWeights;
  readonly thresholds: ScoringThresholds;
  readonly trackWeights: TrackWeights;
  /** Fewer extracted requirements than this triggers lowConfidence (docs/04). */
  readonly minExtractedRequirements: number;
  /** Score ceiling when a blocking requirement fails — 35 (docs/04). */
  readonly blockingCapScore: number;
  /** Score ceiling when the posting matches no configured track — ADR-025.
   * Distinct from `blockingCapScore`: this caps a *classification* outcome
   * (the posting is not the kind of role being searched for), not a
   * *requirement* failure, and the two stack via `Math.min` when both apply. */
  readonly unknownTrackCapScore: number;
}

export interface ScoreBreakdown {
  readonly mandatoryCoverage: number;
  readonly desirableCoverage: number;
  readonly trackAlignment: number;
}

/**
 * Why a posting has no real `ScoreOutcome`. The first three are why
 * `ScorerPort.score` returned `ok: false` — bounded retries already
 * exhausted by the time this is set (ADR-006). Lives here, not on
 * `ScorerPort` itself, so `ScoreOutcome` can reference it without a
 * circular import (`scorer.port.ts` already imports from this module).
 *
 * `max_retries_exceeded` (docs/audit PR-002) is different in kind: it is set
 * by `executeDeliver` *before* calling `scorer.score` at all, once
 * `PostingsRepository.getScoreFailureCount` shows this posting has already
 * failed on `maxScoreFailures` consecutive runs — the bounded stop that
 * keeps a permanently-broken posting (as opposed to a transient provider
 * outage) from spending a model call every single night forever.
 */
export type ScoreFailureReason =
  | "invalid_output"
  | "extraction_failed"
  | "matching_failed"
  | "max_retries_exceeded";

export interface ScoreOutcome {
  readonly score: number;
  readonly verdict: Verdict;
  readonly breakdown: ScoreBreakdown;
  readonly blockingFailure: Requirement | null;
  /**
   * Every unmet verifiable `blocking` requirement, not just the first
   * (`blockingFailure`, kept for existing consumers — first-in-match-order,
   * unchanged). `period-gate.ts` needs the full set: a posting blocked by a
   * not-yet-reached academic period *and* something else is a real
   * rejection independent of timing, and telling those apart requires
   * knowing whether the period gate was the only failure.
   */
  readonly blockingFailures: readonly Requirement[];
  readonly lowConfidence: boolean;
  readonly criticalGaps: readonly Requirement[];
  /**
   * Non-null when a not-yet-reached academic period is the *entire* reason
   * this posting is capped (`period-gate.ts`) — the candidate is not
   * currently eligible but will be on a known date. `executeDeliver` reads
   * this to route the posting into the digest's `periodBlocked` section
   * instead of `discard`/`review` (CLAUDE.md §9: "planning information, not
   * a rejection"). `null` covers both "no period gate" and "a period gate,
   * but not the only blocking failure" — both are ordinary rejections.
   */
  readonly periodGate: PeriodGate | null;
  /**
   * Set only on the synthetic `ScoreOutcome` `executeDeliver` builds for a
   * posting that failed scoring entirely (docs/audit AC-009) — `null` or
   * absent for every real `computeScore` result. ADR-006 requires a failed
   * posting to appear in the digest's review section "with the reason
   * attached" rather than silently vanish; this is that reason, read by
   * `render-digest.ts`.
   */
  readonly scoreFailureReason?: ScoreFailureReason | null;
}

/**
 * A placeholder `ScoreOutcome` for a posting `ScorerPort.score` could not
 * score at all (docs/audit AC-009) — every real coverage/alignment term is
 * 0 because none was actually computed, `lowConfidence: true` for the same
 * reason a too-vague posting gets it (nothing to judge on), and `verdict:
 * "review"` so it lands in the same digest section a real low-confidence
 * posting would, per ADR-006's requirement that a scoring failure surface
 * to the user rather than disappear.
 */
export function scoreFailureOutcome(reason: ScoreFailureReason): ScoreOutcome {
  return {
    score: 0,
    verdict: "review",
    breakdown: {
      mandatoryCoverage: 0,
      desirableCoverage: 0,
      trackAlignment: 0,
    },
    blockingFailure: null,
    blockingFailures: [],
    lowConfidence: true,
    criticalGaps: [],
    periodGate: null,
    scoreFailureReason: reason,
  };
}

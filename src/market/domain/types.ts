import { Match, Requirement, Verdict } from "../../scoring/domain/types";
import { Posting } from "../../posting/domain/posting";

/**
 * One posting's corpus record, assembled by `MarketRepository` from the
 * `postings`/`extractions`/`matches` tables. `requirements` is `[]` and
 * `matches`/`verdict` are `null` when Stage A/B never ran for this posting
 * (the common case today — the pre-filter passes very little of the real
 * corpus, docs/10-milestones.md's M9 close-out) rather than throwing: M10
 * aggregates over the whole corpus, including postings with no LLM data
 * at all.
 *
 * `blockingFailure`/`criticalGaps` (ADR-076) mirror the same-named fields
 * on `ScoreOutcome` — `MarketRepository.loadCorpus` already runs
 * `computeScore` to get `verdict` and used to discard the rest of the
 * result. Personal gap analysis (`personal-gap-scope.ts`) needs them to
 * tell "discarded because a mandatory/blocking requirement was unmet" from
 * "discarded for being off-track", which `verdict` alone cannot say. Both
 * are `null` on the same terms `verdict` is: no cached match data, nothing
 * to derive them from.
 *
 * `appliedAt` is likewise attached here rather than read off `posting` —
 * `Posting` (the domain type) has no such field; it is DB-only
 * (`postings.appliedAt`, ADR-072), reached through
 * `PostingsRepository.findAppliedAtMap`. `MarketRepository.loadCorpus`
 * reads that map once and carries the result alongside everything else it
 * already assembles per posting, so `personal-gap-scope.ts` needs no extra
 * context beyond the `CorpusEntry` itself.
 */
export interface CorpusEntry {
  readonly posting: Posting;
  readonly requirements: readonly Requirement[];
  readonly matches: readonly Match[] | null;
  readonly verdict: Verdict | null;
  readonly blockingFailure: Requirement | null;
  readonly criticalGaps: readonly Requirement[];
  readonly appliedAt: Date | null;
}

export interface SkillFrequency {
  readonly skill: string;
  readonly count: number;
  /** Of postings with at least one extraction — see `aggregate-corpus.ts`
   * for why this denominator, not the whole corpus. */
  readonly percentage: number;
}

export interface CountBucket {
  readonly label: string;
  readonly count: number;
}

export interface MarketAggregates {
  readonly corpusSize: number;
  readonly extractedCount: number;
  readonly skillFrequency: readonly SkillFrequency[];
  readonly companies: readonly CountBucket[];
  readonly regions: readonly CountBucket[];
  readonly workModes: readonly CountBucket[];
  readonly experienceLevels: readonly CountBucket[];
}

export interface GapAnalysisEntry {
  readonly skill: string;
  readonly count: number;
  /** Of whatever `entries` the caller passed to `gapAnalysis` — the
   * function no longer picks its own subset (ADR-076); each caller decides
   * what "in scope" means (market-wide high-compatibility postings,
   * personally applied ones, or ones discarded for a real competency gap)
   * before calling it. */
  readonly percentage: number;
}

export interface TimeSeriesPoint {
  /** ISO date (Monday) of the week this bucket covers. */
  readonly weekStart: string;
  readonly count: number;
}

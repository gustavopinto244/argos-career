import { aggregateCorpus } from "./aggregate-corpus";
import { gapAnalysis } from "./gap-analysis";
import { Taxonomy } from "./taxonomy";
import { timeSeries } from "./time-series";
import {
  CorpusEntry,
  GapAnalysisEntry,
  SkillFrequency,
  TimeSeriesPoint,
} from "./types";
import { Profile } from "../../profile/domain/profile";

export interface StudyPlan {
  readonly generatedAt: Date;
  readonly corpusSize: number;
  readonly extractedCount: number;
  readonly highCompatibilityCount: number;
  readonly gaps: readonly GapAnalysisEntry[];
  readonly marketDemand: readonly SkillFrequency[];
  readonly volumeByWeek: readonly TimeSeriesPoint[];
}

/**
 * Composes M10's three aggregation functions into one ranked plan — pure,
 * no I/O, same discipline as `aggregateCorpus`/`gapAnalysis`/`timeSeries`
 * themselves. `MarketRepository.loadCorpus` is the only caller expected to
 * assemble `entries`; this function never touches the database.
 *
 * High-compatibility (verdict `review`/`apply`) is this caller's own
 * definition of "in scope" for the gap analysis — `gapAnalysis` itself no
 * longer picks a subset (ADR-076); it runs over exactly the entries it is
 * given.
 */
export function composeStudyPlan(
  entries: readonly CorpusEntry[],
  profile: Profile,
  taxonomy: Taxonomy,
  now: Date,
): StudyPlan {
  const aggregates = aggregateCorpus(entries, taxonomy);
  const highCompatibility = entries.filter(
    (entry) => entry.verdict === "review" || entry.verdict === "apply",
  );
  const gaps = gapAnalysis(highCompatibility, profile, taxonomy);
  const highCompatibilityCount = highCompatibility.length;

  return {
    generatedAt: now,
    corpusSize: aggregates.corpusSize,
    extractedCount: aggregates.extractedCount,
    highCompatibilityCount,
    gaps,
    marketDemand: aggregates.skillFrequency,
    volumeByWeek: timeSeries(entries),
  };
}

import { CorpusEntry } from "./types";

/**
 * The two personal scopes ADR-076 defines "gap analysis" over, distinct
 * from M10's market-wide one (`composeStudyPlan`'s own high-compatibility
 * filter). Both are pure selections over an already-loaded
 * `CorpusEntry[]` — no new query, no new I/O; `MarketRepository.loadCorpus`
 * already carries everything either one needs.
 */
export type PersonalGapScope = "applied" | "discarded";

/**
 * Postings the operator actually applied to (`postings.appliedAt`,
 * ADR-072) — "based on the postings I tried, what are my gaps in them."
 */
function appliedEntries(
  entries: readonly CorpusEntry[],
): readonly CorpusEntry[] {
  return entries.filter((entry) => entry.appliedAt !== null);
}

/**
 * Postings discarded for a real, unmet competency requirement — `verdict
 * === "discard"` **and** `criticalGaps`/`blockingFailure` shows a
 * mandatory or blocking requirement actually went unmet.
 *
 * Deliberately narrower than "every discard". A `discard` can also mean
 * "every requirement was met but the posting is off-track" —
 * `unknownTrackCapScore` caps a fully-qualified match at a low score for
 * belonging to the wrong track, not for missing a skill. Counting that as
 * a competency gap would tell the operator to learn something they
 * already have. And a posting the pre-filter rejected before Stage A/B
 * ever ran (`verdict === null`) was never evaluated for competency at
 * all — the pre-filter speaks to search fit (location, title, expiry),
 * never to whether the profile has the right skills.
 */
function discardedForCompetencyEntries(
  entries: readonly CorpusEntry[],
): readonly CorpusEntry[] {
  return entries.filter(
    (entry) =>
      entry.verdict === "discard" &&
      (entry.criticalGaps.length > 0 || entry.blockingFailure !== null),
  );
}

export function selectPersonalGapScope(
  entries: readonly CorpusEntry[],
  scope: PersonalGapScope,
): readonly CorpusEntry[] {
  return scope === "applied"
    ? appliedEntries(entries)
    : discardedForCompetencyEntries(entries);
}

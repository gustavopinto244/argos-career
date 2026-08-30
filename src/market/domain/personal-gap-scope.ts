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
  // `verdict !== null` means Stage A/B actually ran and their answers are
  // still cache-valid. A posting applied to but never scored has no
  // requirements to read gaps from — including it would leave the skill
  // counts untouched while inflating the denominator every percentage is
  // computed against, quietly understating every real gap. Excluded here
  // and reported separately as `unanalyzedPostingCount`, so the omission is
  // visible rather than silent.
  return entries.filter(
    (entry) => entry.appliedAt !== null && entry.verdict !== null,
  );
}

/** Applied postings the gap analysis had nothing to say about — scoped in
 * by the operator's own "I applied here", scoped out by having no usable
 * Stage A/B result. Surfaced so a small denominator is explainable. */
export function unanalyzedAppliedEntries(
  entries: readonly CorpusEntry[],
): readonly CorpusEntry[] {
  return entries.filter(
    (entry) => entry.appliedAt !== null && entry.verdict === null,
  );
}

/**
 * Postings discarded for a real, unmet competency requirement — `verdict
 * === "discard"` **and** `criticalGaps`/`blockingFailure` shows a
 * mandatory or blocking requirement actually went unmet.
 *
 * Deliberately narrower than "every discard", on three counts:
 *
 * - `unknownTrackCapScore` caps a fully-qualified match at a low score for
 *   belonging to the wrong track, not for missing a skill. Counting that
 *   as a competency gap would tell the operator to learn something they
 *   already have.
 * - A posting the pre-filter rejected before Stage A/B ever ran
 *   (`verdict === null`) was never evaluated for competency at all — the
 *   pre-filter speaks to search fit (location, title, expiry), never to
 *   whether the profile has the right skills.
 * - A posting whose only blocking failure is a not-yet-reached academic
 *   period (`periodGate`, ADR-053) is not a competency gap either: the
 *   operator is not unqualified, only not eligible *yet*, and no amount of
 *   study changes that. This is the same line `computeCriticalGaps`
 *   already draws when it counts verifiable requirements only, because
 *   "be more proactive" is not something to go and learn — neither is
 *   "be in your fourth period".
 */
function discardedForCompetencyEntries(
  entries: readonly CorpusEntry[],
): readonly CorpusEntry[] {
  return entries.filter(
    (entry) =>
      entry.verdict === "discard" &&
      entry.periodGate === null &&
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

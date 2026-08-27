import { Posting } from "../../posting/domain/posting";
import { classifyTrack } from "./classify-track";
import { Criteria } from "./criteria";

/**
 * The order a run spends its scoring budget in (ADR-068).
 *
 * `claimForScoring` (`postings-repository.ts`) returns rows with no
 * `ORDER BY`, so before this the set reaching Stage A was in whatever order
 * SQLite happened to produce. That was harmless while everything got scored;
 * it stops being harmless the moment a run can end early — a provider
 * outage, a cancel, or the international cap — because *which* postings got
 * the budget becomes arbitrary.
 *
 * Two keys, in this order:
 *
 * 1. **Recency**, `publishedAt ?? firstSeenAt`, newest first. The same
 *    fallback `isTooOld` uses, for the same reason: it is the best available
 *    evidence of a posting still being open.
 * 2. **Track weight**, highest first. `dev`/`security` are the profile's
 *    equal first priorities at 1.0 and outrank `automation`/`data` at 0.7
 *    (CLAUDE.md §1, `docs/04`). A posting matching several tracks takes the
 *    highest, the same rule `computeTrackAlignment` already applies.
 *
 * Recency leads because an old posting scored perfectly is still a closed
 * one. Track weight breaks ties rather than leading, because a same-day
 * `automation` posting is worth more than a two-week-old `dev` one.
 *
 * Pure and total: no I/O, and equal keys keep their relative input order, so
 * the result is deterministic for a given input.
 */
export function rankForScoring(
  postings: readonly Posting[],
  criteria: Criteria,
): Posting[] {
  // ADR-066 established `lastSeenAt` as the authoritative "still open"
  // evidence, outranking the date estimates — and the postings it exists to
  // rescue are old by publication and fresh by sighting. Ranking on the
  // publication date alone sent exactly those to the bottom of the batch,
  // making them the first casualties of a cancel, a provider failure or the
  // international cap. The two rules disagreed about which signal means
  // "still open"; this makes them agree.
  //
  // The later of the two: a posting the source served up an hour ago is
  // live now, whatever its stated date, and one with a recent publication
  // date is unaffected because its own date already wins.
  const recencyOf = (posting: Posting): number =>
    Math.max(
      (posting.publishedAt ?? posting.firstSeenAt).getTime(),
      posting.lastSeenAt.getTime(),
    );

  const weightOf = (posting: Posting): number => {
    const tracks = classifyTrack(
      posting.title,
      criteria.tracks,
      criteria.trackExclusions,
    );
    if (tracks.length === 0) return criteria.trackWeights.unknown;
    return Math.max(...tracks.map((track) => criteria.trackWeights[track]));
  };

  // Decorate-sort-undecorate: `weightOf` re-classifies the title, which is
  // wasted work if a comparator calls it O(n log n) times.
  return postings
    .map((posting, index) => ({
      posting,
      index,
      recency: recencyOf(posting),
      weight: weightOf(posting),
    }))
    .sort(
      (a, b) =>
        b.recency - a.recency || b.weight - a.weight || a.index - b.index,
    )
    .map((entry) => entry.posting);
}

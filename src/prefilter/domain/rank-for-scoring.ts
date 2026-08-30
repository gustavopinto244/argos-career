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
 * Three keys, in this order:
 *
 * 1. **Still listed by its source**, as ADR-066 defines it — `lastSeenAt`
 *    within `stillListedWithinHours`. Direct evidence the posting is being
 *    advertised right now, which outranks any date-based estimate.
 * 2. **Publication recency**, `publishedAt ?? firstSeenAt`, newest first —
 *    the same fallback `isTooOld` uses.
 * 3. **Track weight**, highest first. `dev`/`security` are the profile's
 *    equal first priorities at 1.0 and outrank `automation`/`data` at 0.7
 *    (CLAUDE.md §1, `docs/04`). A posting matching several tracks takes the
 *    highest, the same rule `computeTrackAlignment` already applies.
 *
 * Still-listed leads because an old posting the source served up an hour ago
 * is open, whatever its stated date. Publication recency breaks that tie —
 * most of the corpus is "still listed" on any given run, so this is the key
 * that does the real ordering work. Track weight breaks the remaining ties,
 * because a same-day `automation` posting is worth more than a two-week-old
 * `dev` one.
 *
 * **Why not one combined key.** This was `Math.max(publishedAt ??
 * firstSeenAt, lastSeenAt)`, meant to let either signal win. Measured
 * against the real corpus, it was always `lastSeenAt`: **0 of 2,768** rows
 * had a publication date later than their last sighting, because every
 * sweep re-stamps `lastSeenAt`. Publication age therefore contributed
 * nothing, and since a sweep writes one timestamp for the whole batch
 * (2,091 rows shared a single value), the key was constant across most of
 * the corpus and ordering fell through to track weight and then arbitrary
 * SQLite order — the exact thing this function exists to stop.
 *
 * Comparing "still listed" as a *window* rather than as a raw timestamp is
 * also what keeps sources comparable: Indeed sweeps twice daily on its own
 * systemd timer while the rest run every 4h (ADR-009), so a raw `lastSeenAt`
 * comparison would systematically bury every Indeed posting behind fresher
 * sightings of the same age.
 *
 * Pure and total: no I/O, and equal keys keep their relative input order, so
 * the result is deterministic for a given input.
 */
export function rankForScoring(
  postings: readonly Posting[],
  criteria: Criteria,
  now: Date = new Date(),
): Posting[] {
  const stillListedWindowMs =
    criteria.stillListedWithinHours === null
      ? null
      : criteria.stillListedWithinHours * 60 * 60 * 1000;

  // 1 when the source was still listing this posting on its most recent
  // sweep, 0 otherwise. Same predicate and same one-directional use as
  // `isStillListedBySource` in `pre-filter.ts`: presence of a recent
  // sighting is evidence, absence of one is not evidence of closure — here
  // it only costs a posting priority, never its place in the batch.
  const stillListedOf = (posting: Posting): number => {
    if (stillListedWindowMs === null) return 0;
    const sinceMs = now.getTime() - posting.lastSeenAt.getTime();
    if (sinceMs < 0) return 0; // clock skew is not freshness
    return sinceMs <= stillListedWindowMs ? 1 : 0;
  };

  const recencyOf = (posting: Posting): number =>
    (posting.publishedAt ?? posting.firstSeenAt).getTime();

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
      stillListed: stillListedOf(posting),
      recency: recencyOf(posting),
      weight: weightOf(posting),
    }))
    .sort(
      (a, b) =>
        b.stillListed - a.stillListed ||
        b.recency - a.recency ||
        b.weight - a.weight ||
        a.index - b.index,
    )
    .map((entry) => entry.posting);
}

import { Posting } from "../../posting/domain/posting";
import { Criteria } from "./criteria";

/**
 * Whether a posting is hiring in the country the profile can actually be
 * hired in (ADR-068).
 *
 * Resolution order, and each step is a deliberate choice:
 *
 * 1. **The posting's own `country`**, when it states one. A fact from the
 *    source always outranks an assumption about the source.
 * 2. **`criteria.sourceDefaultCountry[source]`**, when it does not. Every
 *    source in production is a Brazilian platform that states no country;
 *    without this fallback the entire existing corpus would read as
 *    non-national and land in the capped bucket, which is the exact
 *    inversion of the priority this module exists to express. This is a
 *    property of the source, not a guess about the posting — the same
 *    standing `location.nationwideSources` already has.
 * 3. **Unknown → not national.** A posting nobody can place competes for the
 *    capped international budget rather than consuming the uncapped national
 *    one. That is the conservative direction: the cost of misfiling a
 *    national posting as international is that it waits a night, while the
 *    reverse would let an unbounded stream of unplaceable postings spend
 *    model calls without limit.
 *
 * Comparison is case-insensitive, and both sides go through the same
 * trimming, so a `homeCountry: "br"` in a hand-edited criteria file behaves
 * identically to `"BR"`.
 */
export function isNationalPosting(
  posting: Posting,
  criteria: Criteria,
): boolean {
  const home = criteria.homeCountry.trim().toUpperCase();
  if (!home) return true;

  const stated = posting.country?.trim().toUpperCase();
  if (stated) return stated === home;

  const fallback = criteria.sourceDefaultCountry[posting.source]
    ?.trim()
    .toUpperCase();
  if (fallback) return fallback === home;

  return false;
}

/**
 * Splits postings into the uncapped national bucket and the capped
 * international one, preserving the input order within each.
 *
 * Order is preserved rather than re-sorted here because the caller has
 * already ranked them (`rankForScoring`); this function's single job is the
 * partition, so that the ranking and the budget rule stay independently
 * testable.
 */
export function partitionByOrigin(
  postings: readonly Posting[],
  criteria: Criteria,
): { national: Posting[]; international: Posting[] } {
  const national: Posting[] = [];
  const international: Posting[] = [];
  for (const posting of postings) {
    if (isNationalPosting(posting, criteria)) national.push(posting);
    else international.push(posting);
  }
  return { national, international };
}

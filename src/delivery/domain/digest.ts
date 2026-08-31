import { RecurringGap } from "../../market/domain/recurring-gaps";
import { Posting } from "../../posting/domain/posting";
import { Recommendation } from "../../scoring/domain/recommendation";
import { ScoreOutcome } from "../../scoring/domain/types";

/**
 * A scored posting is what every digest section is built from. `apply` and
 * `review` sections both hold the same shape — what differs is the verdict
 * inside `outcome`, and the caller (composeDigest) is what buckets them.
 *
 * `outcome` is `ScoreOutcome & Recommendation`, not `ScoreOutcome` alone
 * (docs/audit AC-026): every `ScoredPosting` is built from a `ScoreResult`
 * with `ok: true`, which `ScorerPort` already types as exactly that
 * intersection — `ApiScorer.score` spreads both `computeScore`'s and
 * `computeRecommendation`'s results into one object. The narrower type here
 * used to hide `recommendedVariant`/`highlights`/`missingTerms` from
 * anything reading `entry.outcome`, even though the fields were present on
 * the actual value at runtime the whole time — `render-digest.ts` simply
 * had no type-safe way to reach them.
 *
 * `inputTruncated` is optional only for synthetic failure entries and older
 * test fixtures. Successful API scoring always supplies it and the renderer
 * makes the reduced-input fact visible to the operator.
 */
export interface ScoredPosting {
  readonly posting: Posting;
  readonly outcome: ScoreOutcome &
    Recommendation & { readonly inputTruncated?: boolean };
  /**
   * Which of this posting's own unmet requirements have already cost the
   * operator other postings (ADR-078). Computed by `executeDeliver` from
   * the personal `discarded` gap scope and attached here, so the renderer
   * stays pure and taxonomy-free.
   *
   * Optional, and absent rather than empty when the caller supplied no
   * taxonomy — the digest simply omits the line, which is what every
   * pre-ADR-078 caller and fixture gets.
   */
  readonly recurringGaps?: readonly RecurringGap[];
}

/**
 * A posting held back for not yet being reachable at your academic period.
 * `opensAtLabel` is a pre-formatted calendar term ("2027.1"), not the raw
 * period index.
 *
 * Populated since `period-gate.ts` (docs/11-known-issues.md, resolving
 * docs/audit AC-026's period-blocked half): `executeDeliver` routes a
 * posting here, instead of into `scored`, exactly when a not-yet-reached
 * academic period is the *only* unmet blocking requirement — a real
 * rejection with anything else wrong alongside the period gate stays an
 * ordinary `discard`/`review`. Heuristic, not exhaustive: only phrasings
 * `period-gate.ts`'s patterns recognize get routed here; an unrecognized
 * phrasing falls back to being scored (and possibly capped) exactly as
 * before this existed — a missed case, not a wrong one.
 */
export interface PeriodBlockedEntry {
  readonly posting: Posting;
  readonly opensAtLabel: string;
}

export interface RunSummary {
  readonly collected: number;
  readonly deduplicated: number;
  readonly filtered: number;
  readonly scored: number;
  readonly failedSources: readonly string[];
  /** Source(s) that hit their own result cap in the window since the last
   * delivery (docs/audit AC-013, PR-015) — visible so a "success" outcome
   * that still left something uncollected is not indistinguishable from a
   * clean run. Was already persisted per collect run (`runs.truncatedSources`)
   * but never read back into anything an operator sees, internal or
   * external source alike. */
  readonly truncatedSources: readonly string[];
}

/**
 * The real digest shape (docs/02-architecture.md), replacing the M1
 * placeholder. Sections mirror the four listed there: recommended, review,
 * period-blocked, and a run summary that keeps principle 1 honest — a failed
 * source is visible in the digest, not silently absent.
 */
export interface Digest {
  readonly runId: string;
  readonly generatedAt: Date;
  readonly recommended: readonly ScoredPosting[];
  readonly review: readonly ScoredPosting[];
  readonly periodBlocked: readonly PeriodBlockedEntry[];
  /**
   * Scored `apply`/`review` postings the source published no link for
   * (ADR-077). Kept out of `recommended`/`review` because those sections
   * promise something this entry cannot deliver: a way to act on it.
   *
   * In practice this is CIEE, and it is not a normalization bug — the
   * public endpoint genuinely publishes no per-posting URL, the per-vacancy
   * API answers 401, and the portal 404s on the vacancy code. What CIEE
   * does give is `codigoVaga`, carried through as `sourceId`, which is the
   * one identifier that makes the posting findable by hand on their portal.
   * Measured 2026-08-30: 3.493 of 3.493 CIEE postings have no link, and
   * CIEE nevertheless produced 8 of the 13 `apply` verdicts the system has
   * ever issued — so dropping them would throw away the best matches, and
   * leaving them mixed in was quietly wasting the under-10-minutes budget
   * on entries the operator could not open.
   */
  readonly unreachable: readonly ScoredPosting[];
  readonly summary: RunSummary;
}

export interface ComposeDigestInput {
  readonly runId: string;
  readonly generatedAt: Date;
  readonly scored: readonly ScoredPosting[];
  readonly periodBlocked: readonly PeriodBlockedEntry[];
  readonly summary: RunSummary;
}

/**
 * Highest score first within each section, so the digest reads
 * best-match-first instead of in whatever order `executeDeliver` happened
 * to process postings in (claim order, not a compatibility signal). Ties
 * keep their relative input order — `Array.prototype.sort` is
 * stable — rather than an arbitrary secondary key, since nothing about
 * this project's scoring model claims a meaningful ordering between two
 * postings that landed on the exact same score.
 */
function byScoreDescending(a: ScoredPosting, b: ScoredPosting): number {
  return b.outcome.score - a.outcome.score;
}

/**
 * Buckets scored postings into `recommended` (`apply`) and `review`
 * (`review`) by their verdict. `discard` postings are dropped here — they are
 * still in the corpus (never deleted, ADR-007), just not in the digest.
 */
export function composeDigest(input: ComposeDigestInput): Digest {
  const recommended: ScoredPosting[] = [];
  const review: ScoredPosting[] = [];
  const unreachable: ScoredPosting[] = [];

  for (const entry of input.scored) {
    const wanted =
      entry.outcome.verdict === "apply" || entry.outcome.verdict === "review";
    if (!wanted) continue;
    // Routed on the link, not on the source: "no way to act on this" is a
    // property of the entry, and a second linkless source later gets the
    // same honest treatment without another branch here.
    if (!entry.posting.sourceUrl) unreachable.push(entry);
    else if (entry.outcome.verdict === "apply") recommended.push(entry);
    else review.push(entry);
  }
  recommended.sort(byScoreDescending);
  review.sort(byScoreDescending);
  unreachable.sort(byScoreDescending);

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    recommended,
    review,
    periodBlocked: input.periodBlocked,
    unreachable,
    summary: input.summary,
  };
}

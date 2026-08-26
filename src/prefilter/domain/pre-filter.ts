import { normalize } from "../../posting/domain/fingerprint";
import { Posting } from "../../posting/domain/posting";
import { Track } from "../../scoring/domain/types";
import { classifyTrack } from "./classify-track";
import { Criteria } from "./criteria";
import { titleMatchesAny } from "./title-match";

export type PreFilterRejectionReason =
  | "title_blocked"
  | "title_missing_required_term"
  | "track_unknown"
  | "company_blocked"
  | "expired"
  | "too_old"
  | "location_not_allowed"
  | "insufficient_keyword_adherence";

/**
 * `tracks` is always populated, pass or fail — classification is cheap,
 * independent metadata worth keeping even on a rejected posting (useful for
 * M10's market analysis, which reads the whole corpus, not the shortlist).
 */
export interface PreFilterOutcome {
  readonly passed: boolean;
  readonly reason: PreFilterRejectionReason | null;
  readonly tracks: readonly Track[];
  /** Source-data anomalies that affected this decision but are not, by
   * themselves, rejection reasons. Kept separate from `reason` so the
   * conservative firstSeenAt fallback remains observable even when the
   * posting otherwise passes every rule. */
  readonly anomalies: readonly PreFilterAnomaly[];
}

export type PreFilterAnomaly = "published_at_future";

function isCompanyBlocked(posting: Posting, criteria: Criteria): boolean {
  const normalizedCompany = normalize(posting.company);
  return criteria.blockedCompanies.some(
    (company) => normalize(company) === normalizedCompany,
  );
}

/** `null` (no stated deadline) is unknown, not expired — absence is not
 * evidence a posting has closed. */
function isExpired(posting: Posting, now: Date): boolean {
  if (posting.applicationDeadline === null) return false;
  return posting.applicationDeadline.getTime() < now.getTime();
}

/**
 * Whether the source was **still listing this posting** on its most recent
 * sweep (ADR-066).
 *
 * `maxAgeDays` asks "how long ago was this published", which is a proxy for
 * the question that actually matters: is it still open. `lastSeenAt` answers
 * that question directly — a posting the source returned an hour ago is
 * being advertised right now, whatever its publication date says — and the
 * collector has always recorded it (ADR-007's upsert moves it on every
 * sighting). The pre-filter simply never read it.
 *
 * Measured on the real corpus, 2026-08-26: of 26 on-track, never-notified
 * postings in the Rio metro that `maxAgeDays: 7` rejected, **8 were still
 * being listed by their source** — including "Estágio em TI" (BHG, Rio) at
 * 21 days published and seen 7 h earlier, and two CIEE "Estágio em
 * Informática" seen 54 minutes earlier. The other 18 had genuinely vanished
 * from their source, which is exactly what the age rule should catch.
 *
 * **The signal is deliberately used in one direction only.** "Still listed"
 * rescues a posting from the age rule; "no longer listed" is never used to
 * reject one, because it is not reliable evidence of closure — a source that
 * paginates can drop a still-open posting out of the collected window
 * (`truncatedSources: ["gupy"]` is recorded on most real runs). Rescue is
 * safe under that asymmetry; rejection would not be.
 *
 * Checked before `undatedBacklogCutoverAt` on purpose. The cutover exists to
 * retire an undated backlog nobody can date, and a posting the source served
 * up today is not backlog — the CIEE rows above were first seen 8 hours
 * before the cutover instant and are still being advertised ten days later.
 *
 * `null` disables this and restores the previous behaviour exactly.
 */
function isStillListedBySource(
  posting: Posting,
  stillListedWithinHours: number | null,
  now: Date,
): boolean {
  if (stillListedWithinHours === null) return false;
  const sinceLastSeenMs = now.getTime() - posting.lastSeenAt.getTime();
  // A future `lastSeenAt` is clock skew, not freshness — treat it as not
  // evidence rather than letting a bad timestamp rescue anything.
  if (sinceLastSeenMs < 0) return false;
  return sinceLastSeenMs <= stillListedWithinHours * 60 * 60 * 1000;
}

/**
 * Age, measured from `publishedAt` when the source states one and
 * `firstSeenAt` when it does not.
 *
 * The fallback is the whole point, and it is a deliberate departure from
 * ADR-011's leniency rule ("an unknown axis passes") — see Amendment 4.
 * Under that rule this
 * check would be inert exactly where it is most needed: 100% of CIEE's 2,079
 * active postings and 78% of Gupy's 558 carry no `publishedAt` at all
 * (measured 2026-08-16), so an age rule reading only that field would go on
 * paying to score an unbounded, permanently undated corpus.
 *
 * `firstSeenAt` is a weaker claim than `publishedAt` — it is when *this
 * system* first saw the posting, not when the company published it — and it
 * systematically *under*-estimates age, since a posting collected today may
 * have been open for months. That asymmetry is why the fallback is safe to
 * use here: it errs toward scoring a posting that should have been skipped,
 * never toward skipping a fresh one.
 *
 * The consequence worth knowing: a bulk import gives thousands of postings
 * the same `firstSeenAt`, so this rule does nothing for them until the window
 * passes and then drops them all at once. It is a bound on growth, not a
 * retroactive cleanup — `undatedBacklogCutoverAt` below is what makes it one.
 *
 * `undatedBacklogCutoverAt` (ADR-011 Amendment 5) is checked first and, when
 * it fires, short-circuits the `maxAgeDays` math entirely: an undated
 * posting first seen at or before the cutover is presumed already past the
 * limit, full stop, rather than having its real gap computed. That is a
 * deliberate business decision, not a measurement — see the schema comment
 * on `Criteria.undatedBacklogCutoverAt` for why `firstSeenAt` itself is never
 * rewritten to express it.
 *
 * A `publishedAt` more than `maxFutureSkewDays` ahead of `now` is treated the
 * same as no `publishedAt` at all (docs/audit AC-029): a source-reported date
 * that far in the future is not evidence of a fresh posting, it is evidence
 * of a bad date — a misparsed format, clock skew, or an outright wrong value
 * — and trusting it would let `ageMs` go negative and pass the recency check
 * unconditionally, regardless of how old the posting actually is.
 */
function isTooOld(
  posting: Posting,
  maxAgeDays: number | null,
  undatedBacklogCutoverAt: Date | null,
  maxFutureSkewDays: number,
  now: Date,
  stillListedWithinHours: number | null = null,
): boolean {
  if (maxAgeDays === null) return false;
  // ADR-066: direct evidence the posting is still open outranks every
  // date-based estimate below it, including the cutover.
  if (isStillListedBySource(posting, stillListedWithinHours, now)) return false;
  if (
    posting.publishedAt === null &&
    undatedBacklogCutoverAt !== null &&
    posting.firstSeenAt.getTime() <= undatedBacklogCutoverAt.getTime()
  ) {
    return true;
  }
  const reference = hasImplausiblyFuturePublishedAt(
    posting,
    maxFutureSkewDays,
    now,
  )
    ? posting.firstSeenAt
    : (posting.publishedAt ?? posting.firstSeenAt);
  const ageMs = now.getTime() - reference.getTime();
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function hasImplausiblyFuturePublishedAt(
  posting: Posting,
  maxFutureSkewDays: number,
  now: Date,
): boolean {
  const futureSkewMs = maxFutureSkewDays * 24 * 60 * 60 * 1000;
  return (
    posting.publishedAt !== null &&
    posting.publishedAt.getTime() - now.getTime() > futureSkewMs
  );
}

/**
 * Rio de Janeiro metro, or remote (CLAUDE.md §6).
 *
 * Leniency is **asymmetric**, and ADR-011 Amendment 3 explains why the
 * original symmetric version had to change. An unknown *location* still
 * passes for most sources: the posting cannot be ruled out as being in the
 * target region — `criteria.location.nationwideSources` is the deliberate
 * exception (docs/audit AC-024). An unknown *work mode* no longer rescues a
 * posting whose city is known and outside it — absence of evidence about
 * how the work happens does not outweigh positive evidence about where it
 * happens.
 *
 * The original rule was written when Gupy was the only source and usually
 * stated `workMode`. CIEE never states it, so under the symmetric rule
 * every São Paulo, Brasília and Fortaleza posting passed on the theory that
 * it "cannot be ruled out as remote" — 1,700 of them, measured.
 */
function isLocationAllowed(posting: Posting, criteria: Criteria): boolean {
  if (posting.workMode === "remote") return criteria.location.allowRemote;
  if (posting.location.kind === "unknown") {
    // An unknown location is still unknown, from most sources — but not
    // from one that crawls nationwide with no server-side location filter
    // at all (docs/audit AC-024): there, "unknown" means the city-parsing
    // regex failed to match, not that the posting is plausibly in-region.
    // Rejecting it here, deterministically and before the LLM, is strictly
    // cheaper and safer than the alternative of silently scoring whatever
    // fraction of a national crawl the parser could not read.
    return !criteria.location.nationwideSources.includes(posting.source);
  }

  const normalizedCity = normalize(posting.location.city);
  return criteria.location.cities.some(
    (city) => normalize(city) === normalizedCity,
  );
}

/**
 * Deliberately still substring-matched against the *fingerprint* normalizer,
 * unlike the title blocklist/required rules above. Profile keywords carry
 * the same punctuation variants the track keywords do — "Node.js",
 * "back-end", "CI/CD" — and whole-word matching would need every spelling
 * listed. None of them is a short token that collides with an ordinary
 * Portuguese word, which is the specific failure that forced the title
 * rules to change, so the tradeoff lands the other way here.
 */
function hasMinKeywordAdherence(
  normalizedTitle: string,
  profileKeywords: readonly string[],
  floor: number,
): boolean {
  if (floor <= 0) return true;
  const matched = profileKeywords.filter((keyword) =>
    normalizedTitle.includes(normalize(keyword)),
  ).length;
  return matched >= floor;
}

/**
 * Deterministic rules, run before any LLM call (docs/02-architecture.md).
 * Short-circuits at the first failing rule — every rejection records exactly
 * one reason. Rule order runs cheapest and most decisive first: three
 * title-only string checks (blocklist, required term, track — `tracks` is
 * already computed above for every posting, so gating on it here costs
 * nothing extra), then three single-field checks (company, deadline, age),
 * then location (which reads two fields), then keyword adherence (which
 * scans the whole profile keyword list) last, since it is the most expensive
 * check and the least likely to matter once everything before it has
 * already run.
 */
export function applyPreFilter(
  posting: Posting,
  criteria: Criteria,
  profileKeywords: readonly string[],
  now: Date,
): PreFilterOutcome {
  const normalizedTitle = normalize(posting.title);
  const tracks = classifyTrack(
    posting.title,
    criteria.tracks,
    criteria.trackExclusions,
  );
  const anomalies: readonly PreFilterAnomaly[] =
    hasImplausiblyFuturePublishedAt(posting, criteria.maxFutureSkewDays, now)
      ? ["published_at_future"]
      : [];
  const outcome = (
    passed: boolean,
    reason: PreFilterRejectionReason | null,
  ): PreFilterOutcome => ({ passed, reason, tracks, anomalies });

  // Whole-word matching (`title-match.ts`), not substring: the blocklist's
  // "IV" was matching inside "nível", "universitário" and "afirmativa",
  // silently killing real internships.
  if (titleMatchesAny(posting.title, criteria.titleBlocklist)) {
    return outcome(false, "title_blocked");
  }
  if (!titleMatchesAny(posting.title, criteria.titleRequired)) {
    return outcome(false, "title_missing_required_term");
  }
  // ADR-051: an unknown track is not, by itself, evidence a posting is
  // off-topic (docs/04's `unknownTrackCapScore` already treats it as
  // "a classifier gap, not necessarily a bad posting") — but measured
  // against a real run, every unknown-track posting that reached the LLM
  // was actually off-area (RH, Jurídico, Marketing, ...), so this is opt-in
  // via `rejectUnknownTrack`, not baked into `tracks.length === 0` itself.
  if (criteria.rejectUnknownTrack && tracks.length === 0) {
    return outcome(false, "track_unknown");
  }
  if (isCompanyBlocked(posting, criteria)) {
    return outcome(false, "company_blocked");
  }
  if (isExpired(posting, now)) {
    return outcome(false, "expired");
  }
  // After `expired`, before `location`: both are single-field date checks and
  // a closed posting is the more decisive rejection of the two.
  if (
    isTooOld(
      posting,
      criteria.maxAgeDays,
      criteria.undatedBacklogCutoverAt,
      criteria.maxFutureSkewDays,
      now,
      criteria.stillListedWithinHours,
    )
  ) {
    return outcome(false, "too_old");
  }
  if (!isLocationAllowed(posting, criteria)) {
    return outcome(false, "location_not_allowed");
  }
  if (
    !hasMinKeywordAdherence(
      normalizedTitle,
      profileKeywords,
      criteria.minKeywordAdherence,
    )
  ) {
    return outcome(false, "insufficient_keyword_adherence");
  }

  return outcome(true, null);
}

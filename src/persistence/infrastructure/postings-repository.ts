import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  Location,
  Posting,
  Seniority,
  WorkMode,
} from "../../posting/domain/posting";
import { Db } from "./db";
import { postings } from "./schema";

type PostingRow = typeof postings.$inferSelect;

/**
 * How long a scoring claim (docs/audit PR-004) is honored before it is
 * treated as abandoned and reclaimable. Not tuned against a measured
 * incident — chosen as comfortably longer than a real nightly
 * `scoreAndDeliver` run should ever take (ADR-009's single nightly window),
 * so a hard process crash mid-run (a `kill -9`, not a caught exception —
 * `executeDeliver`'s own try/catch already releases claims on every path it
 * can observe) does not strand postings unclaimable forever.
 */
export const DEFAULT_STALE_CLAIM_MS = 4 * 60 * 60 * 1000;

export interface UpsertResult {
  readonly posting: Posting;
  /** True on first sighting of this fingerprint, false on a re-sighting. */
  readonly wasNew: boolean;
}

/** `rawPayload` is `unknown` by contract (`posting.ts`) — an opaque debug/
 * audit snapshot, never read by any pipeline logic (only ever written by
 * `upsert` with `JSON.stringify`'s own output). A restore or manual edit
 * that truncates or corrupts it (docs/audit AC-031) must not take down
 * *every* read of the row it belongs to — `findActive`/`findUnnotified`/
 * dedup all hydrate through this same path — so a parse failure degrades to
 * a marker value instead of throwing. */
function parseRawPayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { corrupted: true };
  }
}

function rowToPosting(row: PostingRow): Posting {
  const location: Location =
    row.locationKind === "known" && row.locationCity !== null
      ? { kind: "known", city: row.locationCity }
      : { kind: "unknown" };

  return {
    source: row.source,
    sourceId: row.sourceId,
    fingerprint: row.fingerprint,
    company: row.company,
    title: row.title,
    location,
    workMode: row.workMode as WorkMode,
    seniority: row.seniority as Posting["seniority"],
    experienceYears: row.experienceYears,
    applicationDeadline: row.applicationDeadline,
    publishedAt: row.publishedAt,
    sourceUrl: row.sourceUrl,
    description: row.description,
    country: row.country,
    // The stored row has no separate "collectedAt" column — lastSeenAt *is*
    // the most recent observation, which is what collectedAt means for a
    // hydrated (already-persisted) Posting.
    collectedAt: row.lastSeenAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    rawPayload: parseRawPayload(row.rawPayload),
  };
}

/**
 * Persists postings keyed by fingerprint (ADR-007). The one invariant that
 * matters most: `firstSeenAt` is written on insert and never touched again —
 * a naive upsert overwriting it would make every posting look like it was
 * found today after the next re-collection (ADR-007 amendment).
 *
 * Implemented as an explicit select-then-branch inside a transaction rather
 * than `ON CONFLICT DO UPDATE`, so which columns update on a re-sighting
 * (everything except `firstSeenAt`) stays readable instead of implicit in a
 * SQL `SET` clause.
 *
 * Safe under concurrent writers, including a second OS process (docs/audit
 * AC-020 re-examined this and confirmed it, rather than assuming it): the
 * select and the branch it drives are inside one `db.transaction()`, and
 * SQLite serializes write transactions at the database-file level — a
 * second connection's write transaction blocks until the first commits (up
 * to `better-sqlite3`'s 5s default `busy_timeout`), it never interleaves
 * with it. What this does **not** cover on its own is a race spanning
 * *multiple* transactions — `executeDeliver`'s score → notify →
 * `markNotified` sequence is not one atomic unit, so two full delivery runs
 * overlapping across processes could, in principle, both act on the same
 * posting before either marks it notified. `RunLock` (`run-lock.ts`) closes
 * that within one process; `claimForScoring`/`releaseUnresolvedClaims`
 * (docs/audit PR-004, ADR-040) close the specific gap `RunLock` itself
 * documents as out of its reach — a second, separately-invoked process —
 * by making the *selection* of which postings are even eligible for
 * scoring one atomic transaction (alongside the dedup pass that precedes
 * it), rather than a plain read two processes could both perform before
 * either writes anything back.
 */
export class PostingsRepository {
  constructor(private readonly db: Db) {}

  upsert(posting: Posting): UpsertResult {
    return this.db.transaction((tx) => this.upsertIn(tx, posting));
  }

  /** One transaction for a collector page/batch. This preserves each
   * posting's exact upsert semantics while avoiding one fsync/savepoint
   * lifecycle per item. */
  upsertMany(values: readonly Posting[]): readonly UpsertResult[] {
    if (values.length === 0) return [];
    return this.db.transaction((tx) =>
      values.map((posting) => this.upsertIn(tx, posting)),
    );
  }

  private upsertIn(db: Db, posting: Posting): UpsertResult {
    const existing = db
      .select()
      .from(postings)
      .where(eq(postings.fingerprint, posting.fingerprint))
      .get();

    const locationCity =
      posting.location.kind === "known" ? posting.location.city : null;

    if (existing) {
      db.update(postings)
        .set({
          source: posting.source,
          sourceId: posting.sourceId,
          company: posting.company,
          title: posting.title,
          locationKind: posting.location.kind,
          locationCity,
          workMode: posting.workMode,
          seniority: posting.seniority,
          experienceYears: posting.experienceYears,
          applicationDeadline: posting.applicationDeadline,
          publishedAt: posting.publishedAt,
          sourceUrl: posting.sourceUrl,
          description: posting.description,
          country: posting.country,
          lastSeenAt: posting.lastSeenAt,
          rawPayload: JSON.stringify(posting.rawPayload),
          // firstSeenAt is deliberately absent from this SET clause.
        })
        .where(eq(postings.fingerprint, posting.fingerprint))
        .run();
    } else {
      db.insert(postings)
        .values({
          source: posting.source,
          sourceId: posting.sourceId,
          fingerprint: posting.fingerprint,
          company: posting.company,
          title: posting.title,
          locationKind: posting.location.kind,
          locationCity,
          workMode: posting.workMode,
          seniority: posting.seniority,
          experienceYears: posting.experienceYears,
          applicationDeadline: posting.applicationDeadline,
          publishedAt: posting.publishedAt,
          sourceUrl: posting.sourceUrl,
          description: posting.description,
          country: posting.country,
          firstSeenAt: posting.firstSeenAt,
          lastSeenAt: posting.lastSeenAt,
          rawPayload: JSON.stringify(posting.rawPayload),
        })
        .run();
    }

    const stored = db
      .select()
      .from(postings)
      .where(eq(postings.fingerprint, posting.fingerprint))
      .get();
    if (!stored) {
      throw new Error(
        `Postings upsert did not persist fingerprint ${posting.fingerprint}`,
      );
    }

    return { posting: rowToPosting(stored), wasNew: !existing };
  }

  /**
   * Newest `lastSeenAt` per source, over active postings — the input to the
   * per-source freshness alert (docs/11-known-issues.md B13).
   *
   * Reads the corpus rather than `runs` deliberately: a push-based external
   * collector (ADR-027) never appears in a run's `attempted_sources`, so the
   * run log cannot distinguish "delivered nothing" from "was never asked".
   * A posting's `lastSeenAt` is true regardless of how it arrived.
   *
   * Discarded postings are excluded for the same reason every other read
   * here excludes them — a manually discarded posting is not evidence the
   * source is alive today.
   */
  findLastSeenAtBySource(): Record<string, Date> {
    const rows = this.db
      .select({
        source: postings.source,
        latest: sql<number>`MAX(${postings.lastSeenAt})`,
      })
      .from(postings)
      .where(isNull(postings.discardedAt))
      .groupBy(postings.source)
      .all();

    const result: Record<string, Date> = {};
    for (const row of rows) {
      if (row.latest === null) continue;
      result[row.source] = new Date(row.latest);
    }
    return result;
  }

  findByFingerprint(fingerprint: string): Posting | null {
    const row = this.db
      .select()
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return row ? rowToPosting(row) : null;
  }

  findByCompany(company: string): Posting[] {
    const rows = this.db
      .select()
      .from(postings)
      .where(eq(postings.company, company))
      .all();
    return rows.map(rowToPosting);
  }

  /**
   * Clears every similarity-duplicate flag, so a corrected dedup pass can
   * re-decide from scratch.
   *
   * Non-destructive by construction: `markDuplicate` only ever sets a
   * column, so nothing was deleted when a posting was flagged, and clearing
   * the flag restores it whole. That is what makes fixing a dedup bug a
   * re-run rather than a re-collection — the corpus is not a cache
   * (`05-domain-model.md`), and this is the payoff for it.
   */
  clearDuplicateFlags(): number {
    const affected = this.db
      .select()
      .from(postings)
      .where(isNotNull(postings.duplicateOfFingerprint))
      .all().length;
    this.db
      .update(postings)
      .set({ duplicateOfFingerprint: null })
      .where(isNotNull(postings.duplicateOfFingerprint))
      .run();
    return affected;
  }

  /**
   * Clears one specific posting's duplicate flag — the scoped counterpart
   * to `clearDuplicateFlags`' blunt "reset everything" (docs/audit PR-006).
   * Exists for a wrongly-merged posting from before shadow mode: layer 2
   * only *logs* candidates now (`dedupSimilarPostings`), but a posting
   * `markDuplicate`d by an earlier run, before this project stopped trusting
   * the similarity threshold unsupervised, is still flagged and still
   * excluded from `findUnnotified`/`claimForScoring` until someone restores
   * it specifically — `--reset` would be the wrong tool, since it also
   * un-flags every *correct* merge in the same sweep.
   *
   * Returns `false` when the fingerprint does not exist or was not flagged,
   * so a caller (the CLI) can report "nothing to restore" instead of
   * silently succeeding on a typo — same contract as `discard`.
   */
  restoreDuplicate(fingerprint: string): boolean {
    const result = this.db
      .update(postings)
      .set({ duplicateOfFingerprint: null })
      .where(
        and(
          eq(postings.fingerprint, fingerprint),
          isNotNull(postings.duplicateOfFingerprint),
        ),
      )
      .run();
    return result.changes > 0;
  }

  markDuplicate(fingerprint: string, duplicateOfFingerprint: string): void {
    this.db
      .update(postings)
      .set({ duplicateOfFingerprint })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  count(): number {
    return this.db.select().from(postings).all().length;
  }

  /**
   * Postings not already flagged as a known duplicate — the candidate pool
   * for the similarity dedup layer (ADR-0010). A posting already marked
   * duplicate is excluded rather than compared again; only canonical
   * postings are compared against each other.
   */
  findActive(): Posting[] {
    const rows = this.db
      .select()
      .from(postings)
      .where(isNull(postings.duplicateOfFingerprint))
      .all();
    return rows.map(rowToPosting);
  }

  /**
   * Active postings not yet notified. `notifiedAt` is set once and never
   * cleared (ADR-007's "write once" discipline, applied to delivery): a
   * posting already notified is never notified again, so it drops out of
   * this pool permanently once sent.
   *
   * No longer `executeDeliver`'s own candidate-selection query (docs/audit
   * PR-004, ADR-040) — `claimForScoring` is, since it also needs to exclude
   * whatever another run has already claimed and to do so atomically with
   * the dedup pass that precedes it, neither of which this plain read does.
   * Kept as a general-purpose "what's still outstanding" query — a superset
   * of what is currently claimable, since it does not look at claim state
   * at all.
   */
  findUnnotified(): Posting[] {
    const rows = this.db
      .select()
      .from(postings)
      .where(
        and(
          isNull(postings.duplicateOfFingerprint),
          isNull(postings.notifiedAt),
          // A human's "no" is permanent (see `discard` below) — the digest
          // candidate pool excludes it the same way it excludes a posting
          // already sent, not because scoring said no but because a person
          // already did.
          isNull(postings.discardedAt),
        ),
      )
      .all();
    return rows.map(rowToPosting);
  }

  markNotified(fingerprint: string, notifiedAt: Date): void {
    this.db
      .update(postings)
      .set({ notifiedAt })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  markNotifiedMany(fingerprints: readonly string[], notifiedAt: Date): void {
    if (fingerprints.length === 0) return;
    this.db
      .update(postings)
      .set({ notifiedAt })
      .where(inArray(postings.fingerprint, fingerprints))
      .run();
  }

  /**
   * Atomically claims every eligible posting for `runId` — the persisted
   * admission barrier docs/audit PR-004 asks for. Eligible means the same
   * predicate `findUnnotified` used (active, not notified, not discarded)
   * plus not already claimed by a still-live run (`scoringClaimedAt` null,
   * or older than `staleClaimMs` and therefore treated as abandoned).
   *
   * Callers MUST invoke this from inside a single `db.transaction()` that
   * also contains the dedup pass immediately preceding it (see
   * `executeDedupAndClaim` in `cli/main.ts`) — that is what makes this a
   * barrier and not just a snapshot: `better-sqlite3` serializes write
   * transactions at the database-file level, so a second process's own
   * `upsert`/claim transaction is fully before or fully after this one,
   * never interleaved partway through it. Called on its own, outside a
   * transaction with dedup, this method is still atomic (select-then-update
   * in one call) but no longer closes the specific gap PR-004 names — a
   * posting dedup would have flagged could still slip in as its own,
   * separate claim between dedup's commit and this one's.
   */
  claimForScoring(
    runId: string,
    claimedAt: Date,
    staleClaimMs: number = DEFAULT_STALE_CLAIM_MS,
  ): Posting[] {
    const staleBefore = new Date(claimedAt.getTime() - staleClaimMs);
    const rows = this.db
      .select()
      .from(postings)
      .where(
        and(
          isNull(postings.duplicateOfFingerprint),
          isNull(postings.notifiedAt),
          isNull(postings.discardedAt),
          or(
            isNull(postings.scoringClaimedAt),
            lt(postings.scoringClaimedAt, staleBefore),
          ),
        ),
      )
      .all();

    if (rows.length > 0) {
      this.db
        .update(postings)
        .set({ scoringClaimedAt: claimedAt, scoringClaimRunId: runId })
        .where(
          inArray(
            postings.fingerprint,
            rows.map((row) => row.fingerprint),
          ),
        )
        .run();
    }
    return rows.map(rowToPosting);
  }

  /**
   * Releases every claim `runId` still holds on a posting that was not, in
   * the end, notified (docs/audit PR-004) — a prefilter reject, a discard
   * verdict, a recoverable scoring failure (ADR-038), or a posting never
   * reached because a permanent transport failure stopped the batch early
   * (ADR-039). Leaving these claimed would silently defeat ADR-038's
   * bounded retry: `claimForScoring` would never see them as eligible again
   * until `staleClaimMs` elapsed, regardless of how many runs passed.
   * Idempotent and safe to call even when nothing needs releasing.
   */
  releaseUnresolvedClaims(runId: string): void {
    this.db
      .update(postings)
      .set({ scoringClaimedAt: null, scoringClaimRunId: null })
      .where(
        and(eq(postings.scoringClaimRunId, runId), isNull(postings.notifiedAt)),
      )
      .run();
  }

  /**
   * How many consecutive `scoreAndDeliver` runs have failed to score this
   * posting (docs/audit PR-002). `executeDeliver` reads this before spending
   * a model call, so a posting stuck failing indefinitely (a permanently
   * malformed description, not a transient provider hiccup) eventually stops
   * being retried. 0 for a fingerprint with no row — defensive, not expected
   * in practice, since every caller reads this only for a posting it already
   * has from `findUnnotified`.
   */
  getScoreFailureCount(fingerprint: string): number {
    const row = this.db
      .select({ scoreFailureCount: postings.scoreFailureCount })
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return row?.scoreFailureCount ?? 0;
  }

  /**
   * Increments the failure counter and records when it last happened
   * (docs/audit PR-002). An atomic `SET x = x + 1` rather than read-then-write
   * — this repository already documents (see the class doc comment) that
   * cross-transaction races are RunLock's job, not this one's, but an
   * increment is cheap to make race-safe on its own regardless.
   */
  recordScoreFailure(fingerprint: string, failedAt: Date): void {
    this.db
      .update(postings)
      .set({
        scoreFailureCount: sql`${postings.scoreFailureCount} + 1`,
        lastScoreFailedAt: failedAt,
      })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  /**
   * Resets the failure counter after a scoring attempt actually succeeds
   * (docs/audit PR-002) — a posting that failed twice and then scored
   * cleanly should not carry a stale near-ceiling count forward into
   * whatever reads it next.
   */
  clearScoreFailures(fingerprint: string): void {
    this.db
      .update(postings)
      .set({ scoreFailureCount: 0, lastScoreFailedAt: null })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }

  /**
   * Reopens a posting whose most recent scoring attempt failed (docs/audit
   * PR-024) for the next `scoreAndDeliver` run — the "a human who sees the
   * failure reason can re-run scoring manually" path ADR-006 promised
   * without ever building. Deliberately narrow: `scoreFailureCount > 0`
   * only holds for a posting whose last known outcome was a failure —
   * `clearScoreFailures` zeroes it the moment any attempt actually
   * succeeds, so a successfully-delivered posting is never eligible here.
   *
   * `notifiedAt`'s "write once, never cleared" discipline
   * (`findUnnotified`'s own doc comment, ADR-007) stays intact for every
   * posting a human actually saw a real verdict for — this is a scoped,
   * deliberate exception for the one case that discipline was never meant
   * to cover: a posting marked notified only because ADR-006 chose to
   * surface its failure reason rather than hide it, not because scoring
   * ever produced something to show.
   *
   * Also clears `scoringClaimedAt`/`scoringClaimRunId` — leaving the old
   * run's claim in place would make `claimForScoring` skip this posting
   * again for up to `DEFAULT_STALE_CLAIM_MS` (4 hours) despite
   * `notifiedAt` being clear, since that claim has not gone stale yet from
   * the next run's point of view.
   *
   * Returns `false` when the fingerprint does not exist, or exists but its
   * last attempt did not fail — the same idempotent-check pattern
   * `discard`/`restoreDuplicate` already use.
   */
  rescore(fingerprint: string): boolean {
    const result = this.db
      .update(postings)
      .set({
        notifiedAt: null,
        scoreFailureCount: 0,
        lastScoreFailedAt: null,
        scoringClaimedAt: null,
        scoringClaimRunId: null,
      })
      .where(
        and(
          eq(postings.fingerprint, fingerprint),
          gt(postings.scoreFailureCount, 0),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /**
   * Records a human decision that this posting is never worth surfacing
   * again — the manual counterpart to the scored `discard` verdict, and
   * independent of it: this survives a profile edit or a re-run under a new
   * prompt version, neither of which touches it, because it was never a
   * function of either.
   *
   * Write-once, same discipline as `notifiedAt`: a fingerprint already
   * discarded is left untouched (both timestamp and reason) rather than
   * overwritten by a second call. There is deliberately no "undiscard" —
   * reversing a bad call means clearing the column directly against the
   * database, a rare enough operation that a dedicated code path for it
   * would be unused machinery, not a feature.
   *
   * Returns `false` when the fingerprint does not exist, so a caller (the
   * CLI, the API) can report "no such posting" instead of silently
   * succeeding on a typo.
   */
  discard(
    fingerprint: string,
    discardedAt: Date,
    reason: string | null,
  ): boolean {
    const result = this.db
      .update(postings)
      .set({ discardedAt, discardReason: reason })
      .where(
        and(
          eq(postings.fingerprint, fingerprint),
          isNull(postings.discardedAt),
        ),
      )
      .run();
    if (result.changes > 0) return true;
    // `changes === 0` is ambiguous between "no such fingerprint" and
    // "already discarded" — the write-once guard above produces the same
    // count either way. Distinguish them with a second, cheap read so the
    // caller's 404 is accurate: reported as "not found" only when the row
    // genuinely does not exist, not when it silently no-ops on a repeat call.
    const exists = this.db
      .select({ fingerprint: postings.fingerprint })
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return exists !== undefined;
  }

  /**
   * Sets the manual "I applied" bookmark (ADR-072) — a toggle, not a
   * write-once decision like `discard`: reversible because marking it by
   * mistake is a plausible slip. Returns `false` when the fingerprint does
   * not exist, same idempotent-check contract as `discard`.
   */
  markApplied(fingerprint: string, appliedAt: Date): boolean {
    const result = this.db
      .update(postings)
      .set({ appliedAt })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
    return result.changes > 0;
  }

  /** Clears the bookmark `markApplied` set. `false` for a fingerprint that
   * does not exist or was never marked applied. */
  unmarkApplied(fingerprint: string): boolean {
    const result = this.db
      .update(postings)
      .set({ appliedAt: null })
      .where(
        and(
          eq(postings.fingerprint, fingerprint),
          isNotNull(postings.appliedAt),
        ),
      )
      .run();
    if (result.changes > 0) return true;
    const exists = this.db
      .select({ fingerprint: postings.fingerprint })
      .from(postings)
      .where(eq(postings.fingerprint, fingerprint))
      .get();
    return exists !== undefined;
  }

  /**
   * Every fingerprint currently marked applied, keyed to its timestamp
   * (ADR-072) — read once by `executeListPostings` rather than one query per
   * corpus entry, same batching reasoning as `findLastSeenAtBySource`.
   */
  findAppliedAtMap(): Map<string, Date> {
    const rows = this.db
      .select({
        fingerprint: postings.fingerprint,
        appliedAt: postings.appliedAt,
      })
      .from(postings)
      .where(isNotNull(postings.appliedAt))
      .all();
    const map = new Map<string, Date>();
    for (const row of rows) {
      if (row.appliedAt) map.set(row.fingerprint, row.appliedAt);
    }
    return map;
  }

  /**
   * Written by stage A (M7) once extraction succeeds — `05-domain-model.md`:
   * these are fields the score sees, not only the pre-filter's title
   * pattern. Unlike `firstSeenAt`, this is a plain overwrite: a prompt
   * improvement re-extracting the same posting should replace the old
   * values, not be blocked by a "write once" rule that only makes sense for
   * a sighting timestamp.
   */
  updateExtractedFields(
    fingerprint: string,
    seniority: Seniority | null,
    experienceYears: number | null,
  ): void {
    this.db
      .update(postings)
      .set({ seniority, experienceYears })
      .where(eq(postings.fingerprint, fingerprint))
      .run();
  }
}

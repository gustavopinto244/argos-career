import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createPosting } from "../../src/posting/domain/posting";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { postings } from "../../src/persistence/infrastructure/schema";
import { PostingsRepository } from "../../src/persistence/infrastructure/postings-repository";

// Real temporary SQLite files, not a mock (docs/07-testing-strategy.md).
let dir: string;
let db: Db;
let repository: PostingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-postings-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new PostingsRepository(db);
});

/** `discardedAt`/`discardReason` are deliberately absent from the `Posting`
 * domain type (persistence-only concept) — reads the raw row directly so a
 * test can assert on them without the repository exposing a getter nobody
 * else needs. */
function rawDiscardFields(fingerprint: string) {
  const row = db
    .select({
      discardedAt: postings.discardedAt,
      discardReason: postings.discardReason,
    })
    .from(postings)
    .where(eq(postings.fingerprint, fingerprint))
    .get();
  return row ?? null;
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "123",
    company: "Empresa X",
    title: "Estágio Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: new Date("2026-08-14T03:00:00Z"),
    firstSeenAt: new Date("2026-08-14T03:00:00Z"),
    lastSeenAt: new Date("2026-08-14T03:00:00Z"),
    rawPayload: { id: 123 },
    ...overrides,
  });
}

describe("PostingsRepository.upsert", () => {
  it("inserts a new posting, reporting wasNew: true", () => {
    const result = repository.upsert(posting());
    expect(result.wasNew).toBe(true);
    expect(repository.count()).toBe(1);
  });

  it("a second upsert of the same fingerprint leaves firstSeenAt unchanged and moves lastSeenAt — the mandated ADR-007 amendment test", () => {
    const first = repository.upsert(
      posting({
        collectedAt: new Date("2026-08-10T03:00:00Z"),
        firstSeenAt: new Date("2026-08-10T03:00:00Z"),
        lastSeenAt: new Date("2026-08-10T03:00:00Z"),
      }),
    );

    const second = repository.upsert(
      posting({
        collectedAt: new Date("2026-08-14T03:00:00Z"),
        firstSeenAt: new Date("2026-08-14T03:00:00Z"),
        lastSeenAt: new Date("2026-08-14T03:00:00Z"),
      }),
    );

    expect(second.wasNew).toBe(false);
    expect(second.posting.firstSeenAt).toEqual(first.posting.firstSeenAt);
    expect(second.posting.firstSeenAt).toEqual(
      new Date("2026-08-10T03:00:00Z"),
    );
    expect(second.posting.lastSeenAt).toEqual(new Date("2026-08-14T03:00:00Z"));
    expect(repository.count()).toBe(1);
  });

  it("a third upsert continues to preserve the original firstSeenAt", () => {
    repository.upsert(
      posting({ firstSeenAt: new Date("2026-08-01T00:00:00Z") }),
    );
    repository.upsert(
      posting({ firstSeenAt: new Date("2026-08-05T00:00:00Z") }),
    );
    const third = repository.upsert(
      posting({ firstSeenAt: new Date("2026-08-10T00:00:00Z") }),
    );

    expect(third.posting.firstSeenAt).toEqual(new Date("2026-08-01T00:00:00Z"));
  });

  it("updates non-identity fields on a re-sighting — a posting can be edited by the employer", () => {
    repository.upsert(posting({ title: "Estágio Backend" }));
    const second = repository.upsert(
      // Same fingerprint requires same company/title/city, so change
      // something that does not participate in the fingerprint instead.
      posting({ workMode: "remote" }),
    );

    expect(second.posting.workMode).toBe("remote");
  });

  it("keeps two postings with different fingerprints as separate rows", () => {
    repository.upsert(posting({ sourceId: "1" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));

    expect(repository.count()).toBe(2);
  });

  it("upsertMany preserves insert and re-sighting semantics in one transaction", () => {
    const firstSeenAt = new Date("2026-08-10T00:00:00Z");
    const results = repository.upsertMany([
      posting({ sourceId: "1", firstSeenAt, lastSeenAt: firstSeenAt }),
      posting({
        sourceId: "1",
        firstSeenAt: new Date("2026-08-14T00:00:00Z"),
        lastSeenAt: new Date("2026-08-14T00:00:00Z"),
        workMode: "remote",
      }),
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    ]);

    expect(results.map((result) => result.wasNew)).toEqual([true, false, true]);
    expect(results[1]?.posting.firstSeenAt).toEqual(firstSeenAt);
    expect(results[1]?.posting.workMode).toBe("remote");
    expect(repository.count()).toBe(2);
  });

  it("retains the raw payload across an upsert", () => {
    const result = repository.upsert(
      posting({ rawPayload: { id: 123, note: "original" } }),
    );
    expect(result.posting.rawPayload).toEqual({ id: 123, note: "original" });
  });

  it("hydrates with a marker rawPayload instead of throwing when the stored JSON is corrupted (docs/audit AC-031)", () => {
    const inserted = repository.upsert(posting()).posting;
    // A real restore/manual-edit scenario, not a mock -- write truncated
    // JSON directly into the column, bypassing upsert's own JSON.stringify.
    db.update(postings)
      .set({ rawPayload: '{"truncated' })
      .where(eq(postings.fingerprint, inserted.fingerprint))
      .run();

    expect(() =>
      repository.findByFingerprint(inserted.fingerprint),
    ).not.toThrow();
    const found = repository.findByFingerprint(inserted.fingerprint);
    expect(found?.rawPayload).toEqual({ corrupted: true });
    // The rest of the row still hydrates normally -- corruption in this one
    // opaque field must not take the whole posting down with it.
    expect(found?.company).toBe("Empresa X");
  });
});

describe("PostingsRepository.findByFingerprint / findByCompany", () => {
  it("finds a stored posting by fingerprint", () => {
    const { posting: stored } = repository.upsert(posting());
    const found = repository.findByFingerprint(stored.fingerprint);
    expect(found?.company).toBe("Empresa X");
  });

  it("returns null for a fingerprint that was never stored", () => {
    expect(repository.findByFingerprint("does-not-exist")).toBeNull();
  });

  it("finds every posting from a given company", () => {
    repository.upsert(posting({ sourceId: "1", title: "Estágio Backend" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));
    repository.upsert(
      posting({ sourceId: "3", company: "Outra Empresa", title: "Estágio X" }),
    );

    expect(repository.findByCompany("Empresa X")).toHaveLength(2);
  });
});

describe("PostingsRepository — nothing is ever deleted", () => {
  it("upserting one posting does not remove an unrelated one", () => {
    repository.upsert(posting({ sourceId: "1" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));

    repository.upsert(posting({ sourceId: "1" }));

    expect(repository.count()).toBe(2);
  });

  it("markDuplicate flags a row without removing it — rejected postings are retained, not deleted", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );

    repository.markDuplicate(b.posting.fingerprint, a.posting.fingerprint);

    expect(repository.count()).toBe(2);
    expect(repository.findByFingerprint(b.posting.fingerprint)).not.toBeNull();
  });
});

describe("PostingsRepository.restoreDuplicate (docs/audit PR-006)", () => {
  it("clears a flag set by markDuplicate and returns true", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.markDuplicate(b.posting.fingerprint, a.posting.fingerprint);
    expect(repository.findActive()).toHaveLength(1);

    const restored = repository.restoreDuplicate(b.posting.fingerprint);

    expect(restored).toBe(true);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("returns false for a posting that was never flagged", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));

    expect(repository.restoreDuplicate(a.posting.fingerprint)).toBe(false);
  });

  it("returns false for a fingerprint that does not exist", () => {
    expect(repository.restoreDuplicate("does-not-exist")).toBe(false);
  });

  it("is idempotent — restoring an already-restored posting returns false the second time", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.markDuplicate(b.posting.fingerprint, a.posting.fingerprint);

    expect(repository.restoreDuplicate(b.posting.fingerprint)).toBe(true);
    expect(repository.restoreDuplicate(b.posting.fingerprint)).toBe(false);
  });
});

describe("PostingsRepository.findUnnotified / markNotified", () => {
  it("includes a freshly upserted posting", () => {
    repository.upsert(posting());
    expect(repository.findUnnotified()).toHaveLength(1);
  });

  it("excludes a posting once markNotified has run — never notified twice", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.markNotified(stored.fingerprint, new Date());

    expect(repository.findUnnotified()).toHaveLength(0);
    expect(
      repository
        .findUnnotified()
        .find((p) => p.fingerprint === stored.fingerprint),
    ).toBeUndefined();
  });

  it("re-upserting a notified posting does not un-notify it", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.markNotified(
      stored.fingerprint,
      new Date("2026-08-10T00:00:00Z"),
    );

    repository.upsert(posting({ workMode: "remote" }));

    expect(repository.findUnnotified()).toHaveLength(0);
  });

  it("excludes a posting already flagged as a duplicate, even if unnotified", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.markDuplicate(b.posting.fingerprint, a.posting.fingerprint);

    const unnotified = repository.findUnnotified();
    expect(unnotified).toHaveLength(1);
    expect(unnotified[0]?.fingerprint).toBe(a.posting.fingerprint);
  });

  it("marks a delivered batch together and treats an empty batch as a no-op", () => {
    const first = repository.upsert(posting({ sourceId: "1" })).posting;
    const second = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    ).posting;

    repository.markNotifiedMany(
      [first.fingerprint, second.fingerprint],
      new Date("2026-08-17T12:00:00Z"),
    );
    repository.markNotifiedMany([], new Date());

    expect(repository.findUnnotified()).toEqual([]);
  });
});

describe("PostingsRepository.recordScoreFailure / clearScoreFailures / getScoreFailureCount (docs/audit PR-002)", () => {
  it("is zero for a posting that has never failed scoring", () => {
    const { posting: stored } = repository.upsert(posting());
    expect(repository.getScoreFailureCount(stored.fingerprint)).toBe(0);
  });

  it("increments on each recorded failure", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.recordScoreFailure(stored.fingerprint, new Date());
    expect(repository.getScoreFailureCount(stored.fingerprint)).toBe(1);

    repository.recordScoreFailure(stored.fingerprint, new Date());
    expect(repository.getScoreFailureCount(stored.fingerprint)).toBe(2);
  });

  it("resets to zero once clearScoreFailures runs", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.recordScoreFailure(stored.fingerprint, new Date());
    repository.recordScoreFailure(stored.fingerprint, new Date());

    repository.clearScoreFailures(stored.fingerprint);

    expect(repository.getScoreFailureCount(stored.fingerprint)).toBe(0);
  });

  it("tracks failures independently per posting", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.recordScoreFailure(a.posting.fingerprint, new Date());

    expect(repository.getScoreFailureCount(a.posting.fingerprint)).toBe(1);
    expect(repository.getScoreFailureCount(b.posting.fingerprint)).toBe(0);
  });

  it("re-upserting a posting does not reset its failure count", () => {
    // A source re-sighting a posting (an ordinary collection cycle) must
    // not accidentally give a persistently-broken posting a fresh retry
    // budget just because it was seen again.
    const { posting: stored } = repository.upsert(posting());
    repository.recordScoreFailure(stored.fingerprint, new Date());

    repository.upsert(posting({ workMode: "remote" }));

    expect(repository.getScoreFailureCount(stored.fingerprint)).toBe(1);
  });
});

/** Claim columns are deliberately absent from `Posting` (persistence-only
 * concept, same reasoning as `rawDiscardFields`) — reads the raw row so a
 * test can assert on them directly. */
function rawClaimFields(fingerprint: string) {
  const row = db
    .select({
      scoringClaimedAt: postings.scoringClaimedAt,
      scoringClaimRunId: postings.scoringClaimRunId,
    })
    .from(postings)
    .where(eq(postings.fingerprint, fingerprint))
    .get();
  return row ?? null;
}

describe("PostingsRepository.claimForScoring / releaseUnresolvedClaims (docs/audit PR-004)", () => {
  const NOW = new Date("2026-08-17T03:00:00Z");

  it("claims every active, unnotified, undiscarded, unclaimed posting", () => {
    repository.upsert(posting({ sourceId: "1" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));

    const claimed = repository.claimForScoring("run-1", NOW);

    expect(claimed).toHaveLength(2);
    const [first] = claimed;
    expect(rawClaimFields(first!.fingerprint)).toEqual({
      scoringClaimedAt: NOW,
      scoringClaimRunId: "run-1",
    });
  });

  it("excludes a posting already claimed by a still-live run", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.claimForScoring("run-1", NOW);

    const secondClaim = repository.claimForScoring(
      "run-2",
      new Date(NOW.getTime() + 1_000),
    );

    expect(secondClaim).toHaveLength(0);
    // Still held by run-1 -- run-2's attempt must not have stolen it.
    expect(rawClaimFields(stored.fingerprint)?.scoringClaimRunId).toBe("run-1");
  });

  it("excludes a duplicate, a discarded posting, and an already-notified posting", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    const c = repository.upsert(
      posting({ sourceId: "3", title: "Estágio Segurança" }),
    );
    repository.markDuplicate(a.posting.fingerprint, b.posting.fingerprint);
    // b is a's canonical -- discarding it too is what makes it excluded on
    // its own account, rather than leaving one perfectly eligible posting
    // in the mix and making this test pass for the wrong reason.
    repository.discard(b.posting.fingerprint, NOW, null);
    repository.discard(c.posting.fingerprint, NOW, null);
    const d = repository.upsert(
      posting({ sourceId: "4", title: "Estágio Dados" }),
    );
    repository.markNotified(d.posting.fingerprint, NOW);

    const claimed = repository.claimForScoring("run-1", NOW);

    expect(claimed).toHaveLength(0);
  });

  it("treats a claim older than staleClaimMs as abandoned and reclaimable", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.claimForScoring("run-1", NOW);

    const muchLater = new Date(NOW.getTime() + 10_000);
    const reclaimed = repository.claimForScoring("run-2", muchLater, 5_000);

    expect(reclaimed).toHaveLength(1);
    expect(rawClaimFields(stored.fingerprint)).toEqual({
      scoringClaimedAt: muchLater,
      scoringClaimRunId: "run-2",
    });
  });

  it("does not treat a claim as stale before staleClaimMs elapses", () => {
    repository.upsert(posting());
    repository.claimForScoring("run-1", NOW);

    const soonAfter = new Date(NOW.getTime() + 1_000);
    const reclaimed = repository.claimForScoring("run-2", soonAfter, 5_000);

    expect(reclaimed).toHaveLength(0);
  });

  it("releaseUnresolvedClaims clears the claim for an unnotified posting held by that run", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.claimForScoring("run-1", NOW);

    repository.releaseUnresolvedClaims("run-1");

    expect(rawClaimFields(stored.fingerprint)).toEqual({
      scoringClaimedAt: null,
      scoringClaimRunId: null,
    });
    // Immediately reclaimable -- no need to wait out staleClaimMs.
    expect(repository.claimForScoring("run-2", NOW)).toHaveLength(1);
  });

  it("releaseUnresolvedClaims leaves a notified posting's claim alone", () => {
    // Notified means resolved -- releasing it would be pointless, and
    // clearing scoringClaimRunId would make a future audit of "which run
    // actually scored this" impossible to answer.
    const { posting: stored } = repository.upsert(posting());
    repository.claimForScoring("run-1", NOW);
    repository.markNotified(stored.fingerprint, NOW);

    repository.releaseUnresolvedClaims("run-1");

    expect(rawClaimFields(stored.fingerprint)).toEqual({
      scoringClaimedAt: NOW,
      scoringClaimRunId: "run-1",
    });
  });

  it("releaseUnresolvedClaims only releases claims held by the given run", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    repository.claimForScoring("run-1", NOW);
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    // b was never claimed by run-1 (it didn't exist yet); claim it under a
    // different run entirely to prove run-1's release does not touch it.
    repository.claimForScoring("run-2", new Date(NOW.getTime() + 100));

    repository.releaseUnresolvedClaims("run-1");

    expect(rawClaimFields(a.posting.fingerprint)?.scoringClaimRunId).toBeNull();
    expect(rawClaimFields(b.posting.fingerprint)?.scoringClaimRunId).toBe(
      "run-2",
    );
  });

  it("is idempotent -- releasing an already-released or never-claimed posting is a no-op", () => {
    repository.upsert(posting());
    expect(() =>
      repository.releaseUnresolvedClaims("no-such-run"),
    ).not.toThrow();
  });
});

describe("PostingsRepository.markApplied / unmarkApplied / findAppliedAtMap (ADR-072)", () => {
  it("markApplied returns true and records the timestamp", () => {
    const { posting: stored } = repository.upsert(posting());
    const appliedAt = new Date("2026-08-28T12:00:00Z");

    const found = repository.markApplied(stored.fingerprint, appliedAt);

    expect(found).toBe(true);
    expect(repository.findAppliedAtMap().get(stored.fingerprint)).toEqual(
      appliedAt,
    );
  });

  it("markApplied returns false for a fingerprint that does not exist", () => {
    expect(repository.markApplied("no-such-fingerprint", new Date())).toBe(
      false,
    );
  });

  it("unlike discard, is a reversible toggle: unmarkApplied clears it and it can be re-marked", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.markApplied(stored.fingerprint, new Date("2026-08-01T00:00:00Z"));

    const unmarked = repository.unmarkApplied(stored.fingerprint);

    expect(unmarked).toBe(true);
    expect(repository.findAppliedAtMap().has(stored.fingerprint)).toBe(false);

    const remarkedAt = new Date("2026-08-28T00:00:00Z");
    repository.markApplied(stored.fingerprint, remarkedAt);
    expect(repository.findAppliedAtMap().get(stored.fingerprint)).toEqual(
      remarkedAt,
    );
  });

  it("unmarkApplied returns true (idempotent) for a posting that exists but was never applied", () => {
    const { posting: stored } = repository.upsert(posting());
    expect(repository.unmarkApplied(stored.fingerprint)).toBe(true);
  });

  it("unmarkApplied returns false for a fingerprint that does not exist", () => {
    expect(repository.unmarkApplied("no-such-fingerprint")).toBe(false);
  });

  it("findAppliedAtMap only includes postings currently marked applied", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));
    repository.markApplied(a.posting.fingerprint, new Date());

    const map = repository.findAppliedAtMap();
    expect(map.size).toBe(1);
    expect(map.has(a.posting.fingerprint)).toBe(true);
  });
});

describe("PostingsRepository.discard", () => {
  it("returns true and records the timestamp and reason", () => {
    const { posting: stored } = repository.upsert(posting());
    const discardedAt = new Date("2026-08-16T12:00:00Z");

    const found = repository.discard(
      stored.fingerprint,
      discardedAt,
      "Not interested in fintech",
    );

    expect(found).toBe(true);
    expect(rawDiscardFields(stored.fingerprint)).toEqual({
      discardedAt,
      discardReason: "Not interested in fintech",
    });
  });

  it("returns false for a fingerprint that does not exist", () => {
    const found = repository.discard("no-such-fingerprint", new Date(), null);
    expect(found).toBe(false);
  });

  it("excludes a discarded posting from findUnnotified", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.discard(stored.fingerprint, new Date(), null);

    expect(repository.findUnnotified()).toHaveLength(0);
  });

  it("is write-once: a second call does not overwrite the original timestamp or reason", () => {
    const { posting: stored } = repository.upsert(posting());
    const first = new Date("2026-08-16T12:00:00Z");
    const second = new Date("2026-08-20T00:00:00Z");

    repository.discard(stored.fingerprint, first, "original reason");
    const secondCall = repository.discard(
      stored.fingerprint,
      second,
      "different reason",
    );

    // The second call still reports "posting exists" (true), distinct from
    // a genuinely missing fingerprint, but must not have moved the
    // timestamp or replaced the reason — there is no "re-discard".
    expect(secondCall).toBe(true);
    expect(rawDiscardFields(stored.fingerprint)).toEqual({
      discardedAt: first,
      discardReason: "original reason",
    });
  });

  it("re-upserting a discarded posting does not un-discard it", () => {
    // Same "write once survives re-collection" discipline notifiedAt and
    // firstSeenAt already follow — a source re-listing the same posting
    // must not silently resurrect a human's decision.
    const { posting: stored } = repository.upsert(posting());
    repository.discard(stored.fingerprint, new Date(), null);

    repository.upsert(posting({ workMode: "remote" }));

    expect(repository.findUnnotified()).toHaveLength(0);
  });

  it("does not affect an unrelated posting", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.discard(a.posting.fingerprint, new Date(), null);

    const unnotified = repository.findUnnotified();
    expect(unnotified).toHaveLength(1);
    expect(unnotified[0]?.fingerprint).toBe(b.posting.fingerprint);
  });
});

describe("PostingsRepository.rescore (docs/audit PR-024)", () => {
  it("reopens a posting whose last scoring attempt failed", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.recordScoreFailure(stored.fingerprint, new Date());
    repository.markNotified(stored.fingerprint, new Date());
    expect(repository.findUnnotified()).toHaveLength(0);

    const rescored = repository.rescore(stored.fingerprint);

    expect(rescored).toBe(true);
    expect(repository.findUnnotified()).toHaveLength(1);
    expect(repository.getScoreFailureCount(stored.fingerprint)).toBe(0);
  });

  it("clears a stale-but-not-yet-expired scoring claim, so the next run can claim it immediately", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.recordScoreFailure(stored.fingerprint, new Date());
    repository.markNotified(stored.fingerprint, new Date());
    // Simulate the run that produced the failure having claimed it —
    // fresh, well within DEFAULT_STALE_CLAIM_MS.
    repository.claimForScoring("run-1", new Date());

    repository.rescore(stored.fingerprint);

    const claimed = repository.claimForScoring("run-2", new Date());
    expect(claimed.map((p) => p.fingerprint)).toEqual([stored.fingerprint]);
  });

  it("returns false for a fingerprint that does not exist", () => {
    expect(repository.rescore("no-such-fingerprint")).toBe(false);
  });

  it("returns false for a posting that was never scored (no failure on record)", () => {
    const { posting: stored } = repository.upsert(posting());
    expect(repository.rescore(stored.fingerprint)).toBe(false);
  });

  it("returns false for a posting whose last attempt succeeded — notifiedAt's write-once discipline holds", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.recordScoreFailure(stored.fingerprint, new Date());
    // A later success resets the counter -- the same signal
    // executeDeliver's own clearScoreFailures call relies on.
    repository.clearScoreFailures(stored.fingerprint);
    repository.markNotified(stored.fingerprint, new Date());

    expect(repository.rescore(stored.fingerprint)).toBe(false);
    expect(repository.findUnnotified()).toHaveLength(0);
  });

  it("does not affect an unrelated posting", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.recordScoreFailure(a.posting.fingerprint, new Date());
    repository.markNotified(a.posting.fingerprint, new Date());
    repository.recordScoreFailure(b.posting.fingerprint, new Date());
    repository.markNotified(b.posting.fingerprint, new Date());

    repository.rescore(a.posting.fingerprint);

    const unnotified = repository.findUnnotified();
    expect(unnotified).toHaveLength(1);
    expect(unnotified[0]?.fingerprint).toBe(a.posting.fingerprint);
  });
});

describe("country round-trip (ADR-068)", () => {
  it("persists country and reads it back through findActive", () => {
    // The field is written in two places (insert and update) and read in a
    // third (hydration). Nothing else in the suite crosses all three, so
    // dropping any one of them would have gone unnoticed.
    repository.upsertMany([posting({ country: "BR" })]);
    expect(repository.findActive()[0]?.country).toBe("BR");
  });

  it("stores null when the source states no country", () => {
    repository.upsertMany([posting()]);
    expect(repository.findActive()[0]?.country).toBeNull();
  });

  it("backfills a legacy row's null country on re-collection", () => {
    // Every posting collected before ADR-068 has a null country. A source
    // that later states one must be able to fill it in, or the whole
    // pre-ADR corpus stays permanently unplaceable.
    const first = posting({ country: null });
    repository.upsertMany([first]);
    expect(repository.findActive()[0]?.country).toBeNull();

    repository.upsertMany([posting({ country: "BR" })]);
    const stored = repository.findActive();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.country).toBe("BR");
  });

  it("keeps country out of the fingerprint, so identity does not move", () => {
    // Adding a field to `computeFingerprint` would re-collect the entire
    // corpus as new (ADR-007) — this is what stops that regression.
    expect(posting({ country: "BR" }).fingerprint).toBe(
      posting({ country: "US" }).fingerprint,
    );
  });
});

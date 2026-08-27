import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { PendingAlertsRepository } from "../../../src/persistence/infrastructure/pending-alerts-repository";

const NOW = new Date("2026-08-26T03:00:00Z");
const LATER = new Date("2026-08-26T07:00:00Z");

let dir: string;
let db: Db;
let repository: PendingAlertsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-pending-alerts-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new PendingAlertsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PendingAlertsRepository (ADR-067)", () => {
  it("queues an undeliverable alert and lists it back", () => {
    repository.queue(
      "run:missed",
      "No digest sent today.",
      NOW,
      "Telegram request failed",
    );

    const [queued] = repository.list(10);
    expect(queued?.text).toBe("No digest sent today.");
    expect(queued?.occurrences).toBe(1);
    expect(queued?.lastError).toBe("Telegram request failed");
    expect(repository.count()).toBe(1);
  });

  it("collapses a repeated alert into one row with a count", () => {
    // The alerting conditions are level-triggered (docs/08) — the same
    // sentence is re-derived every cycle the outage lasts. Without this,
    // a day-long outage queues it six times and redelivery spams it back.
    repository.queue(
      "source:stale:gupy",
      "Source gupy stale for 8h.",
      NOW,
      "down",
    );
    repository.queue(
      "source:stale:gupy",
      "Source gupy stale for 12h.",
      LATER,
      "still down",
    );

    const rows = repository.list(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(2);
    expect(rows[0]?.lastError).toBe("still down");
  });

  it("keeps firstQueuedAt at the original raise, so lateness stays measurable", () => {
    repository.queue("run:missed", "No digest sent today.", NOW, null);
    repository.queue("run:missed", "No digest sent today.", LATER, null);

    const [queued] = repository.list(10);
    expect(queued?.firstQueuedAt.toISOString()).toBe(NOW.toISOString());
    expect(queued?.lastQueuedAt.toISOString()).toBe(LATER.toISOString());
  });

  it("lists oldest first, so the longest-waiting alert is not starved", () => {
    repository.queue("k:second", "second", LATER, null);
    repository.queue("k:first", "first", NOW, null);

    expect(repository.list(10).map((row) => row.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("caps how many it returns, bounding a recovery cycle", () => {
    for (let i = 0; i < 8; i++) {
      repository.queue(
        `k:${i}`,
        `alert ${i}`,
        new Date(NOW.getTime() + i * 1000),
        null,
      );
    }
    expect(repository.list(5)).toHaveLength(5);
    expect(repository.count()).toBe(8);
  });

  it("removes a row once its alert is delivered", () => {
    repository.queue("k:one", "delivered later", NOW, null);
    const [queued] = repository.list(10);

    repository.remove(queued!.id);

    expect(repository.list(10)).toHaveLength(0);
    expect(repository.count()).toBe(0);
  });

  it("counts zero on an empty queue rather than throwing", () => {
    expect(repository.count()).toBe(0);
    expect(repository.list(10)).toEqual([]);
  });

  it("dedups a level-triggered alert whose wording changes each cycle", () => {
    // The defect this key exists for: `evaluateSourceFreshness` embeds a
    // growing `staleForHours` and an ISO timestamp, so deduplicating on the
    // MESSAGE deduplicated nothing — a two-day outage queued a dozen
    // near-identical rows per source and would have replayed them all as
    // stale news.
    repository.queue("source:stale:indeed", "indeed stale for 27h.", NOW, null);
    repository.queue(
      "source:stale:indeed",
      "indeed stale for 31h.",
      LATER,
      null,
    );
    repository.queue(
      "source:stale:indeed",
      "indeed stale for 35h.",
      LATER,
      null,
    );

    const rows = repository.list(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
    // The newest wording survives — replaying "27h" after recovery would
    // report a situation that has since moved on.
    expect(rows[0]?.text).toBe("indeed stale for 35h.");
    expect(rows[0]?.firstQueuedAt.toISOString()).toBe(NOW.toISOString());
  });

  it("bounds the table even if keys ever became high-cardinality", () => {
    for (let i = 0; i < 60; i++) {
      repository.queue(
        `k:${i}`,
        `alert ${i}`,
        new Date(NOW.getTime() + i),
        null,
      );
    }
    expect(repository.count()).toBe(50);
    // The oldest are kept — they describe what has been broken longest.
    expect(repository.list(1)[0]?.text).toBe("alert 0");
  });
});

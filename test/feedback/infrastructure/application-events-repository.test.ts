import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplicationEvent } from "../../../src/feedback/domain/application-event";
import {
  ApplicationEventsRepository,
  parseApplicationEventMetadata,
} from "../../../src/feedback/infrastructure/application-events-repository";
import {
  createDatabase,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";

let dir: string;
let repository: ApplicationEventsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-application-events-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new ApplicationEventsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function event(
  overrides: Partial<Parameters<typeof createApplicationEvent>[0]> = {},
) {
  return createApplicationEvent({
    fingerprint: "fp-1",
    kind: "response_received",
    occurredAt: new Date("2026-08-14T03:00:00Z"),
    recordedBy: "feedback:abc123",
    ...overrides,
  });
}

describe("ApplicationEventsRepository", () => {
  it("records an event and finds it by fingerprint", () => {
    repository.record(event());

    const rows = repository.findByFingerprint("fp-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fingerprint: "fp-1",
      kind: "response_received",
      recordedBy: "feedback:abc123",
      note: null,
    });
    expect(rows[0]?.occurredAt).toEqual(new Date("2026-08-14T03:00:00Z"));
  });

  it("findByFingerprint returns a posting's full history, most recent first", () => {
    repository.record(
      event({
        kind: "response_received",
        occurredAt: new Date("2026-08-10T03:00:00Z"),
      }),
    );
    repository.record(
      event({
        kind: "interview_scheduled",
        occurredAt: new Date("2026-08-20T03:00:00Z"),
      }),
    );
    repository.record(
      event({ kind: "offer", occurredAt: new Date("2026-08-25T03:00:00Z") }),
    );

    const history = repository.findByFingerprint("fp-1");
    expect(history.map((row) => row.kind)).toEqual([
      "offer",
      "interview_scheduled",
      "response_received",
    ]);
  });

  it("findByFingerprint only returns events for that posting", () => {
    repository.record(event({ fingerprint: "fp-1" }));
    repository.record(event({ fingerprint: "fp-2" }));

    expect(repository.findByFingerprint("fp-1")).toHaveLength(1);
    expect(repository.findByFingerprint("fp-2")).toHaveLength(1);
  });

  it("stores and round-trips a note", () => {
    repository.record(event({ note: "recrutador pediu disponibilidade" }));
    const [row] = repository.findByFingerprint("fp-1");
    expect(row?.note).toBe("recrutador pediu disponibilidade");
  });

  it("stores and round-trips structured metadata", () => {
    repository.record(event(), { gmailThreadId: "thread-123" });
    const [row] = repository.findByFingerprint("fp-1");
    expect(parseApplicationEventMetadata(row!)).toEqual({
      gmailThreadId: "thread-123",
    });
  });

  it("metadata is null when never provided", () => {
    repository.record(event());
    const [row] = repository.findByFingerprint("fp-1");
    expect(row?.metadata).toBeNull();
    expect(parseApplicationEventMetadata(row!)).toBeNull();
  });

  it("parseApplicationEventMetadata degrades to null on corrupted JSON", () => {
    expect(parseApplicationEventMetadata({ metadata: "not json" })).toBeNull();
  });

  it("findByFingerprint returns nothing for a posting with no events", () => {
    expect(repository.findByFingerprint("does-not-exist")).toEqual([]);
  });
});

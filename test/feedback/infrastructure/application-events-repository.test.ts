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

// The only thing stopping a re-report is the Gmail `flagged` marker the
// Hermes outcome-tracking skill sets AFTER a successful record — external
// and best-effort. If it fails to apply, or the run dies between the two
// steps, the next run reads the same email and reports the same event.
describe("recording the same fact twice is absorbed, not duplicated", () => {
  it("returns true the first time and false on an exact re-report", () => {
    expect(repository.record(event())).toBe(true);
    expect(repository.record(event())).toBe(false);
    expect(repository.findByFingerprint("fp-1")).toHaveLength(1);
  });

  it("keeps the first note when the same fact is re-reported differently worded", () => {
    repository.record(event({ note: "primeiro relato" }));
    repository.record(event({ note: "mesmo fato, outra redação" }));
    const rows = repository.findByFingerprint("fp-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe("primeiro relato");
  });

  // recordedBy is deliberately not part of the identity: the operator
  // recording a rejection by hand and Hermes reporting the same one are
  // the same fact, not two.
  it("treats the same fact from a different reporter as already known", () => {
    expect(repository.record(event({ recordedBy: "admin:abc" }))).toBe(true);
    expect(repository.record(event({ recordedBy: "feedback:xyz" }))).toBe(
      false,
    );
    expect(repository.findByFingerprint("fp-1")).toHaveLength(1);
  });

  it("still records a genuinely different event — append-only is intact", () => {
    expect(repository.record(event({ kind: "response_received" }))).toBe(true);
    expect(repository.record(event({ kind: "rejected" }))).toBe(true);
    expect(
      repository.record(
        event({ kind: "rejected", occurredAt: new Date("2026-09-01") }),
      ),
    ).toBe(true);
    expect(repository.findByFingerprint("fp-1")).toHaveLength(3);
  });

  it("does not collapse the same kind across different postings", () => {
    expect(repository.record(event({ fingerprint: "fp-1" }))).toBe(true);
    expect(repository.record(event({ fingerprint: "fp-2" }))).toBe(true);
  });
});

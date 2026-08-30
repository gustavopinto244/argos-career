import { describe, expect, it } from "vitest";
import {
  APPLICATION_EVENT_KINDS,
  createApplicationEvent,
} from "../../../src/feedback/domain/application-event";

const NOW = new Date("2026-08-30T12:00:00Z");

function input(
  overrides: Partial<Parameters<typeof createApplicationEvent>[0]> = {},
) {
  return {
    fingerprint: "fp-1",
    kind: "response_received" as const,
    occurredAt: NOW,
    recordedBy: "feedback:abc123",
    ...overrides,
  };
}

describe("createApplicationEvent", () => {
  it("builds an event from valid input", () => {
    const event = createApplicationEvent(input());
    expect(event).toEqual({
      fingerprint: "fp-1",
      kind: "response_received",
      note: null,
      occurredAt: NOW,
      recordedBy: "feedback:abc123",
    });
  });

  it.each(APPLICATION_EVENT_KINDS)("accepts the recognized kind %s", (kind) => {
    expect(() => createApplicationEvent(input({ kind }))).not.toThrow();
  });

  it("does not include 'applied' among the recognized kinds", () => {
    // ADR-075: postings.appliedAt (ADR-072) already owns that fact as a
    // reversible toggle. Duplicating it here would create two sources of
    // truth for "did I apply" — one reversible, one append-only.
    expect(APPLICATION_EVENT_KINDS).not.toContain("applied");
  });

  it("rejects an unrecognized kind", () => {
    expect(() =>
      createApplicationEvent(
        input({ kind: "applied" as unknown as "response_received" }),
      ),
    ).toThrow(/not recognized/);
  });

  it("rejects an empty fingerprint", () => {
    expect(() => createApplicationEvent(input({ fingerprint: "  " }))).toThrow(
      /fingerprint must not be empty/,
    );
  });

  it("rejects an empty recordedBy", () => {
    expect(() => createApplicationEvent(input({ recordedBy: "" }))).toThrow(
      /recordedBy must not be empty/,
    );
  });

  it("trims a note and keeps it", () => {
    const event = createApplicationEvent(
      input({ note: "  recrutador pediu disponibilidade  " }),
    );
    expect(event.note).toBe("recrutador pediu disponibilidade");
  });

  it("normalizes a blank note to null", () => {
    const event = createApplicationEvent(input({ note: "   " }));
    expect(event.note).toBeNull();
  });

  it("defaults note to null when omitted", () => {
    const event = createApplicationEvent(input());
    expect(event.note).toBeNull();
  });
});

// This factory is the only runtime validation the REST path gets — the app
// registers no global ValidationPipe, so `POST /postings/:fingerprint/
// application-events` hands its body through with an erased TypeScript type.
// The MCP path has its own Zod schema; the REST route does not.
describe("guards the REST path, which has no ValidationPipe behind it", () => {
  it("rejects an invalid date instead of letting it reach the INSERT", () => {
    // Reproduced before the fix: this reached the repository and surfaced as
    // `NOT NULL constraint failed: application_events.occurred_at` — a 500
    // naming a database column for what is really "that is not a date".
    expect(() =>
      createApplicationEvent(input({ occurredAt: new Date("garbage") })),
    ).toThrow(/occurredAt must be a valid date/);
  });

  it("rejects an occurredAt that is not a Date at all", () => {
    expect(() =>
      createApplicationEvent(
        input({ occurredAt: "2026-08-30" as unknown as Date }),
      ),
    ).toThrow(/occurredAt must be a valid date/);
  });

  it("rejects a non-string note instead of throwing a raw TypeError", () => {
    expect(() =>
      createApplicationEvent(input({ note: 42 as unknown as string })),
    ).toThrow(/note must be a string/);
  });

  it("still accepts a real date", () => {
    expect(() =>
      createApplicationEvent(input({ occurredAt: new Date("2026-08-30") })),
    ).not.toThrow();
  });
});

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

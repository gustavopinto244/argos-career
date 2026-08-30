import { describe, expect, it } from "vitest";
import { timeSeries } from "../../../src/market/domain/time-series";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";

function entryAt(firstSeenAt: Date): CorpusEntry {
  const posting = createPosting({
    source: "gupy",
    sourceId: `id-${Math.random()}`,
    company: "Acme",
    title: "Estágio",
    location: { kind: "unknown" },
    workMode: "remote",
    collectedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    rawPayload: {},
  });
  return {
    posting,
    requirements: [],
    matches: null,
    verdict: null,
    blockingFailure: null,
    criticalGaps: [],
    periodGate: null,
    appliedAt: null,
  };
}

describe("timeSeries", () => {
  it("buckets postings by the Monday of their firstSeenAt week", () => {
    // 2026-08-14 is a Friday; that week's Monday is 2026-08-10.
    const entries = [
      entryAt(new Date("2026-08-10T00:00:00Z")),
      entryAt(new Date("2026-08-14T12:00:00Z")),
    ];
    const result = timeSeries(entries);
    expect(result).toEqual([{ weekStart: "2026-08-10", count: 2 }]);
  });

  it("sorts buckets chronologically", () => {
    const entries = [
      entryAt(new Date("2026-08-14T00:00:00Z")),
      entryAt(new Date("2026-08-03T00:00:00Z")),
    ];
    const result = timeSeries(entries);
    expect(result.map((p) => p.weekStart)).toEqual([
      "2026-08-03",
      "2026-08-10",
    ]);
  });

  it("returns an empty array for an empty corpus", () => {
    expect(timeSeries([])).toEqual([]);
  });
});

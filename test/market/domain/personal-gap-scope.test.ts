import { describe, expect, it } from "vitest";
import { selectPersonalGapScope } from "../../../src/market/domain/personal-gap-scope";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";
import { Requirement, Verdict } from "../../../src/scoring/domain/types";

const NOW = new Date("2026-08-14T03:00:00Z");

function requirement(text: string): Requirement {
  return { text, category: "", weight: "mandatory" };
}

function entry(
  overrides: Partial<{
    verdict: Verdict | null;
    appliedAt: Date | null;
    blockingFailure: Requirement | null;
    criticalGaps: Requirement[];
  }> = {},
): CorpusEntry {
  const posting = createPosting({
    source: "gupy",
    sourceId: `id-${Math.random()}`,
    company: "Acme",
    title: "Estágio",
    location: { kind: "unknown" },
    workMode: "remote",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
  return {
    posting,
    requirements: [],
    matches: null,
    verdict: overrides.verdict ?? null,
    blockingFailure: overrides.blockingFailure ?? null,
    criticalGaps: overrides.criticalGaps ?? [],
    appliedAt: overrides.appliedAt ?? null,
  };
}

describe("selectPersonalGapScope — applied", () => {
  it("keeps only postings with a non-null appliedAt", () => {
    const applied = entry({ appliedAt: NOW });
    const notApplied = entry({ appliedAt: null });
    expect(selectPersonalGapScope([applied, notApplied], "applied")).toEqual([
      applied,
    ]);
  });

  it("is indifferent to verdict — appliedAt alone decides", () => {
    const applied = entry({ appliedAt: NOW, verdict: "discard" });
    expect(selectPersonalGapScope([applied], "applied")).toEqual([applied]);
  });
});

describe("selectPersonalGapScope — discarded", () => {
  it("keeps a discard verdict with a real unmet mandatory requirement", () => {
    const e = entry({
      verdict: "discard",
      criticalGaps: [requirement("Kubernetes required")],
    });
    expect(selectPersonalGapScope([e], "discarded")).toEqual([e]);
  });

  it("keeps a discard verdict with a blocking failure and no criticalGaps entry", () => {
    const e = entry({
      verdict: "discard",
      blockingFailure: requirement("CLT required"),
      criticalGaps: [],
    });
    expect(selectPersonalGapScope([e], "discarded")).toEqual([e]);
  });

  // The case this scope exists to exclude: a discard driven purely by
  // being off-track (unknownTrackCapScore), with every real requirement
  // met. Counting this as a competency gap would tell the operator to
  // learn something they already have.
  it("excludes a discard verdict with no competency gap (off-track only)", () => {
    const e = entry({
      verdict: "discard",
      blockingFailure: null,
      criticalGaps: [],
    });
    expect(selectPersonalGapScope([e], "discarded")).toEqual([]);
  });

  it("excludes review/apply verdicts", () => {
    const e = entry({
      verdict: "review",
      criticalGaps: [requirement("Kubernetes required")],
    });
    expect(selectPersonalGapScope([e], "discarded")).toEqual([]);
  });

  // A posting the pre-filter rejected before Stage A/B ran was never
  // evaluated for competency at all.
  it("excludes unscored postings (verdict null)", () => {
    const e = entry({
      verdict: null,
      criticalGaps: [requirement("Kubernetes required")],
    });
    expect(selectPersonalGapScope([e], "discarded")).toEqual([]);
  });
});

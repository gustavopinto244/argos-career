import { describe, expect, it } from "vitest";
import {
  selectPersonalGapScope,
  unanalyzedAppliedEntries,
} from "../../../src/market/domain/personal-gap-scope";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";
import { Requirement, Verdict } from "../../../src/scoring/domain/types";
import { PeriodGate } from "../../../src/scoring/domain/period-gate";

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
    periodGate: PeriodGate | null;
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
    periodGate: overrides.periodGate ?? null,
    appliedAt: overrides.appliedAt ?? null,
  };
}

describe("selectPersonalGapScope — applied", () => {
  it("keeps only postings with a non-null appliedAt", () => {
    const applied = entry({ appliedAt: NOW, verdict: "review" });
    const notApplied = entry({ appliedAt: null, verdict: "review" });
    expect(selectPersonalGapScope([applied, notApplied], "applied")).toEqual([
      applied,
    ]);
  });

  // An applied posting Stage A/B never produced a usable result for has no
  // requirements to read gaps from. Counting it would leave every skill
  // count untouched while inflating the denominator, quietly understating
  // every real gap.
  it("excludes an applied posting that was never scored", () => {
    const unscored = entry({ appliedAt: NOW, verdict: null });
    expect(selectPersonalGapScope([unscored], "applied")).toEqual([]);
    expect(unanalyzedAppliedEntries([unscored])).toEqual([unscored]);
  });

  it("does not count a never-applied unscored posting as unanalyzed", () => {
    expect(unanalyzedAppliedEntries([entry({ appliedAt: null })])).toEqual([]);
  });

  it("keeps an applied posting regardless of which verdict it got", () => {
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

  // ADR-053: not unqualified, only not eligible yet — and no amount of
  // study changes an academic period.
  it("excludes a discard blocked only by a not-yet-reached academic period", () => {
    const e = entry({
      verdict: "discard",
      criticalGaps: [requirement("Cursando a partir do 4º período")],
      periodGate: { minimumPeriod: 4, opensAtLabel: "2027.2" },
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

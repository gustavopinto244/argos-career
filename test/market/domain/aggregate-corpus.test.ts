import { describe, expect, it } from "vitest";
import { aggregateCorpus } from "../../../src/market/domain/aggregate-corpus";
import { Taxonomy } from "../../../src/market/domain/taxonomy";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";
import { Requirement } from "../../../src/scoring/domain/types";

const NOW = new Date("2026-08-14T03:00:00Z");

const TAXONOMY: Taxonomy = {
  skills: [
    { canonical: "PostgreSQL", aliases: ["Postgres"] },
    { canonical: "Docker", aliases: [] },
  ],
};

function requirement(text: string): Requirement {
  return { text, category: "", weight: "mandatory" };
}

function entry(
  overrides: Partial<{
    company: string;
    city: string | null;
    workMode: "remote" | "hybrid" | "onsite" | "unknown";
    seniority: "internship" | "trainee" | "junior" | "mid" | "senior" | null;
    requirements: Requirement[];
  }> = {},
): CorpusEntry {
  const posting = createPosting({
    source: "gupy",
    sourceId: `id-${Math.random()}`,
    company: overrides.company ?? "Acme",
    title: "Estágio em Desenvolvimento",
    location:
      overrides.city === undefined
        ? { kind: "unknown" }
        : overrides.city === null
          ? { kind: "unknown" }
          : { kind: "known", city: overrides.city },
    workMode: overrides.workMode ?? "remote",
    seniority: overrides.seniority ?? null,
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
  return {
    posting,
    requirements: overrides.requirements ?? [],
    matches: null,
    verdict: null,
    blockingFailure: null,
    criticalGaps: [],
    appliedAt: null,
  };
}

describe("aggregateCorpus", () => {
  it("counts the whole corpus, extraction coverage separately", () => {
    const entries = [
      entry({ requirements: [requirement("PostgreSQL required")] }),
      entry({ requirements: [] }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);
    expect(result.corpusSize).toBe(2);
    expect(result.extractedCount).toBe(1);
  });

  it("deduplicates a skill mentioned in multiple requirements of one posting", () => {
    const entries = [
      entry({
        requirements: [
          requirement("PostgreSQL experience"),
          requirement("Also PostgreSQL for reporting"),
        ],
      }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);
    expect(result.skillFrequency).toEqual([
      { skill: "PostgreSQL", count: 1, percentage: 1 },
    ]);
  });

  it("computes skill percentage over extracted postings, not the whole corpus", () => {
    const entries = [
      entry({ requirements: [requirement("Docker required")] }),
      entry({ requirements: [] }),
      entry({ requirements: [] }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);
    expect(result.skillFrequency).toEqual([
      { skill: "Docker", count: 1, percentage: 1 },
    ]);
  });

  it("counts companies, regions, work modes and experience levels over the whole corpus", () => {
    const entries = [
      entry({ company: "Acme", city: "Rio de Janeiro", workMode: "remote" }),
      entry({ company: "Acme", city: "Rio de Janeiro", workMode: "hybrid" }),
      entry({
        company: "Globex",
        city: null,
        workMode: "onsite",
        seniority: "internship",
      }),
    ];
    const result = aggregateCorpus(entries, TAXONOMY);

    expect(result.companies).toContainEqual({ label: "Acme", count: 2 });
    expect(result.companies).toContainEqual({ label: "Globex", count: 1 });
    expect(result.regions).toContainEqual({
      label: "Rio de Janeiro",
      count: 2,
    });
    expect(result.regions).toContainEqual({ label: "unknown", count: 1 });
    expect(result.workModes.map((w) => w.label).sort()).toEqual(
      ["hybrid", "onsite", "remote"].sort(),
    );
    expect(result.experienceLevels).toContainEqual({
      label: "internship",
      count: 1,
    });
    expect(result.experienceLevels).toContainEqual({
      label: "unknown",
      count: 2,
    });
  });

  it("returns zero percentages, not NaN, for an empty corpus", () => {
    const result = aggregateCorpus([], TAXONOMY);
    expect(result.corpusSize).toBe(0);
    expect(result.extractedCount).toBe(0);
    expect(result.skillFrequency).toEqual([]);
  });
});

describe("free-text labels are grouped by spelling, not by exact string", () => {
  // Measured on production 2026-08-29: 40 of 488 distinct city labels were
  // spelling variants of another ("BRASILIA" (10) beside "Brasilia" (269)),
  // and 12 of 2,964 company labels likewise.
  it("merges city spellings and reports the most common one", () => {
    const result = aggregateCorpus(
      [
        ...Array.from({ length: 5 }, () => entry({ city: "Brasília" })),
        entry({ city: "BRASÍLIA" }),
        entry({ city: "brasilia" }),
      ],
      TAXONOMY,
    );

    expect(result.regions).toEqual([{ label: "Brasília", count: 7 }]);
  });

  it("merges company spellings the same way", () => {
    const result = aggregateCorpus(
      [
        entry({ company: "Cagece" }),
        entry({ company: "Cagece" }),
        entry({ company: "CAGECE" }),
      ],
      TAXONOMY,
    );

    expect(result.companies).toEqual([{ label: "Cagece", count: 3 }]);
  });

  // The consequence that made this worth fixing: the split reordered the
  // report's own ranking. "Santos" outranked a "São José dos Campos" whose
  // real total was higher but sat across two rows.
  it("ranks on the merged total, not on the largest single spelling", () => {
    const result = aggregateCorpus(
      [
        ...Array.from({ length: 4 }, () => entry({ city: "Santos" })),
        ...Array.from({ length: 3 }, () => entry({ city: "São José" })),
        ...Array.from({ length: 2 }, () => entry({ city: "SÃO JOSÉ" })),
      ],
      TAXONOMY,
    );

    expect(result.regions.map((r) => r.label)).toEqual(["São José", "Santos"]);
    expect(result.regions[0]?.count).toBe(5);
  });

  // Closed enums are not free text — normalizing a value that cannot vary
  // would only obscure where the label comes from.
  it("leaves the enum-valued buckets on their raw values", () => {
    const result = aggregateCorpus(
      [
        entry({ workMode: "remote" }),
        entry({ workMode: "hybrid" }),
        entry({ seniority: "internship" }),
      ],
      TAXONOMY,
    );
    expect(result.workModes.map((b) => b.label).sort()).toEqual([
      "hybrid",
      "remote",
    ]);
    expect(result.experienceLevels.map((b) => b.label).sort()).toEqual([
      "internship",
      "unknown",
    ]);
  });
});

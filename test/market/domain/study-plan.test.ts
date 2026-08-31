import { describe, expect, it } from "vitest";
import { composeStudyPlan } from "../../../src/market/domain/study-plan";
import { Taxonomy } from "../../../src/market/domain/taxonomy";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";
import { Profile } from "../../../src/profile/domain/profile";
import { Requirement } from "../../../src/scoring/domain/types";

const NOW = new Date("2026-08-14T03:00:00Z");

const TAXONOMY: Taxonomy = {
  skills: [{ canonical: "PostgreSQL", aliases: ["Postgres"] }],
};

function requirement(text: string): Requirement {
  return { text, category: "", weight: "mandatory" };
}

function entry(
  requirements: Requirement[],
  verdict: "apply" | "review" | "discard" | null,
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
    requirements,
    matches: null,
    verdict,
    blockingFailure: null,
    criticalGaps: [],
    periodGate: null,
    appliedAt: null,
  };
}

function profile(): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
    workAvailability: "40h remoto, disponível dias úteis.",
    competencies: [
      {
        name: "Node.js",
        tracks: ["dev"],
        aliases: [],
        evidence: ["Evidence."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

describe("composeStudyPlan", () => {
  it("combines corpus stats, gaps, market demand and volume into one plan", () => {
    const entries = [
      entry([requirement("PostgreSQL required")], "apply"),
      entry([], null),
    ];
    const plan = composeStudyPlan(entries, profile(), TAXONOMY, NOW);

    expect(plan.generatedAt).toBe(NOW);
    expect(plan.corpusSize).toBe(2);
    expect(plan.extractedCount).toBe(1);
    expect(plan.highCompatibilityCount).toBe(1);
    expect(plan.gaps).toEqual([
      { skill: "PostgreSQL", count: 1, percentage: 100 },
    ]);
    expect(plan.marketDemand).toEqual([
      { skill: "PostgreSQL", count: 1, percentage: 100 },
    ]);
    expect(plan.volumeByWeek).toHaveLength(1);
  });

  it("produces a sensible empty plan for an empty corpus", () => {
    const plan = composeStudyPlan([], profile(), TAXONOMY, NOW);
    expect(plan.corpusSize).toBe(0);
    expect(plan.highCompatibilityCount).toBe(0);
    expect(plan.gaps).toEqual([]);
    expect(plan.marketDemand).toEqual([]);
    expect(plan.volumeByWeek).toEqual([]);
  });
});

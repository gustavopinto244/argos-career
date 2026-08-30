import { describe, expect, it } from "vitest";
import { gapAnalysis } from "../../../src/market/domain/gap-analysis";
import { Taxonomy } from "../../../src/market/domain/taxonomy";
import { CorpusEntry } from "../../../src/market/domain/types";
import { createPosting } from "../../../src/posting/domain/posting";
import { Profile } from "../../../src/profile/domain/profile";
import { Requirement, Verdict } from "../../../src/scoring/domain/types";

const NOW = new Date("2026-08-14T03:00:00Z");

const TAXONOMY: Taxonomy = {
  skills: [
    { canonical: "PostgreSQL", aliases: ["Postgres"] },
    { canonical: "Docker", aliases: [] },
    { canonical: "Node.js", aliases: ["NodeJS"] },
  ],
};

function requirement(text: string): Requirement {
  return { text, category: "", weight: "mandatory" };
}

function entry(
  requirements: Requirement[],
  verdict: Verdict | null,
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

function profile(competencyNames: string[]): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
    workAvailability: "40h remoto, disponível dias úteis.",
    competencies: competencyNames.map((name) => ({
      name,
      tracks: ["dev"],
      aliases: [],
      evidence: [`Evidence for ${name}.`],
    })),
    resumeVariants: [
      {
        id: "backend",
        tracks: ["dev"],
        competencyNames: competencyNames.length > 0 ? competencyNames : ["x"],
      },
    ],
  };
}

describe("gapAnalysis", () => {
  it("ranks skills frequent in high-compatibility postings and absent from the profile", () => {
    const entries = [
      entry([requirement("PostgreSQL required")], "apply"),
      entry([requirement("PostgreSQL required")], "review"),
      entry([requirement("Docker required")], "apply"),
    ];
    const result = gapAnalysis(entries, profile(["Node.js"]), TAXONOMY);
    expect(result).toEqual([
      { skill: "PostgreSQL", count: 2, percentage: 2 / 3 },
      { skill: "Docker", count: 1, percentage: 1 / 3 },
    ]);
  });

  it("excludes skills the profile already covers", () => {
    const entries = [entry([requirement("Node.js required")], "apply")];
    const result = gapAnalysis(entries, profile(["Node.js"]), TAXONOMY);
    expect(result).toEqual([]);
  });

  // ADR-076: gapAnalysis no longer filters by verdict itself — "what's in
  // scope" varies by caller (market-wide high-compatibility postings vs.
  // personally applied/discarded ones), so it now runs over exactly the
  // entries it is given, whatever their verdict.
  it("counts every entry it is given, regardless of verdict", () => {
    const entries = [
      entry([requirement("PostgreSQL required")], "discard"),
      entry([requirement("PostgreSQL required")], null),
    ];
    const result = gapAnalysis(entries, profile([]), TAXONOMY);
    expect(result).toEqual([{ skill: "PostgreSQL", count: 2, percentage: 1 }]);
  });

  it("returns an empty array when given no entries", () => {
    expect(gapAnalysis([], profile([]), TAXONOMY)).toEqual([]);
  });
});

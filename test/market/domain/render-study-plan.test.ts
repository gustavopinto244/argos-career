import { describe, expect, it } from "vitest";
import { renderStudyPlanText } from "../../../src/market/domain/render-study-plan";
import { StudyPlan } from "../../../src/market/domain/study-plan";

const NOW = new Date("2026-08-14T03:00:00Z");

function plan(overrides: Partial<StudyPlan> = {}): StudyPlan {
  return {
    generatedAt: NOW,
    corpusSize: 523,
    extractedCount: 16,
    highCompatibilityCount: 5,
    gaps: [{ skill: "PostgreSQL", count: 3, percentage: 60 }],
    marketDemand: [{ skill: "TypeScript", count: 10, percentage: 62.5 }],
    volumeByWeek: [{ weekStart: "2026-08-10", count: 12 }],
    ...overrides,
  };
}

describe("renderStudyPlanText", () => {
  it("renders every section in pt-BR", () => {
    const text = renderStudyPlanText(plan());
    expect(text).toContain("523 vagas");
    expect(text).toContain("16 com");
    expect(text).toContain("5 de alta compatibilidade");
    expect(text).toContain("Lacunas mais frequentes");
    expect(text).toContain(
      "PostgreSQL — 3 de 5 vagas de alta compatibilidade (60%)",
    );
    expect(text).toContain("Tecnologias mais pedidas no mercado");
    expect(text).toContain("TypeScript — 10 de 16 vagas com extração (63%)");
    expect(text).toContain("Volume por semana");
    expect(text).toContain("2026-08-10: 12 vagas");
  });

  it("renders an honest empty state for each section instead of an empty list", () => {
    const text = renderStudyPlanText(
      plan({ gaps: [], marketDemand: [], volumeByWeek: [] }),
    );
    expect(text).toContain("nenhuma lacuna identificada");
    expect(text).toContain("sem dados suficientes");
    expect(text).toContain("sem dados");
  });

  it("caps each ranked list at 10 entries", () => {
    const manyGaps = Array.from({ length: 15 }, (_, i) => ({
      skill: `Skill${i}`,
      count: 15 - i,
      percentage: ((15 - i) / 15) * 100,
    }));
    const text = renderStudyPlanText(plan({ gaps: manyGaps }));
    expect(text).toContain("Skill9");
    expect(text).not.toContain("Skill10");
  });
});

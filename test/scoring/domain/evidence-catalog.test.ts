import { describe, expect, it } from "vitest";
import { Profile, UNVERIFIED } from "../../../src/profile/domain/profile";
import {
  buildEvidenceCatalog,
  formatEvidenceCatalog,
} from "../../../src/scoring/domain/evidence-catalog";

function profile(overrides: Partial<Profile> = {}): Profile {
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
        evidence: [
          "Built atlas-manager's HTTP layer in Node.js.",
          "Wrote a Vitest + Supertest suite covering the same layer.",
        ],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
    ...overrides,
  };
}

describe("buildEvidenceCatalog (docs/audit PR-001)", () => {
  const TODAY = new Date("2026-08-15"); // period 2, per ADR-018's semester math

  it("includes the derived academic-enrollment entry, tagged", () => {
    const catalog = buildEvidenceCatalog(profile(), TODAY);
    expect(catalog).toContainEqual({
      tag: "Academic enrollment",
      text: "Cursando o 2º período de Sistemas de Informação na Universidade Exemplo, com conclusão prevista para 2029.2.",
    });
  });

  it("includes the four declared-field entries, each tagged", () => {
    const catalog = buildEvidenceCatalog(profile(), TODAY);
    expect(catalog).toContainEqual({
      tag: "English level",
      text: "Nível de inglês: intermediate.",
    });
    expect(catalog).toContainEqual({
      tag: "Availability",
      text: "Disponibilidade de até 30 horas semanais.",
    });
    expect(catalog).toContainEqual({
      tag: "Work availability",
      text: "40h remoto, disponível dias úteis.",
    });
    expect(catalog).toContainEqual({
      tag: "Compensation",
      text: "Bolsa-auxílio mínima aceita: R$ 1500.",
    });
  });

  it("omits a declared field still marked UNVERIFIED", () => {
    const catalog = buildEvidenceCatalog(
      profile({ englishLevel: UNVERIFIED }),
      TODAY,
    );
    expect(catalog.some((e) => e.tag === "English level")).toBe(false);
  });

  it("omits workAvailability when still marked UNVERIFIED", () => {
    const catalog = buildEvidenceCatalog(
      profile({ workAvailability: UNVERIFIED }),
      TODAY,
    );
    expect(catalog.some((e) => e.tag === "Work availability")).toBe(false);
  });

  it("includes every competency's evidence, tagged by competency name", () => {
    const catalog = buildEvidenceCatalog(profile(), TODAY);
    expect(catalog).toContainEqual({
      tag: "Node.js",
      text: "Built atlas-manager's HTTP layer in Node.js.",
    });
    expect(catalog).toContainEqual({
      tag: "Node.js",
      text: "Wrote a Vitest + Supertest suite covering the same layer.",
    });
  });

  it("advances the academic period with the calendar", () => {
    const catalog = buildEvidenceCatalog(profile(), new Date("2027-03-01"));
    const academic = catalog.find((e) => e.tag === "Academic enrollment");
    expect(academic?.text).toContain("Cursando o 3º período");
  });

  it("states enrollment has not started before the course begins", () => {
    const catalog = buildEvidenceCatalog(profile(), new Date("2025-01-01"));
    const academic = catalog.find((e) => e.tag === "Academic enrollment");
    expect(academic?.text).toContain("ainda não iniciou o curso");
  });
});

describe("formatEvidenceCatalog", () => {
  it("renders one '- [tag] text' line per entry", () => {
    const formatted = formatEvidenceCatalog([
      { tag: "Node.js", text: "Built a service." },
      { tag: "SQL", text: "Wrote migrations." },
    ]);
    expect(formatted).toBe(
      "- [Node.js] Built a service.\n- [SQL] Wrote migrations.",
    );
  });

  it("renders an empty string for an empty catalog", () => {
    expect(formatEvidenceCatalog([])).toBe("");
  });
});

describe("optional start and commitment declarations", () => {
  it("does not infer either declaration from hours and graduation", () => {
    const entries = buildEvidenceCatalog(profile(), new Date("2026-10-30"));
    expect(
      entries.some(
        (e) =>
          e.tag === "Start availability" || e.tag === "Internship duration",
      ),
    ).toBe(false);
  });
  it("renders explicitly confirmed declarations", () => {
    const declared = profile({
      startAvailability: "Disponível para início imediato.",
      minimumInternshipMonths: 18,
    });
    expect(buildEvidenceCatalog(declared, new Date("2026-10-30"))).toEqual(
      expect.arrayContaining([
        { tag: "Start availability", text: "Disponível para início imediato." },
        {
          tag: "Internship duration",
          text: "Disponível para compromisso mínimo de 18 meses de estágio.",
        },
      ]),
    );
  });
});

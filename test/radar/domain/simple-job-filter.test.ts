import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { isSimpleJobAllowed } from "../../../src/radar/domain/simple-job-filter";

const config = {
  onsiteCity: "Joinville",
  titleTerms: ["analista", "auxiliar", "assistente", "negociador"],
};
const base = createPosting({
  source: "gupy",
  sourceId: "1",
  company: "Empresa",
  title: "Assistente administrativo",
  location: { kind: "known", city: "Joinville" },
  workMode: "onsite",
  country: "BR",
  description: "Ensino médio completo. Excel básico e atendimento.",
  collectedAt: new Date(),
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
  rawPayload: {},
});

describe("simple job filter", () => {
  it("accepts generalist roles onsite in Joinville and remote in Brazil", () => {
    for (const title of [
      "Analista de atendimento",
      "Auxiliar administrativo",
      "Assistente comercial",
      "Negociador de cobrança",
    ]) {
      expect(isSimpleJobAllowed({ ...base, title }, config)).toBe(true);
    }
    expect(
      isSimpleJobAllowed(
        {
          ...base,
          workMode: "remote",
          location: { kind: "known", city: "São Paulo" },
        },
        config,
      ),
    ).toBe(true);
    expect(
      isSimpleJobAllowed(
        { ...base, description: "Ensino médio completo. Superior desejável." },
        config,
      ),
    ).toBe(true);
  });
  it.each([
    { description: null },
    { description: "Superior completo." },
    {
      description: "Ensino médio completo. Graduação em andamento obrigatória.",
    },
    { description: "Ensino médio completo. Curso técnico obrigatório." },
    { title: "Analista de QA" },
    { title: "Analista contábil" },
    { title: "Assistente sênior" },
    { title: "Auxiliar de enfermagem" },
    { description: "Ensino médio completo. Inglês fluente." },
    { workMode: "hybrid" as const },
    { workMode: "unknown" as const },
    { location: { kind: "unknown" as const } },
    { location: { kind: "known" as const, city: "Curitiba" } },
    { country: "US", workMode: "remote" as const },
    { country: null, source: "unknown", workMode: "remote" as const },
    {
      workMode: "remote" as const,
      description: "Ensino médio completo. Residir em São Paulo.",
    },
  ])("rejects ineligible or unconfirmed vacancy %j", (changes) => {
    expect(isSimpleJobAllowed({ ...base, ...changes }, config)).toBe(false);
  });
});

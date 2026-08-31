import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { ScoreOutcome } from "../../../src/scoring/domain/types";
import {
  EMPTY_RECOMMENDATION,
  Recommendation,
} from "../../../src/scoring/domain/recommendation";
import { Digest, ScoredPosting } from "../../../src/delivery/domain/digest";
import {
  renderDigestText,
  renderPostingEntry,
} from "../../../src/delivery/domain/render-digest";

const NOW = new Date("2026-08-14T03:00:00Z");

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    sourceUrl: "https://example.org/vagas/1",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

function outcome(
  overrides: Partial<ScoreOutcome & Recommendation> = {},
): ScoreOutcome & Recommendation {
  return {
    score: 62.4,
    verdict: "review",
    breakdown: {
      mandatoryCoverage: 1,
      desirableCoverage: 1,
      trackAlignment: 1,
    },
    blockingFailure: null,
    blockingFailures: [],
    lowConfidence: true,
    criticalGaps: [],
    periodGate: null,
    ...EMPTY_RECOMMENDATION,
    ...overrides,
  };
}

function scored(overrides: Partial<ScoredPosting> = {}): ScoredPosting {
  return { posting: posting(), outcome: outcome(), ...overrides };
}

function emptyDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    runId: "run-1",
    generatedAt: NOW,
    recommended: [],
    review: [],
    periodBlocked: [],
    unreachable: [],
    summary: {
      collected: 0,
      deduplicated: 0,
      filtered: 0,
      scored: 0,
      failedSources: [],
      truncatedSources: [],
    },
    ...overrides,
  };
}

describe("renderPostingEntry", () => {
  it("renders company, title, rounded score, translated verdict, location and link", () => {
    const text = renderPostingEntry(scored());

    expect(text).toContain("Empresa: Empresa X");
    expect(text).toContain("Cargo: Estágio em Desenvolvimento Backend");
    expect(text).toContain("Compatibilidade: 62% · avaliar");
    expect(text).toContain("Local: Rio de Janeiro · Híbrido");
    expect(text).toContain("Fonte: gupy");
    expect(text).toContain("→ https://example.org/vagas/1");
  });

  it("translates the apply verdict to candidatar", () => {
    const text = renderPostingEntry(
      scored({ outcome: outcome({ verdict: "apply", score: 85 }) }),
    );
    expect(text).toContain("· candidatar");
  });

  it("says explicitly when a source provided no link, rather than omitting the line", () => {
    const text = renderPostingEntry(
      scored({ posting: posting({ sourceUrl: null }) }),
    );
    expect(text).toContain("→ (link não informado pela fonte)");
  });

  it("renders a remote posting without a city", () => {
    const text = renderPostingEntry(
      scored({
        posting: posting({ location: { kind: "unknown" }, workMode: "remote" }),
      }),
    );
    expect(text).toContain("Local: Remoto");
  });

  it("warns when the outcome is lowConfidence — a high score there reflects empty-category coverage, not a verified match", () => {
    const text = renderPostingEntry(
      scored({ outcome: outcome({ lowConfidence: true, score: 100 }) }),
    );
    expect(text).toContain("Confiança baixa");
  });

  it("does not warn when the outcome is not lowConfidence", () => {
    const text = renderPostingEntry(
      scored({ outcome: outcome({ lowConfidence: false }) }),
    );
    expect(text).not.toContain("Confiança baixa");
  });

  it("makes bounded scoring input visible to the operator", () => {
    const text = renderPostingEntry(
      scored({ outcome: { ...outcome(), inputTruncated: true } }),
    );
    expect(text).toContain("Conteúdo da vaga foi reduzido");
  });

  it("renders the recommended resume variant, highlights and missing terms when computed (docs/audit AC-026)", () => {
    const text = renderPostingEntry(
      scored({
        outcome: outcome({
          recommendedVariant: "backend",
          highlights: ["Node.js em produção", "Docker"],
          missingTerms: ["Kubernetes"],
        }),
      }),
    );
    expect(text).toContain("Currículo recomendado: backend");
    expect(text).toContain("Pontos fortes: Node.js em produção; Docker");
    expect(text).toContain("Termos ausentes no currículo: Kubernetes");
  });

  it("renders critical gaps when the outcome has any", () => {
    const text = renderPostingEntry(
      scored({
        outcome: outcome({
          criticalGaps: [
            { text: "Docker", category: "tooling", weight: "mandatory" },
          ],
        }),
      }),
    );
    expect(text).toContain("Lacunas: Docker");
  });

  it("renders a scoring-failure warning instead of the lowConfidence one (docs/audit AC-009)", () => {
    const text = renderPostingEntry(
      scored({
        outcome: outcome({
          lowConfidence: true,
          scoreFailureReason: "matching_failed",
        }),
      }),
    );
    expect(text).toContain("Não foi possível pontuar automaticamente");
    expect(text).toContain("avaliação manual necessária");
    expect(text).not.toContain("Confiança baixa");
  });

  it("renders a distinct label once a posting has exhausted its retry budget (docs/audit PR-002)", () => {
    const text = renderPostingEntry(
      scored({
        outcome: outcome({
          lowConfidence: true,
          scoreFailureReason: "max_retries_exceeded",
        }),
      }),
    );
    expect(text).toContain("falhou repetidamente");
    expect(text).toContain("não será mais tentada automaticamente");
  });

  it("omits the recommendation lines entirely for a stubbed run (EMPTY_RECOMMENDATION)", () => {
    const text = renderPostingEntry(scored());
    expect(text).not.toContain("Currículo recomendado");
    expect(text).not.toContain("Pontos fortes");
    expect(text).not.toContain("Termos ausentes");
    expect(text).not.toContain("Lacunas");
  });
});

describe("renderDigestText", () => {
  it("renders all four sections in order, even when every list is empty", () => {
    const text = renderDigestText(emptyDigest());
    const recommendedIdx = text.indexOf("Recomendadas");
    const reviewIdx = text.indexOf("Vale avaliar");
    const periodIdx = text.indexOf("Abrem para você em breve");
    const summaryIdx = text.indexOf("Resumo da execução");

    expect(recommendedIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeGreaterThan(recommendedIdx);
    expect(periodIdx).toBeGreaterThan(reviewIdx);
    expect(summaryIdx).toBeGreaterThan(periodIdx);
  });

  it("includes a posting entry inside its section", () => {
    const text = renderDigestText(emptyDigest({ review: [scored()] }));
    expect(text).toContain("Empresa: Empresa X");
  });

  it("renders the period-blocked entry with its calendar-term label", () => {
    const text = renderDigestText(
      emptyDigest({
        periodBlocked: [{ posting: posting(), opensAtLabel: "2027.1" }],
      }),
    );
    expect(text).toContain("Empresa X — Estágio em Desenvolvimento Backend");
    expect(text).toContain("Abre para você em 2027.1");
  });

  it("renders the run summary counts and a list of failed sources", () => {
    const text = renderDigestText(
      emptyDigest({
        summary: {
          collected: 10,
          deduplicated: 8,
          filtered: 5,
          scored: 5,
          failedSources: ["gupy"],
          truncatedSources: [],
        },
      }),
    );
    expect(text).toContain("Coletadas: 10");
    expect(text).toContain("Novas após deduplicação: 8");
    expect(text).toContain("Após pré-filtro: 5");
    expect(text).toContain("Pontuadas: 5");
    expect(text).toContain("Fontes com falha: gupy");
  });

  it("reports no failed sources as 'nenhuma'", () => {
    const text = renderDigestText(emptyDigest());
    expect(text).toContain("Fontes com falha: nenhuma");
  });

  it("renders a list of sources truncated by their own result cap (docs/audit PR-015)", () => {
    const text = renderDigestText(
      emptyDigest({
        summary: {
          collected: 10,
          deduplicated: 8,
          filtered: 5,
          scored: 5,
          failedSources: [],
          truncatedSources: ["ciee", "indeed"],
        },
      }),
    );
    expect(text).toContain("Fontes truncadas pelo limite: ciee, indeed");
  });

  it("reports no truncated sources as 'nenhuma'", () => {
    const text = renderDigestText(emptyDigest());
    expect(text).toContain("Fontes truncadas pelo limite: nenhuma");
  });
});

describe("the unreachable section names the code instead of an absent link", () => {
  it("tells the operator where to look and by which code", () => {
    const text = renderDigestText(
      emptyDigest({
        unreachable: [
          {
            posting: posting({
              source: "ciee",
              sourceId: "6153296",
              sourceUrl: null,
              company: "SUPERARE",
              title: "Estágio em Informática",
            }),
            outcome: outcome({ verdict: "apply", score: 82 }),
          },
        ],
      }),
    );
    expect(text).toContain("Sem link direto");
    expect(text).toContain("Procure em ciee pelo código 6153296");
    // The point of the section: never print the dead-end line again for
    // an entry we know has no link.
    expect(text).not.toContain("(link não informado pela fonte)");
  });

  it("says so plainly when there is nothing unreachable", () => {
    expect(renderDigestText(emptyDigest({}))).toContain(
      "Sem link direto — procure no portal da fonte\n\n(nenhuma vaga)",
    );
  });
});

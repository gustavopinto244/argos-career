import { describe, expect, it } from "vitest";
import {
  keywordMatchesText,
  normalizeTitle,
  titleMatchesAny,
} from "../../../src/prefilter/domain/title-match";

describe("normalizeTitle", () => {
  it("turns punctuation into a space, unlike the fingerprint normalizer", () => {
    // The whole point: "Estagiário(a)" must keep a boundary after
    // "estagiario" so a whole-word match can find it.
    expect(normalizeTitle("Estagiário(a)")).toBe("estagiario a");
    expect(normalizeTitle("Estágio - Service Desk")).toBe(
      "estagio service desk",
    );
  });

  it("strips accents, lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  ESTÁGIO   Nível  Superior ")).toBe(
      "estagio nivel superior",
    );
  });
});

describe("titleMatchesAny — the substring bug this exists to fix", () => {
  const blocklist = [
    "sênior",
    "pleno",
    "especialista",
    "tech lead",
    "III",
    "IV",
  ];

  it.each([
    ["Estágio Nível Superior - TI - Segurança da Informação", "nível"],
    ["Estágio Universitário - Suporte TI", "universitário"],
    ["Programa de Estágio | Vaga Afirmativa", "afirmativa"],
    ["Jovem Aprendiz Administrativo", "administrativo"],
    ["Programa de Estágio | Engenharia Civil", "civil"],
    ["Estágio de Suporte Executivo", "executivo"],
    ["Banco Talentos | Diversas Áreas", "diversas"],
  ])("does not let 'IV' block %s (was matching inside %s)", (title) => {
    expect(titleMatchesAny(title, blocklist)).toBe(false);
  });

  it("still blocks a real roman-numeral seniority marker", () => {
    expect(titleMatchesAny("Analista III - Desenvolvimento", blocklist)).toBe(
      true,
    );
    expect(titleMatchesAny("Analista de Sistemas IV", blocklist)).toBe(true);
  });

  it("still blocks the ordinary seniority words", () => {
    expect(titleMatchesAny("Desenvolvedor Backend Sênior", blocklist)).toBe(
      true,
    );
    expect(titleMatchesAny("Analista Pleno (PHP & React)", blocklist)).toBe(
      true,
    );
  });

  it("matches a multi-word term as a phrase", () => {
    expect(titleMatchesAny("Engineering Tech Lead", blocklist)).toBe(true);
    expect(titleMatchesAny("Tech Support", blocklist)).toBe(false);
  });
});

describe("titleMatchesAny — required terms", () => {
  const required = [
    "estágio",
    "estágios",
    "estagiário",
    "estagiária",
    "intern",
    "internship",
  ];

  it.each([
    "Estágio em Desenvolvimento Backend",
    "Estagiário(a) de Fisiologia",
    "Pessoa Estagiária em Desenvolvimento Backend",
    "Banco de Talentos - TI - Estágios e Efetivos",
    "Software Engineering Intern",
    "Backend Internship 2026",
  ])("matches the real internship title %s", (title) => {
    expect(titleMatchesAny(title, required)).toBe(true);
  });

  it.each([
    ["Pessoa Coordenadora de Auditoria Interna", "interna"],
    ["Especialista de Controles Internos", "internos"],
    ["DevOps Engineer - International Project", "International"],
  ])("does not treat %s as an internship (was matching %s)", (title) => {
    expect(titleMatchesAny(title, required)).toBe(false);
  });
});

describe("titleMatchesAny — edges", () => {
  it("is false for an empty term list", () => {
    expect(titleMatchesAny("Estágio em Backend", [])).toBe(false);
  });

  it("ignores a term that normalizes to nothing, rather than matching everything", () => {
    // A punctuation-only term would normalize to "" and, unguarded, ` `
    // would be found in every padded title.
    expect(titleMatchesAny("Estágio em Backend", ["---"])).toBe(false);
  });
});

describe("keywordMatchesText — track keywords (ADR-011 Amendment 2)", () => {
  it.each([
    ["Estágio de Social Media", "soc"],
    ["ESTAGIÁRIO JURÍDICO (SOCIETÁRIO E NEGÓCIOS)", "soc"],
    ["Estágio em Design (Foco em Redes Sociais)", "soc"],
    ["Estagiário de Fisioterapia - Leblon", "api"],
    ["Estagiário de Direito | Auster Capital", "api"],
  ])("does not match %s against the short keyword %s", (title, keyword) => {
    expect(keywordMatchesText(title, keyword)).toBe(false);
  });

  it("still matches a short keyword standing as its own word", () => {
    expect(keywordMatchesText("Estágio SOC | Blue Team", "soc")).toBe(true);
    expect(keywordMatchesText("Estágio - API REST", "api")).toBe(true);
  });

  it("keeps hyphen-insensitivity, the reason substring matching existed", () => {
    // Both spellings of the title must match both spellings of the keyword.
    expect(keywordMatchesText("Back-End Developer", "back-end")).toBe(true);
    expect(keywordMatchesText("Backend Developer", "back-end")).toBe(true);
    expect(keywordMatchesText("Estágio Node.js", "node.js")).toBe(true);
    expect(keywordMatchesText("Estágio NodeJS", "node.js")).toBe(true);
    expect(keywordMatchesText("Pipeline CI/CD", "ci/cd")).toBe(true);
  });

  it("matches a multi-word exclusion phrase", () => {
    expect(
      keywordMatchesText(
        "ESTAGIÁRIO DE DESENVOLVIMENTO DE EMBALAGENS",
        "desenvolvimento de embalagens",
      ),
    ).toBe(true);
    expect(
      keywordMatchesText(
        "Estágio em Desenvolvimento Backend",
        "desenvolvimento de embalagens",
      ),
    ).toBe(false);
  });
});

describe("keywordMatchesText — punctuation that separates vs punctuation that joins", () => {
  // Both halves of this are real regressions, in opposite directions.
  //
  // Deleting all punctuation (the original collapsed pass) turned
  // "TI/Segurança" into the single token "tiseguranca", so `segurança` did
  // not match and a genuine security posting lost its track — with
  // `rejectUnknownTrack` on, discarded before any LLM saw it. Splitting on
  // all punctuation turns "Node.js" into "node js", so the alias `js`
  // matches it and inflates M10's JavaScript counts.
  it.each([
    ["Estágio TI/Segurança da Informação", "segurança"],
    ["Desenvolvimento/Automação", "automação"],
    ["Suporte/Infraestrutura", "infraestrutura"],
  ])("matches %s against a keyword separated only by a slash", (title, kw) => {
    expect(keywordMatchesText(title, kw)).toBe(true);
  });

  it.each([
    ["Node.js e React", "js"],
    ["Vue.js no front", "js"],
  ])("still does not match %s against the bare alias %s", (title, kw) => {
    expect(keywordMatchesText(title, kw)).toBe(false);
  });

  it("still matches the alias when it is genuinely its own word", () => {
    expect(keywordMatchesText("Noções de JS", "js")).toBe(true);
  });

  it("still collapses joining punctuation both ways", () => {
    expect(keywordMatchesText("Back-End Developer", "back-end")).toBe(true);
    expect(keywordMatchesText("Backend Developer", "back-end")).toBe(true);
    expect(keywordMatchesText("Node.js e React", "node.js")).toBe(true);
  });

  it("still refuses a short token inside an unrelated word", () => {
    expect(keywordMatchesText("Estágio em Fisioterapia", "api")).toBe(false);
    expect(keywordMatchesText("Redes sociais", "soc")).toBe(false);
  });
});

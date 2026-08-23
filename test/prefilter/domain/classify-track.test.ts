import { describe, expect, it } from "vitest";
import { classifyTrack } from "../../../src/prefilter/domain/classify-track";
import { computeTrackAlignment } from "../../../src/scoring/domain/score";
import { TrackWeights } from "../../../src/scoring/domain/types";

const tracks = {
  dev: ["backend", "back-end", "node"],
  security: ["segurança", "firewall"],
  automation: ["automação", "devops"],
};

const trackWeights: TrackWeights = {
  dev: 1.0,
  security: 1.0,
  automation: 0.7,
  unknown: 0.4,
};

describe("classifyTrack", () => {
  it("classifies a title matching one track's keywords", () => {
    expect(classifyTrack("Estágio em Desenvolvimento Backend", tracks)).toEqual(
      ["dev"],
    );
  });

  it("matches a hyphenated config keyword against an unhyphenated title", () => {
    expect(classifyTrack("Estágio Back-End Developer", tracks)).toEqual([
      "dev",
    ]);
  });

  it("returns an empty array when no track keyword matches", () => {
    expect(classifyTrack("Estágio Financeiro", tracks)).toEqual([]);
  });

  it("returns every track that matches, for a title spanning more than one", () => {
    const result = classifyTrack(
      "Estágio DevSecOps — Backend e Segurança",
      tracks,
    );
    expect(result.sort()).toEqual(["dev", "security"].sort());
  });

  it("is case-insensitive and accent-insensitive", () => {
    expect(classifyTrack("ESTÁGIO EM SEGURANÇA DA INFORMAÇÃO", tracks)).toEqual(
      ["security"],
    );
  });

  it("feeds directly into computeTrackAlignment", () => {
    const matched = classifyTrack("Estágio em Desenvolvimento Backend", tracks);
    expect(computeTrackAlignment(matched, trackWeights)).toBe(1.0);
  });

  it("an unmatched title falls back to the unknown weight via computeTrackAlignment", () => {
    const matched = classifyTrack("Estágio Financeiro", tracks);
    expect(computeTrackAlignment(matched, trackWeights)).toBe(0.4);
  });

  it("a multi-track match picks the highest weight via computeTrackAlignment", () => {
    const matched = classifyTrack(
      "Estágio DevSecOps — Automação e Segurança",
      tracks,
    );
    expect(computeTrackAlignment(matched, trackWeights)).toBe(1.0);
  });
});

/**
 * docs/11-known-issues.md B10. Both real postings found `track_unknown` in
 * production despite being genuinely on-track: CIEE's/Gupy's title-only
 * classification had no keyword for "degree name" or "database" phrasing,
 * only for the framework/language vocabulary a dev-focused title usually
 * uses.
 */
describe("classifyTrack — degree-name and database phrasing (B10)", () => {
  const devTracks = {
    dev: [
      "backend",
      "sistemas de informação",
      "ciência da computação",
      "redes de computadores",
      "banco de dados",
      "sql server",
    ],
    security: ["segurança"],
    automation: ["automação"],
  };

  it("classifies a CS/SI/networking catch-all degree list as dev", () => {
    expect(
      classifyTrack(
        "Estágio | Redes de Computadores, Sistemas de Informação, Ciência da Computação e afins",
        devTracks,
      ),
    ).toEqual(["dev"]);
  });

  it("classifies a database internship as dev", () => {
    expect(
      classifyTrack(
        "Estagiário em Banco de Dados SQL Server - Exclusiva Rio de Janeiro",
        devTracks,
      ),
    ).toEqual(["dev"]);
  });
});

/**
 * docs/11-known-issues.md B13's follow-up. Found by reading the real
 * postings the Indeed fix surfaced that the pre-filter still stopped at
 * track_unknown: two AI/data postings, and English "IT" — spelled with
 * different letters from Portuguese "ti", so it never matched that entry.
 */
describe("classifyTrack — AI/data phrasing and English 'IT' (B13 follow-up)", () => {
  const tracks = {
    dev: ["ia", "inteligência artificial"],
    security: [],
    automation: ["ti", "it"],
  };

  it("classifies bare 'IA' as dev", () => {
    expect(classifyTrack("Estagiário(a) em Dados e IA", tracks)).toEqual([
      "dev",
    ]);
  });

  it("classifies 'Inteligência Artificial' as dev", () => {
    expect(classifyTrack("Estágio em Inteligência Artificial", tracks)).toEqual(
      ["dev"],
    );
  });

  it("classifies English 'IT' as automation, distinct from Portuguese 'ti'", () => {
    expect(classifyTrack("IT Support Intern", tracks)).toEqual(["automation"]);
  });

  it("does not match 'ia' as a substring of an unrelated word", () => {
    // The exact false-positive shape this addition was checked against
    // before shipping: "ia" must not bleed into "Fisioterapia" or similar.
    expect(
      classifyTrack("Estagiário de Fisioterapia - Leblon", tracks),
    ).toEqual([]);
  });
});

/**
 * ADR-015. "Desenvolvimento" and "segurança" are the two most overloaded
 * words in Brazilian job titles, and both produced 1.0 track alignment on
 * postings hand-labelled 0 in the first calibration run.
 */
describe("classifyTrack — exclusions veto a keyword match", () => {
  const tracks = {
    dev: ["desenvolvimento", "backend"],
    security: ["segurança"],
    automation: ["devops"],
  };
  const exclusions = {
    dev: ["desenvolvimento de embalagens"],
    security: ["segurança do trabalho"],
    automation: [],
  };

  it("rejects packaging development despite the 'desenvolvimento' keyword", () => {
    expect(
      classifyTrack(
        "ESTAGIÁRIO DE DESENVOLVIMENTO DE EMBALAGENS",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });

  it("rejects occupational safety despite the 'segurança' keyword", () => {
    expect(
      classifyTrack(
        "ESTÁGIO - SEGURANÇA DO TRABALHO - JPGA",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });

  it("still classifies genuine software development", () => {
    expect(
      classifyTrack("Estágio em Desenvolvimento Backend", tracks, exclusions),
    ).toEqual(["dev"]);
  });

  it("matches exclusions regardless of accents and casing", () => {
    expect(
      classifyTrack("estagio de seguranca do trabalho", tracks, exclusions),
    ).toEqual([]);
  });

  it("treats omitted exclusions as no exclusions at all", () => {
    expect(classifyTrack("Estágio em Desenvolvimento Backend", tracks)).toEqual(
      ["dev"],
    );
  });
});

// Real false positives observed in the production corpus (2026-08-19,
// docs/11-known-issues.md B8): the canonical exclusion phrase existed
// already but a real title's wording did not literally match it — a
// reversed word order and a joining "e" lost to "&" normalization.
describe("classifyTrack — exclusion phrasing variants found in real postings", () => {
  const tracks = { dev: ["desenvolvimento"], security: [], automation: [] };
  const exclusions = {
    dev: [
      "pesquisa e desenvolvimento",
      "pesquisa desenvolvimento",
      "humano desenvolvimento",
    ],
    security: [],
    automation: [],
  };

  it("rejects a cosmetics R&D internship whose '&' loses the joining 'e'", () => {
    expect(
      classifyTrack(
        "Estagiário de Pesquisa & Desenvolvimento",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });

  it("rejects a Psychology internship where 'Humano Desenvolvimento' is the staffing agency's name, word order reversed", () => {
    expect(
      classifyTrack(
        "ESTAGIÁRIO NA ÁREA DE PSICOLOGIA - Sem experiência (Humano Desenvolvimento)",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });
});

/**
 * docs/11-known-issues.md B13's follow-up. Found while measuring why 0 of
 * 74 real Indeed candidates passed the pre-filter: real on-track titles
 * using vocabulary the keyword list had never needed before (an English
 * "IT" instead of Portuguese "ti", bare "IA"/"inteligência artificial").
 */
describe("classifyTrack — Indeed vocabulary gaps (B13 follow-up)", () => {
  const tracks = {
    dev: ["ia", "inteligência artificial"],
    security: [],
    automation: ["ti", "it"],
  };

  it("classifies English 'IT' as automation — different letters from Portuguese 'ti'", () => {
    expect(classifyTrack("IT Support Intern", tracks)).toEqual(["automation"]);
  });

  it("classifies bare 'IA' as dev", () => {
    expect(classifyTrack("Estagiário(a) em Dados e IA", tracks)).toEqual([
      "dev",
    ]);
  });

  it("classifies the full phrase 'inteligência artificial' as dev", () => {
    expect(classifyTrack("Estágio em Inteligência Artificial", tracks)).toEqual(
      ["dev"],
    );
  });

  it("does not let 'ia' bleed into an unrelated word ending the same way", () => {
    expect(
      classifyTrack("Estagiário de Fisioterapia - Leblon", tracks),
    ).toEqual([]);
    expect(classifyTrack("Estágio em Farmácia", tracks)).toEqual([]);
  });

  it("does not classify a bare 'tecnologia' mention that is only in the company's own name", () => {
    // Deliberately not added as a keyword: the word appearing in a company
    // name ("... Equipamentos de Energia Elétrica e Tecnologia") is not
    // evidence the posting itself is tech, the same shape B8 fixed once for
    // "(Humano Desenvolvimento)".
    const noTecnologia = { dev: [], security: [], automation: [] };
    expect(
      classifyTrack(
        "ESTAGIÁRIO NA ÁREA DE ENGENHARIA ELÉTRICA - Centro - Sem experiência (CET Brazil Equipamentos de Energia Elétrica e Tecnologia)",
        noTecnologia,
      ),
    ).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLinkedinAlertJob } from "../../../src/posting/infrastructure/linkedin-alert-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-16T13:00:00Z");

function rawPosting(payload: unknown, sourceId = "li-1"): RawPosting {
  return { source: "linkedin", sourceId, payload };
}

function fixture(): unknown[] {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "test", "fixtures", "linkedin-jobs.json"),
      "utf8",
    ),
  ) as unknown[];
}

describe("normalizeLinkedinAlertJob", () => {
  it("maps a well-formed alert job into a Posting", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({
        title: "Estágio Backend",
        company: "Empresa X",
        location: "Rio de Janeiro, RJ (Híbrido)",
        link: "https://www.linkedin.com/jobs/view/4100000009/",
      }),
      NOW,
    );

    expect(posting).not.toBeNull();
    expect(posting?.company).toBe("Empresa X");
    expect(posting?.title).toBe("Estágio Backend");
    expect(posting?.source).toBe("linkedin");
    expect(posting?.sourceUrl).toBe(
      "https://www.linkedin.com/jobs/view/4100000009/",
    );
  });

  it("sets firstSeenAt, lastSeenAt and collectedAt all to now", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({ title: "x", company: "Y" }),
      NOW,
    );
    expect(posting?.firstSeenAt).toEqual(NOW);
    expect(posting?.lastSeenAt).toEqual(NOW);
    expect(posting?.collectedAt).toEqual(NOW);
  });

  it("publishedAt is always null — the alert states send time, not a posting date", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({ title: "x", company: "Y" }),
      NOW,
    );
    expect(posting?.publishedAt).toBeNull();
  });

  it("description is always null — the alert email carries no job description", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({ title: "x", company: "Y" }),
      NOW,
    );
    expect(posting?.description).toBeNull();
  });

  describe("location and workMode — bundled in one string, split here", () => {
    it("splits 'Cidade, UF (Híbrido)' into a known city and hybrid mode", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({
          title: "x",
          company: "Y",
          location: "Rio de Janeiro, RJ (Híbrido)",
        }),
        NOW,
      );
      expect(posting?.location).toEqual({
        kind: "known",
        city: "Rio de Janeiro",
      });
      expect(posting?.workMode).toBe("hybrid");
    });

    it("splits 'Cidade, UF (Presencial)' into a known city and onsite mode", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({
          title: "x",
          company: "Y",
          location: "Niterói, RJ (Presencial)",
        }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "known", city: "Niterói" });
      expect(posting?.workMode).toBe("onsite");
    });

    it("maps 'Brasil (Remoto)' to an unknown location, not a literal city named Brasil", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({
          title: "x",
          company: "Y",
          location: "Brasil (Remoto)",
        }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "unknown" });
      expect(posting?.workMode).toBe("remote");
    });

    it("is unknown/unknown when location is absent", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({ title: "x", company: "Y", location: null }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "unknown" });
      expect(posting?.workMode).toBe("unknown");
    });

    // Behaviour deliberately changed (phase-1 review, 2026-08-29). This case
    // used to assert unknown/unknown, which threw away a city the string
    // states plainly. Only the work mode is genuinely absent here.
    it("keeps the city when the trailing parenthetical is missing entirely", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({
          title: "x",
          company: "Y",
          location: "Rio de Janeiro, RJ",
        }),
        NOW,
      );
      expect(posting?.location).toEqual({
        kind: "known",
        city: "Rio de Janeiro",
      });
      expect(posting?.workMode).toBe("unknown");
    });

    it("does not reject a hybrid posting outside the target metro area — that is the pre-filter's job", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({
          title: "x",
          company: "Y",
          location: "São Paulo, SP (Híbrido)",
        }),
        NOW,
      );
      expect(posting).not.toBeNull();
      expect(posting?.location).toEqual({ kind: "known", city: "São Paulo" });
      expect(posting?.workMode).toBe("hybrid");
    });
  });

  it("is null, not a thrown error, when company is absent", () => {
    const posting = normalizeLinkedinAlertJob(rawPosting({ title: "x" }), NOW);
    expect(posting).toBeNull();
  });

  it("is null when the payload fails schema validation entirely (no title)", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({ company: "Y" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("sourceUrl is null when link is absent", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({ title: "x", company: "Y" }),
      NOW,
    );
    expect(posting?.sourceUrl).toBeNull();
  });

  describe("docs/11-known-issues.md B15 — the real n8n row's shape", () => {
    it("parses Title-Case field names (Title/Company/Location/Link), not just lowercase", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({
          Title: "Programa de Estágio | Dados, Produtos & IA",
          Company: "Empresa Fictícia Núclea",
          Location: "São Paulo, SP (Híbrido)",
          Link: "https://www.linkedin.com/jobs/view/4451703964/",
          Subject: 'Fwd: "estagio software vagas anunciadas…"',
          ExtractedAt: "2026-08-16T18:36:00.019Z",
        }),
        NOW,
      );
      expect(posting).not.toBeNull();
      expect(posting?.title).toBe("Programa de Estágio | Dados, Produtos & IA");
      expect(posting?.company).toBe("Empresa Fictícia Núclea");
      expect(posting?.location).toEqual({ kind: "known", city: "São Paulo" });
      expect(posting?.workMode).toBe("hybrid");
    });

    it("derives sourceId from the link's /jobs/view/<id>/ path when the envelope's sourceId is empty", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting(
          {
            title: "Estágio Backend",
            company: "Empresa X",
            link: "https://www.linkedin.com/jobs/view/4451703964/",
          },
          "",
        ),
        NOW,
      );
      expect(posting).not.toBeNull();
      expect(posting?.sourceId).toBe("4451703964");
    });

    it("prefers a real envelope sourceId over deriving one from the link", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting(
          {
            title: "Estágio Backend",
            company: "Empresa X",
            link: "https://www.linkedin.com/jobs/view/4451703964/",
          },
          "li-real-id",
        ),
        NOW,
      );
      expect(posting?.sourceId).toBe("li-real-id");
    });

    it("is null, not a thrown error, when both sourceId and link are absent", () => {
      const posting = normalizeLinkedinAlertJob(
        rawPosting({ title: "Estágio Backend", company: "Empresa X" }, ""),
        NOW,
      );
      expect(posting).toBeNull();
    });
  });

  describe("against the curated real-shaped fixture", () => {
    it("normalizes every item in linkedin-jobs.json into a valid Posting", () => {
      const items = fixture();
      for (const item of items) {
        const posting = normalizeLinkedinAlertJob(rawPosting(item), NOW);
        expect(posting).not.toBeNull();
      }
    });

    it("keeps the remote item's location unknown and mode remote", () => {
      const items = fixture() as { location: string }[];
      const remoteItem = items.find((i) => i.location.startsWith("Brasil"));
      expect(remoteItem).toBeDefined();
      const posting = normalizeLinkedinAlertJob(rawPosting(remoteItem), NOW);
      expect(posting?.location).toEqual({ kind: "unknown" });
      expect(posting?.workMode).toBe("remote");
    });
  });
});

describe("work-mode labels arrive in the account's UI language, not Portuguese", () => {
  // Measured on production 2026-08-29: both real LinkedIn rows that have
  // ever landed carry an ENGLISH label — "Nova Iguacu, RJ (On-site)" and
  // "Rio de Janeiro, RJ (On-site)". The Portuguese-only mapper read
  // `unknown` for 100% of real input.
  it.each([
    ["Rio de Janeiro, RJ (On-site)", "onsite", "Rio de Janeiro"],
    ["Rio de Janeiro, RJ (Onsite)", "onsite", "Rio de Janeiro"],
    ["Sao Paulo, SP (Remote)", "remote", "Sao Paulo"],
    ["Sao Paulo, SP (Hybrid)", "hybrid", "Sao Paulo"],
    ["Rio de Janeiro, RJ (Presencial)", "onsite", "Rio de Janeiro"],
    ["Sao Paulo, SP (Remoto)", "remote", "Sao Paulo"],
    ["Sao Paulo, SP (H\u00edbrido)", "hybrid", "Sao Paulo"],
  ])("reads %s as %s", (location, workMode, city) => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({
        title: "Estagio Backend",
        company: "Empresa X",
        location,
        link: "https://www.linkedin.com/jobs/view/4100000009/",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe(workMode);
    expect(posting?.location).toEqual({ kind: "known", city });
  });

  // The consequence the mapper actually has to protect: `isLocationAllowed`
  // tests `workMode === "remote"` before the city list, so an unrecognized
  // label turns a remote posting outside the target cities into a
  // `location_not_allowed` rejection before any LLM call.
  it("keeps a remote out-of-region alert readable as remote", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({
        title: "Estagio Backend",
        company: "Empresa X",
        location: "Belo Horizonte, MG (Remote)",
        link: "https://www.linkedin.com/jobs/view/4100000010/",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("remote");
  });
});

describe("a location with no work-mode parenthetical still yields its city", () => {
  // The parenthetical used to be required by the regex, and its absence
  // discarded the city too — a fact plainly present in the string.
  it("reads the city and leaves only the work mode unknown", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({
        title: "Estagio Backend",
        company: "Empresa X",
        location: "Rio de Janeiro, RJ",
        link: "https://www.linkedin.com/jobs/view/4100000011/",
      }),
      NOW,
    );
    expect(posting?.location).toEqual({
      kind: "known",
      city: "Rio de Janeiro",
    });
    expect(posting?.workMode).toBe("unknown");
  });

  it("still maps a bare Brasil to an unknown location", () => {
    const posting = normalizeLinkedinAlertJob(
      rawPosting({
        title: "Estagio Backend",
        company: "Empresa X",
        location: "Brasil",
        link: "https://www.linkedin.com/jobs/view/4100000012/",
      }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "unknown" });
    expect(posting?.workMode).toBe("unknown");
  });
});

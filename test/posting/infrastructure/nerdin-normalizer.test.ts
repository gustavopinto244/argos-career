import { describe, expect, it } from "vitest";
import { normalizeNerdinJob } from "../../../src/posting/infrastructure/nerdin-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-27T12:00:00Z");

/** The shape of a real NerdIn JSON-LD JobPosting, verified against the live
 * capture (`npm run fixture:nerdin`, 2026-08-27). */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    "@type": "JobPosting",
    id: "98167",
    title: "ESTÁGIO | SUPORTE / TI",
    description: "Atividades do estágio.",
    datePosted: "2026-08-24T00:00:00",
    validThrough: "2026-09-23T23:59:59",
    employmentType: ["FULL_TIME"],
    hiringOrganization: { "@type": "Organization", name: "SystemHaus" },
    applicantLocationRequirements: { "@type": "Country", name: "BR" },
    identifier: { "@type": "PropertyValue", name: "Nerdin", value: "98167" },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Novo Hamburgo",
        addressCountry: "BR",
        addressRegion: "RS",
      },
    },
    jobUrl: "https://www.nerdin.com.br/vaga_emprego/x-98167.php",
    ...overrides,
  };
}

const raw = (overrides: Record<string, unknown> = {}): RawPosting => ({
  source: "nerdin",
  sourceId: "98167",
  payload: payload(overrides),
});

describe("normalizeNerdinJob (ADR-071)", () => {
  it("maps a real posting end to end", () => {
    const posting = normalizeNerdinJob(raw(), NOW);
    expect(posting).toMatchObject({
      source: "nerdin",
      sourceId: "98167",
      company: "SystemHaus",
      title: "ESTÁGIO | SUPORTE / TI",
      location: { kind: "known", city: "Novo Hamburgo" },
      country: "BR",
      workMode: "unknown",
    });
    expect(posting?.publishedAt?.getFullYear()).toBe(2026);
    expect(posting?.applicationDeadline).not.toBeNull();
  });

  it("returns null, never throws, when the payload is unusable", () => {
    expect(normalizeNerdinJob({ ...raw(), payload: null }, NOW)).toBeNull();
    expect(
      normalizeNerdinJob(
        { ...raw(), payload: payload({ title: undefined }) },
        NOW,
      ),
    ).toBeNull();
    expect(
      normalizeNerdinJob(
        { ...raw(), payload: payload({ hiringOrganization: null }) },
        NOW,
      ),
    ).toBeNull();
  });

  it("takes sourceId from the envelope, not the JSON-LD identifier", () => {
    // The two matched on every sample, but `identifier` may be a
    // PropertyValue object or NerdIn's internal key, and sourceId feeds
    // dedup — changing what it means later re-collects the whole corpus.
    const posting = normalizeNerdinJob(
      {
        source: "nerdin",
        sourceId: "from-href",
        payload: payload({ identifier: { value: "something-else" } }),
      },
      NOW,
    );
    expect(posting?.sourceId).toBe("from-href");
  });

  describe("workMode — source-declared only", () => {
    it("reads TELECOMMUTE as remote", () => {
      expect(
        normalizeNerdinJob(raw({ jobLocationType: "TELECOMMUTE" }), NOW)
          ?.workMode,
      ).toBe("remote");
    });

    it("reads it from an array too, since schema.org permits one", () => {
      expect(
        normalizeNerdinJob(raw({ jobLocationType: ["TELECOMMUTE"] }), NOW)
          ?.workMode,
      ).toBe("remote");
    });

    it("falls back to the home-office facet when the field is missing", () => {
      // The B18 defence: a posting served by NerdIn's own remote facet but
      // missing jobLocationType would otherwise be judged on the employer's
      // physical address and rejected on location.
      expect(
        normalizeNerdinJob(raw({ isRemoteQuery: true }), NOW)?.workMode,
      ).toBe("remote");
    });

    it("is unknown, not onsite, when the source says nothing", () => {
      expect(normalizeNerdinJob(raw(), NOW)?.workMode).toBe("unknown");
    });

    it("does not mine the title or description for 'home office'", () => {
      // CLAUDE.md §15 — prose is not a structural fact.
      const posting = normalizeNerdinJob(
        raw({
          title: "Estágio em TI (Home Office)",
          description: "Trabalho 100% remoto, home office.",
        }),
        NOW,
      );
      expect(posting?.workMode).toBe("unknown");
    });
  });

  describe("location — 'Home Office' is not a city", () => {
    it("maps the literal to unknown rather than a city named Home Office", () => {
      // A city of "Home Office" would be compared against
      // criteria.location.cities and rejected on location — docs/11 B18 —
      // and would also poison the fingerprint, which includes the city.
      const posting = normalizeNerdinJob(
        raw({
          jobLocationType: "TELECOMMUTE",
          jobLocation: {
            address: {
              addressLocality: "Home Office",
              addressRegion: "HO",
              addressCountry: "BR",
            },
          },
        }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "unknown" });
      expect(posting?.workMode).toBe("remote");
    });

    it("folds case and accents when recognising the literal", () => {
      for (const locality of [
        "home office",
        "HOME OFFICE",
        "Remoto",
        "Brasil",
      ]) {
        const posting = normalizeNerdinJob(
          raw({ jobLocation: { address: { addressLocality: locality } } }),
          NOW,
        );
        expect(posting?.location).toEqual({ kind: "unknown" });
      }
    });

    it("keeps a genuine city", () => {
      expect(
        normalizeNerdinJob(
          raw({ jobLocation: { address: { addressLocality: "Curitiba" } } }),
          NOW,
        )?.location,
      ).toEqual({ kind: "known", city: "Curitiba" });
    });

    it("takes the first Place when schema.org's array form is used", () => {
      const posting = normalizeNerdinJob(
        raw({
          jobLocation: [
            { address: { addressLocality: "Macaé", addressCountry: "BR" } },
            { address: { addressLocality: "Curitiba" } },
          ],
        }),
        NOW,
      );
      expect(posting?.location).toEqual({ kind: "known", city: "Macaé" });
    });
  });

  describe("country (ADR-068)", () => {
    it("reads a bare two-letter code", () => {
      expect(normalizeNerdinJob(raw(), NOW)?.country).toBe("BR");
    });

    it("reads schema.org's nested Country object", () => {
      expect(
        normalizeNerdinJob(
          raw({
            jobLocation: {
              address: { addressCountry: { "@type": "Country", name: "BR" } },
            },
          }),
          NOW,
        )?.country,
      ).toBe("BR");
    });

    it("falls back to applicantLocationRequirements", () => {
      expect(
        normalizeNerdinJob(
          raw({ jobLocation: { address: { addressLocality: "Curitiba" } } }),
          NOW,
        )?.country,
      ).toBe("BR");
    });

    it("rejects a country name rather than translating it", () => {
      const posting = normalizeNerdinJob(
        raw({
          jobLocation: { address: { addressCountry: "Brasil" } },
          applicantLocationRequirements: null,
        }),
        NOW,
      );
      expect(posting?.country).toBeNull();
    });
  });

  describe("description", () => {
    it("keeps plain text, which is what every sample actually was", () => {
      expect(normalizeNerdinJob(raw(), NOW)?.description).toBe(
        "Atividades do estágio.",
      );
    });

    it("strips tags so nothing executable reaches a prompt", () => {
      const posting = normalizeNerdinJob(
        raw({ description: "<p>Vaga</p><script>alert(1)</script>" }),
        NOW,
      );
      expect(posting?.description).not.toContain("<");
      expect(posting?.description).not.toContain("alert");
    });

    it("decodes entities and returns null for an empty result", () => {
      expect(
        normalizeNerdinJob(raw({ description: "A &amp; B" }), NOW)?.description,
      ).toBe("A & B");
      expect(
        normalizeNerdinJob(raw({ description: "   " }), NOW)?.description,
      ).toBeNull();
    });
  });

  it("returns null dates rather than NaN for unparseable values", () => {
    const posting = normalizeNerdinJob(
      raw({ datePosted: "not a date", validThrough: null }),
      NOW,
    );
    expect(posting?.publishedAt).toBeNull();
    expect(posting?.applicationDeadline).toBeNull();
  });

  it("does not read employmentType as a seniority signal", () => {
    // FULL_TIME on an internship says nothing about seniority, which is
    // stage A's output and stays null until then.
    expect(normalizeNerdinJob(raw(), NOW)?.seniority).toBeNull();
  });
});

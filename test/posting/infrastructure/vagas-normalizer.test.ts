import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeVagasJob } from "../../../src/posting/infrastructure/vagas-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-09-01T13:00:00Z");

function rawPosting(payload: unknown, sourceId = "20000001"): RawPosting {
  return { source: "vagas", sourceId, payload };
}

function fixture(): unknown[] {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "test", "fixtures", "vagas-jobs.json"),
      "utf8",
    ),
  ) as unknown[];
}

describe("normalizeVagasJob", () => {
  it("maps a well-formed job into a Posting", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        jobLocation: { address: { addressLocality: "Rio de Janeiro" } },
      }),
      NOW,
    );
    expect(posting).not.toBeNull();
    expect(posting?.company).toBe("Empresa X");
    expect(posting?.title).toBe("Estágio em TI");
    expect(posting?.location).toEqual({
      kind: "known",
      city: "Rio de Janeiro",
    });
  });

  it("is null, not a thrown error, when hiringOrganization/name is absent", () => {
    const posting = normalizeVagasJob(
      rawPosting({ id: "1", title: "Estágio em TI" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("is null when the payload fails schema validation entirely (no title)", () => {
    const posting = normalizeVagasJob(
      rawPosting({ id: "1", hiringOrganization: { name: "Empresa X" } }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("location is unknown when jobLocation/address is absent", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
      }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "unknown" });
  });

  it("workMode is remote when jobLocationType is TELECOMMUTE", () => {
    // Unlike InfoJobs, this is a real signal the source states directly —
    // no collector-side annotation of which facet was queried involved.
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        jobLocationType: "TELECOMMUTE",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("remote");
  });

  it("never infers onsite or hybrid from the absence of jobLocationType", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        description: "Modelo de trabalho: Híbrido (2x home office).",
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("unknown");
  });

  it('treats "Localização não informada" as unknown, not a literal city', () => {
    // Vagas.com's own placeholder text for a posting with no stated city,
    // observed verbatim on a real TELECOMMUTE posting.
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        jobLocationType: "TELECOMMUTE",
        jobLocation: {
          address: { addressLocality: "Localização não informada" },
        },
      }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "unknown" });
  });

  it("country is null when addressCountry is the full name, not an ISO code", () => {
    // Real, observed value is "Brasil", not "BR" — normalizeCountry only
    // accepts a two-letter code, and sourceDefaultCountry covers the rest.
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        jobLocation: {
          address: {
            addressLocality: "Rio de Janeiro",
            addressCountry: "Brasil",
          },
        },
      }),
      NOW,
    );
    expect(posting?.country).toBeNull();
  });

  it("strips any markup in description defensively", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        description: "Linha 1<script>alert(1)</script> Linha 2",
      }),
      NOW,
    );
    expect(posting?.description).toBe("Linha 1alert(1) Linha 2");
  });

  it("description is null when absent", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
      }),
      NOW,
    );
    expect(posting?.description).toBeNull();
  });

  it("parses datePosted and validThrough into publishedAt/applicationDeadline", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        datePosted: "2026-08-21",
        validThrough: "2026-09-21",
      }),
      NOW,
    );
    expect(posting?.publishedAt).toEqual(new Date("2026-08-21"));
    expect(posting?.applicationDeadline).toEqual(new Date("2026-09-21"));
  });

  it("publishedAt/applicationDeadline are null when absent, not thrown", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
      }),
      NOW,
    );
    expect(posting?.publishedAt).toBeNull();
    expect(posting?.applicationDeadline).toBeNull();
  });

  it("sourceUrl reads jobUrl", () => {
    const posting = normalizeVagasJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        jobUrl: "https://www.vagas.com.br/vagas/v1/estagio-ti",
      }),
      NOW,
    );
    expect(posting?.sourceUrl).toBe(
      "https://www.vagas.com.br/vagas/v1/estagio-ti",
    );
  });

  describe("against the curated real-shaped fixture", () => {
    it("normalizes every item in vagas-jobs.json into a valid Posting", () => {
      const items = fixture();
      for (const item of items) {
        const posting = normalizeVagasJob(rawPosting(item), NOW);
        expect(posting).not.toBeNull();
      }
    });

    it("keeps the Niterói item's real city", () => {
      const items = fixture() as {
        jobLocation?: { address?: { addressLocality?: string } };
      }[];
      const niteroiItem = items.find(
        (i) => i.jobLocation?.address?.addressLocality === "Niterói",
      );
      expect(niteroiItem).toBeDefined();
      const posting = normalizeVagasJob(rawPosting(niteroiItem), NOW);
      expect(posting?.location).toEqual({ kind: "known", city: "Niterói" });
    });

    it("reads the TELECOMMUTE item as remote with an unknown location", () => {
      const items = fixture() as { jobLocationType?: string }[];
      const remoteItem = items.find((i) => i.jobLocationType === "TELECOMMUTE");
      expect(remoteItem).toBeDefined();
      const posting = normalizeVagasJob(rawPosting(remoteItem), NOW);
      expect(posting?.workMode).toBe("remote");
      expect(posting?.location).toEqual({ kind: "unknown" });
    });
  });
});

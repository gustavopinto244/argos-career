import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeInfoJobsJob } from "../../../src/posting/infrastructure/infojobs-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-23T13:00:00Z");

function rawPosting(payload: unknown, sourceId = "10000001"): RawPosting {
  return { source: "infojobs", sourceId, payload };
}

function fixture(): unknown[] {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "test", "fixtures", "infojobs-jobs.json"),
      "utf8",
    ),
  ) as unknown[];
}

describe("normalizeInfoJobsJob", () => {
  it("maps a well-formed job into a Posting", () => {
    const posting = normalizeInfoJobsJob(
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
    const posting = normalizeInfoJobsJob(
      rawPosting({ id: "1", title: "Estágio em TI" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("is null when the payload fails schema validation entirely (no title)", () => {
    const posting = normalizeInfoJobsJob(
      rawPosting({ id: "1", hiringOrganization: { name: "Empresa X" } }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("location is unknown when jobLocation/address is absent", () => {
    const posting = normalizeInfoJobsJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
      }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "unknown" });
  });

  it("workMode is always unknown — InfoJobs states no structured remote/hybrid/onsite signal", () => {
    const posting = normalizeInfoJobsJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI | Home Office",
        hiringOrganization: { name: "Empresa X" },
      }),
      NOW,
    );
    expect(posting?.workMode).toBe("unknown");
  });

  it("converts <br> tags in description to newlines and strips any other tag", () => {
    const posting = normalizeInfoJobsJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        description: "Linha 1<br>Linha 2<br/>Linha 3<script>alert(1)</script>",
      }),
      NOW,
    );
    expect(posting?.description).toBe("Linha 1\nLinha 2\nLinha 3alert(1)");
  });

  it("description is null when absent", () => {
    const posting = normalizeInfoJobsJob(
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
    const posting = normalizeInfoJobsJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        datePosted: "2026-08-10T12:00:00.0000000",
        validThrough: "2026-11-10T12:00:00.0000000",
      }),
      NOW,
    );
    expect(posting?.publishedAt).toEqual(
      new Date("2026-08-10T12:00:00.0000000"),
    );
    expect(posting?.applicationDeadline).toEqual(
      new Date("2026-11-10T12:00:00.0000000"),
    );
  });

  it("publishedAt/applicationDeadline are null when absent, not thrown", () => {
    const posting = normalizeInfoJobsJob(
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
    const posting = normalizeInfoJobsJob(
      rawPosting({
        id: "1",
        title: "Estágio em TI",
        hiringOrganization: { name: "Empresa X" },
        jobUrl: "https://www.infojobs.com.br/vaga-de-estagio-ti__1.aspx",
      }),
      NOW,
    );
    expect(posting?.sourceUrl).toBe(
      "https://www.infojobs.com.br/vaga-de-estagio-ti__1.aspx",
    );
  });

  describe("against the curated real-shaped fixture", () => {
    it("normalizes every item in infojobs-jobs.json into a valid Posting", () => {
      const items = fixture();
      for (const item of items) {
        const posting = normalizeInfoJobsJob(rawPosting(item), NOW);
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
      const posting = normalizeInfoJobsJob(rawPosting(niteroiItem), NOW);
      expect(posting?.location).toEqual({ kind: "known", city: "Niterói" });
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RawPosting } from "../../../src/posting/domain/raw-posting";
import { normalizeNinetyNineJobsJob } from "../../../src/posting/infrastructure/ninetyninejobs-normalizer";

const NOW = new Date("2026-10-04T12:00:00Z");
const jobs = JSON.parse(
  readFileSync(
    join(process.cwd(), "test", "fixtures", "99jobs-jobs.json"),
    "utf8",
  ),
) as unknown[];

function raw(payload: unknown, sourceId = "900001"): RawPosting {
  return { source: "99jobs", sourceId, payload };
}

describe("normalizeNinetyNineJobsJob", () => {
  it("maps the curated JSON-LD projection and cleans encoded HTML", () => {
    const posting = normalizeNinetyNineJobsJob(raw(jobs[0]), NOW);
    expect(posting).not.toBeNull();
    expect(posting?.company).toBe("Empresa Fictícia Um");
    expect(posting?.description).toBe(
      "Desenvolva APIs.\nConhecimento em TypeScript.",
    );
    expect(posting?.location).toEqual({
      kind: "known",
      city: "Rio de Janeiro",
    });
    expect(posting?.workMode).toBe("hybrid");
    expect(posting?.country).toBe("BR");
    expect(posting?.publishedAt?.toISOString()).toBe(
      "2026-10-01T13:30:00.000Z",
    );
  });

  it("keeps a remote SPA posting with unknown location", () => {
    const posting = normalizeNinetyNineJobsJob(raw(jobs[1], "900002"), NOW);
    expect(posting?.workMode).toBe("remote");
    expect(posting?.location).toEqual({ kind: "unknown" });
  });

  it("returns null rather than throwing for an invalid payload", () => {
    expect(normalizeNinetyNineJobsJob(raw({ id: "x" }), NOW)).toBeNull();
  });
});

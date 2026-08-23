import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import { Profile } from "../../../src/profile/domain/profile";
import { buildScorer } from "../../../src/scoring/infrastructure/build-scorer";
import { ApiScorer } from "../../../src/scoring/infrastructure/api-scorer";
import { StubScorer } from "../../../src/scoring/infrastructure/stub-scorer";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-build-scorer-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SCORER_ADAPTER;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
});

function criteria(): Criteria {
  return {
    collection: {
      queries: [{ source: "gupy" }],
      queryIntervalMs: 0,
      recencyDays: 1,
      backfillDays: 7,
    },
    titleBlocklist: [],
    titleRequired: ["estágio"],
    location: { cities: [], allowRemote: true, nationwideSources: [] },
    blockedCompanies: [],
    minKeywordAdherence: 0,
    maxAgeDays: null,
    undatedBacklogCutoverAt: null,
    maxFutureSkewDays: 1,
    tracks: { dev: ["backend"], security: [], automation: [] },
    trackExclusions: { dev: [], security: [], automation: [] },
    rejectUnknownTrack: false,
    schedule: {
      collection: { intervalHours: 4 },
      scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    },
    alerts: {
      consecutiveEmptyCollectionRuns: 2,
      scoreFailureRateThreshold: 0.5,
    },
    trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, unknown: 0.4 },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
      unknownTrackCapScore: 50,
      stageBConcurrency: 8,
      ignoredProviders: [],
    },
  };
}

function profile(): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 700",
    maxWeeklyHours: "40",
    workAvailability: "40h remoto, disponível dias úteis.",
    competencies: [
      {
        name: "Node.js",
        tracks: ["dev"],
        aliases: [],
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

describe("buildScorer", () => {
  it("defaults to StubScorer when SCORER_ADAPTER is unset", () => {
    const result = buildScorer(db, criteria(), profile());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scorer).toBeInstanceOf(StubScorer);
  });

  it("builds a StubScorer explicitly", () => {
    process.env.SCORER_ADAPTER = "stub";
    const result = buildScorer(db, criteria(), profile());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scorer).toBeInstanceOf(StubScorer);
  });

  it("fails with a named reason when SCORER_ADAPTER=api is missing LLM_API_KEY", () => {
    process.env.SCORER_ADAPTER = "api";
    process.env.LLM_MODEL = "deepseek/deepseek-v4-flash-0731";
    const result = buildScorer(db, criteria(), profile());
    expect(result).toEqual({
      ok: false,
      error: "SCORER_ADAPTER=api requires LLM_API_KEY and LLM_MODEL (ADR-012)",
    });
  });

  it("builds an ApiScorer when SCORER_ADAPTER=api has both required vars", () => {
    process.env.SCORER_ADAPTER = "api";
    process.env.LLM_API_KEY = "sk-or-v1-test";
    process.env.LLM_MODEL = "deepseek/deepseek-v4-flash-0731";
    const result = buildScorer(db, criteria(), profile());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scorer).toBeInstanceOf(ApiScorer);
    }
  });

  it("exposes getUsage for the api adapter (docs/audit AC-015)", () => {
    process.env.SCORER_ADAPTER = "api";
    process.env.LLM_API_KEY = "sk-or-v1-test";
    process.env.LLM_MODEL = "deepseek/deepseek-v4-flash-0731";
    const result = buildScorer(db, criteria(), profile());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.getUsage).toBeTypeOf("function");
      // No calls made yet — a fresh client's totals are all zero.
      expect(result.getUsage?.()).toMatchObject({ calls: 0, attempts: 0 });
    }
  });

  it("does not expose getUsage for the stub adapter — nothing to report", () => {
    const result = buildScorer(db, criteria(), profile());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.getUsage).toBeUndefined();
  });

  it("fails with a named reason for an unknown adapter", () => {
    process.env.SCORER_ADAPTER = "magic";
    const result = buildScorer(db, criteria(), profile());
    expect(result).toEqual({
      ok: false,
      error:
        'SCORER_ADAPTER=magic is not implemented — "stub" and "api" are the only adapters (ADR-016)',
    });
  });
});

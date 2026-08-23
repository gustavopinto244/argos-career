import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { ExtractionsRepository } from "../../../src/persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../../../src/persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../../../src/persistence/infrastructure/postings-repository";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import { Profile } from "../../../src/profile/domain/profile";
import { ApiScorer } from "../../../src/scoring/infrastructure/api-scorer";
import { LlmTransportError } from "../../../src/scoring/infrastructure/openrouter-client";
import { StageAExtractor } from "../../../src/scoring/infrastructure/stage-a-extractor";
import { StageBMatcher } from "../../../src/scoring/infrastructure/stage-b-matcher";

let dir: string;
let db: Db;
let extractionsRepo: ExtractionsRepository;
let matchesRepo: MatchesRepository;
let postingsRepo: PostingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-api-scorer-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  extractionsRepo = new ExtractionsRepository(db);
  matchesRepo = new MatchesRepository(db);
  postingsRepo = new PostingsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-14T03:00:00Z");

function posting() {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    description: "Buscamos estagiário com conhecimento em Node.js.",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
}

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
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
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

function extractionResponse(): string {
  return JSON.stringify({
    requirements: [
      { text: "Node.js", category: "language", weight: "mandatory" },
    ],
    seniority: "internship",
    experienceYears: null,
  });
}

function buildScorer(ask: (prompt: string) => Promise<string>): ApiScorer {
  const extractor = new StageAExtractor(ask, extractionsRepo);
  const matcher = new StageBMatcher(ask, matchesRepo);
  return new ApiScorer(extractor, matcher, profile(), criteria(), postingsRepo);
}

describe("ApiScorer.score", () => {
  it("runs extraction then matching then stage C, and classifies the track deterministically", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(extractionResponse())
      .mockResolvedValueOnce(
        '{"status":"met","evidence":"Built a Node.js service."}',
      );

    const scorer = buildScorer(ask);
    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.breakdown.mandatoryCoverage).toBe(1);
      expect(result.breakdown.trackAlignment).toBe(1.0);
      expect(result.lowConfidence).toBe(false);
      expect(result.recommendedVariant).toBe("backend");
      expect(result.highlights).toEqual(["Built a Node.js service."]);
      expect(result.missingTerms).toEqual([]);
    }
  });

  it("writes the extracted seniority and experienceYears back onto the posting row", async () => {
    postingsRepo.upsert(posting());
    const ask = vi
      .fn()
      .mockResolvedValueOnce(extractionResponse())
      .mockResolvedValueOnce(
        '{"status":"met","evidence":"Built a Node.js service."}',
      );

    const scorer = buildScorer(ask);
    await scorer.score(posting(), "profile-hash-1");

    const stored = postingsRepo.findByFingerprint(posting().fingerprint);
    expect(stored?.seniority).toBe("internship");
    expect(stored?.experienceYears).toBeNull();
  });

  it("returns ok:false with the extraction failure reason without calling the matcher", async () => {
    const ask = vi.fn(async () => "not json");
    const matchSpy = vi.spyOn(StageBMatcher.prototype, "match");

    const scorer = buildScorer(ask);
    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result).toEqual({
      ok: false,
      reason: "extraction_failed",
      attempts: 3,
      permanent: false,
      diagnostic: {
        stage: "stage-a",
        kind: "output_invalid_json",
        lastAttemptLatencyMs: expect.any(Number),
      },
    });
    expect(matchSpy).not.toHaveBeenCalled();
    matchSpy.mockRestore();
  });

  it("returns ok:false with the matching failure reason", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(extractionResponse())
      .mockResolvedValue("not json");

    const scorer = buildScorer(ask);
    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result).toEqual({
      ok: false,
      reason: "matching_failed",
      attempts: 3,
      permanent: false,
      diagnostic: {
        stage: "stage-b",
        kind: "output_invalid_json",
        lastAttemptLatencyMs: expect.any(Number),
      },
    });
  });

  it("marks extraction failure permanent when the underlying cause is a permanent transport error (docs/audit PR-007)", async () => {
    const ask = vi.fn(async () => {
      throw new LlmTransportError("revoked key", "authError");
    });

    const scorer = buildScorer(ask);
    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result).toEqual({
      ok: false,
      reason: "extraction_failed",
      attempts: 1,
      permanent: true,
      diagnostic: {
        stage: "stage-a",
        kind: "permanent_error",
        category: "authError",
        lastAttemptLatencyMs: expect.any(Number),
      },
    });
  });

  it("marks matching failure permanent when the underlying cause is a permanent transport error", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(extractionResponse())
      .mockImplementation(async () => {
        throw new LlmTransportError("unsupported model", "configError");
      });

    const scorer = buildScorer(ask);
    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result).toEqual({
      ok: false,
      reason: "matching_failed",
      attempts: 1,
      permanent: true,
      diagnostic: {
        stage: "stage-b",
        kind: "permanent_error",
        category: "configError",
        lastAttemptLatencyMs: expect.any(Number),
      },
    });
  });

  it("caps the verdict at review with lowConfidence when extraction returns nothing", async () => {
    const ask = vi.fn(
      async () => '{"requirements":[],"seniority":null,"experienceYears":null}',
    );

    const scorer = buildScorer(ask);
    const result = await scorer.score(posting(), "profile-hash-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lowConfidence).toBe(true);
      expect(result.verdict).not.toBe("apply");
    }
  });
});

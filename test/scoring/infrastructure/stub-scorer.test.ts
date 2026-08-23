import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import { StubScorer } from "../../../src/scoring/infrastructure/stub-scorer";

const NOW = new Date("2026-08-14T03:00:00Z");

function criteria(overrides: Partial<Criteria> = {}): Criteria {
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
    tracks: {
      dev: ["backend"],
      security: ["segurança"],
      automation: ["automação"],
    },
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
    ...overrides,
  };
}

function posting(title: string) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title,
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
}

describe("StubScorer", () => {
  it("never throws and never calls an LLM — returns ok: true synchronously derived from stage C", async () => {
    const scorer = new StubScorer(criteria());
    const result = await scorer.score(posting("Estágio Backend"), "hash");
    expect(result.ok).toBe(true);
  });

  it("gives full mandatory and desirable coverage — nothing was extracted to fail", async () => {
    const scorer = new StubScorer(criteria());
    const result = await scorer.score(posting("Estágio Backend"), "hash");
    if (!result.ok) throw new Error("expected ok result");
    expect(result.breakdown.mandatoryCoverage).toBe(1);
    expect(result.breakdown.desirableCoverage).toBe(1);
  });

  it("flags lowConfidence — zero requirements were extracted", async () => {
    const scorer = new StubScorer(criteria());
    const result = await scorer.score(posting("Estágio Backend"), "hash");
    if (!result.ok) throw new Error("expected ok result");
    expect(result.lowConfidence).toBe(true);
  });

  it("never returns verdict 'apply' — lowConfidence caps it at review", async () => {
    const scorer = new StubScorer(criteria());
    const result = await scorer.score(posting("Estágio Backend"), "hash");
    if (!result.ok) throw new Error("expected ok result");
    expect(result.verdict).not.toBe("apply");
  });

  it("classifies the track from the real title and reflects it in trackAlignment", async () => {
    const devScorer = new StubScorer(criteria());
    const devResult = await devScorer.score(posting("Estágio Backend"), "hash");
    const unknownResult = await devScorer.score(
      posting("Estágio Financeiro"),
      "hash",
    );

    if (!devResult.ok || !unknownResult.ok)
      throw new Error("expected ok results");
    expect(devResult.breakdown.trackAlignment).toBe(1.0);
    expect(unknownResult.breakdown.trackAlignment).toBe(0.4);
  });

  it("has no blockingFailure — there are no blocking requirements to fail", async () => {
    const scorer = new StubScorer(criteria());
    const result = await scorer.score(posting("Estágio Backend"), "hash");
    if (!result.ok) throw new Error("expected ok result");
    expect(result.blockingFailure).toBeNull();
  });
});

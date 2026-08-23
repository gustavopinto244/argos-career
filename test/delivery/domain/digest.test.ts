import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { ScoreOutcome } from "../../../src/scoring/domain/types";
import {
  EMPTY_RECOMMENDATION,
  Recommendation,
} from "../../../src/scoring/domain/recommendation";
import {
  composeDigest,
  ScoredPosting,
} from "../../../src/delivery/domain/digest";

const NOW = new Date("2026-08-14T03:00:00Z");

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    sourceUrl: "https://example.org/vagas/1",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

function outcome(
  overrides: Partial<ScoreOutcome & Recommendation> = {},
): ScoreOutcome & Recommendation {
  return {
    score: 50,
    verdict: "review",
    breakdown: {
      mandatoryCoverage: 1,
      desirableCoverage: 1,
      trackAlignment: 1,
    },
    blockingFailure: null,
    blockingFailures: [],
    lowConfidence: true,
    criticalGaps: [],
    periodGate: null,
    ...EMPTY_RECOMMENDATION,
    ...overrides,
  };
}

function scored(overrides: Partial<ScoredPosting> = {}): ScoredPosting {
  return { posting: posting(), outcome: outcome(), ...overrides };
}

describe("composeDigest", () => {
  it("buckets an apply-verdict posting into recommended", () => {
    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [scored({ outcome: outcome({ verdict: "apply", score: 80 }) })],
      periodBlocked: [],
      summary: {
        collected: 1,
        deduplicated: 1,
        filtered: 1,
        scored: 1,
        failedSources: [],
        truncatedSources: [],
      },
    });

    expect(digest.recommended).toHaveLength(1);
    expect(digest.review).toHaveLength(0);
  });

  it("buckets a review-verdict posting into review", () => {
    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [scored({ outcome: outcome({ verdict: "review" }) })],
      periodBlocked: [],
      summary: {
        collected: 1,
        deduplicated: 1,
        filtered: 1,
        scored: 1,
        failedSources: [],
        truncatedSources: [],
      },
    });

    expect(digest.review).toHaveLength(1);
    expect(digest.recommended).toHaveLength(0);
  });

  it("drops a discard-verdict posting from both sections — still in the corpus, not the digest", () => {
    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [scored({ outcome: outcome({ verdict: "discard", score: 10 }) })],
      periodBlocked: [],
      summary: {
        collected: 1,
        deduplicated: 1,
        filtered: 1,
        scored: 1,
        failedSources: [],
        truncatedSources: [],
      },
    });

    expect(digest.recommended).toHaveLength(0);
    expect(digest.review).toHaveLength(0);
  });

  it("carries periodBlocked and summary through unchanged", () => {
    const periodBlocked = [
      { posting: posting({ sourceId: "2" }), opensAtLabel: "2027.1" },
    ];
    const summary = {
      collected: 5,
      deduplicated: 4,
      filtered: 3,
      scored: 3,
      failedSources: ["gupy"],
      truncatedSources: [],
    };

    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [],
      periodBlocked,
      summary,
    });

    expect(digest.periodBlocked).toEqual(periodBlocked);
    expect(digest.summary).toEqual(summary);
  });

  it("orders recommended postings by score, highest first — not input order", () => {
    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [
        scored({
          posting: posting({ sourceId: "low" }),
          outcome: outcome({ verdict: "apply", score: 71 }),
        }),
        scored({
          posting: posting({ sourceId: "high" }),
          outcome: outcome({ verdict: "apply", score: 98 }),
        }),
        scored({
          posting: posting({ sourceId: "mid" }),
          outcome: outcome({ verdict: "apply", score: 85 }),
        }),
      ],
      periodBlocked: [],
      summary: {
        collected: 3,
        deduplicated: 3,
        filtered: 3,
        scored: 3,
        failedSources: [],
        truncatedSources: [],
      },
    });

    expect(digest.recommended.map((e) => e.posting.sourceId)).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("orders the review section by score too, independently of recommended", () => {
    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [
        scored({
          posting: posting({ sourceId: "r-low" }),
          outcome: outcome({ verdict: "review", score: 45 }),
        }),
        scored({
          posting: posting({ sourceId: "r-high" }),
          outcome: outcome({ verdict: "review", score: 68 }),
        }),
      ],
      periodBlocked: [],
      summary: {
        collected: 2,
        deduplicated: 2,
        filtered: 2,
        scored: 2,
        failedSources: [],
        truncatedSources: [],
      },
    });

    expect(digest.review.map((e) => e.posting.sourceId)).toEqual([
      "r-high",
      "r-low",
    ]);
  });

  it("keeps input order for postings tied on score (stable sort)", () => {
    const digest = composeDigest({
      runId: "run-1",
      generatedAt: NOW,
      scored: [
        scored({
          posting: posting({ sourceId: "first" }),
          outcome: outcome({ verdict: "apply", score: 90 }),
        }),
        scored({
          posting: posting({ sourceId: "second" }),
          outcome: outcome({ verdict: "apply", score: 90 }),
        }),
      ],
      periodBlocked: [],
      summary: {
        collected: 2,
        deduplicated: 2,
        filtered: 2,
        scored: 2,
        failedSources: [],
        truncatedSources: [],
      },
    });

    expect(digest.recommended.map((e) => e.posting.sourceId)).toEqual([
      "first",
      "second",
    ]);
  });
});

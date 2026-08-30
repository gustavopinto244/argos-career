import { describe, expect, it } from "vitest";
import { RunRow } from "../../../src/persistence/infrastructure/runs-repository";
import {
  evaluateCollectionHealth,
  evaluateDeliveryOutcome,
  evaluateMissedRuns,
  evaluateSourceFreshness,
  MissedRunConfig,
} from "../../../src/scheduling/domain/alerts";

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    runId: "run-1",
    kind: "collect",
    triggeredBy: "internal",
    startedAt: new Date("2026-08-15T10:00:00Z"),
    finishedAt: new Date("2026-08-15T10:01:00Z"),
    outcome: "success",
    collectedCount: 0,
    normalizedCount: 0,
    newCount: 0,
    alreadySeenCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    scoredCount: 0,
    deliveredCount: 0,
    tooOldCount: 0,
    unnormalizableCount: 0,
    receivedCount: 0,
    schemaRejectedCount: 0,
    failureReason: null,
    failedSources: null,
    truncatedSources: null,
    attemptedSources: null,
    sourceQueryStats: null,
    llmAttempts: 0,
    llmCostUsd: 0,
    llmAttemptsWithoutUsage: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmCachedPromptTokens: 0,
    llmBlockedByCircuit: 0,
    llmOutcomeCounts: null,
    llmStageOutcomeCounts: null,
    llmProviderCounts: null,
    llmErrorTypeCounts: null,
    scoreFailureCounts: null,
    ...overrides,
  };
}

describe("evaluateCollectionHealth", () => {
  it("does not alert when fewer runs than the threshold exist yet", () => {
    const runs = [run({ collectedCount: 0 })];
    expect(evaluateCollectionHealth(runs, 2)).toEqual([]);
  });

  it("alerts on N consecutive empty (but successful) runs", () => {
    const runs = [
      run({ runId: "3", collectedCount: 0 }),
      run({ runId: "2", collectedCount: 0 }),
      run({ runId: "1", collectedCount: 5 }),
    ];
    const alerts = evaluateCollectionHealth(runs, 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain(
      "2 consecutive collection runs found zero postings",
    );
  });

  it("does not alert on empty runs short of the threshold", () => {
    const runs = [
      run({ runId: "2", collectedCount: 0 }),
      run({ runId: "1", collectedCount: 5 }),
    ];
    expect(evaluateCollectionHealth(runs, 2)).toEqual([]);
  });

  it("alerts on N consecutive errored runs, independently of the empty check", () => {
    const runs = [
      run({ runId: "2", outcome: "failed", collectedCount: 0 }),
      run({ runId: "1", outcome: "failed", collectedCount: 0 }),
    ];
    const alerts = evaluateCollectionHealth(runs, 2);
    const texts = alerts.map((a) => a.text);
    expect(texts.some((t) => t.includes("errored"))).toBe(true);
    // A failed run's collectedCount is 0 but outcome isn't "success", so the
    // empty-run alert (which requires outcome === "success") must not also fire.
    expect(texts.some((t) => t.includes("found zero postings"))).toBe(false);
  });

  it("does not alert when the most recent run recovered", () => {
    const runs = [
      run({ runId: "3", collectedCount: 5 }),
      run({ runId: "2", collectedCount: 0 }),
      run({ runId: "1", collectedCount: 0 }),
    ];
    expect(evaluateCollectionHealth(runs, 2)).toEqual([]);
  });
});

describe("evaluateDeliveryOutcome", () => {
  it("alerts when the run itself failed", () => {
    const alerts = evaluateDeliveryOutcome(run({ outcome: "failed" }), 0.5);
    expect(alerts.some((a) => a.text.includes("Delivery failed"))).toBe(true);
  });

  it("does not alert on a successful run with no scoring failures", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 10, scoredCount: 10 }),
      0.5,
    );
    expect(alerts).toEqual([]);
  });

  it("alerts on digest impact regardless of the health threshold", () => {
    const alerts = evaluateDeliveryOutcome(
      run({
        filteredCount: 10,
        scoredCount: 4,
        scoreFailureCounts: JSON.stringify({ extraction_failed: 6 }),
      }),
      0.5,
    );
    expect(alerts).toEqual([
      {
        key: "scoring:impact",
        text: "Scoring impact on run run-1: 6/10 postings were left without a score (extraction_failed=6).",
      },
    ]);
    expect(alerts[0]?.text).not.toContain("regression");
  });

  it("still reports one affected posting in a small sample", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 10, scoredCount: 9 }), // 10% failed
      0.5,
    );
    expect(alerts[0]?.text).toContain(
      "1/10 postings were left without a score",
    );
  });

  it("separately reports scorer health with enough accounted attempts", () => {
    const alerts = evaluateDeliveryOutcome(
      run({
        filteredCount: 3,
        scoredCount: 1,
        llmAttempts: 23,
        llmOutcomeCounts: JSON.stringify({
          success: 9,
          timeout: 4,
          providerError: 10,
        }),
        llmProviderCounts: JSON.stringify({ Chutes: 14, DeepInfra: 9 }),
        llmErrorTypeCounts: JSON.stringify({ provider_unavailable: 10 }),
        scoreFailureCounts: JSON.stringify({ extraction_failed: 2 }),
      }),
      0.5,
    );

    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain("14/23 LLM operations failed (61%)");
    expect(alerts[1]?.text).toContain("provider_unavailable=10");
    expect(alerts[1]?.text).not.toContain("regression");
  });

  it("does not divide by zero when nothing passed the pre-filter", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ filteredCount: 0, scoredCount: 0 }),
      0.5,
    );
    expect(alerts).toEqual([]);
  });

  it("can report both a failed run and a high failure rate together", () => {
    const alerts = evaluateDeliveryOutcome(
      run({ outcome: "failed", filteredCount: 10, scoredCount: 0 }),
      0.5,
    );
    expect(alerts).toHaveLength(2);
  });
});

describe("evaluateMissedRuns", () => {
  const config: MissedRunConfig = {
    scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    collection: { intervalHours: 4 },
  };

  it("does not alert before today's scheduled deliver time has passed", () => {
    // 01:00 America/Sao_Paulo = 04:00 UTC, before the 03:00 threshold.
    const now = new Date("2026-08-15T04:00:00Z");
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-14T06:00:00Z"),
    });
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(false);
  });

  it("alerts on the first missed scoreAndDeliver run, after the scheduled time", () => {
    // 10:00 America/Sao_Paulo = 13:00 UTC, well past 03:00.
    const now = new Date("2026-08-15T13:00:00Z");
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-14T06:00:00Z"), // yesterday
    });
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(true);
  });

  it("does not alert once today's deliver run has already succeeded", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    // Finished today (2026-08-15 in America/Sao_Paulo, ~10:00 local).
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(false);
  });

  it("alerts when no scoreAndDeliver run has ever succeeded, past the scheduled time", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastCollect = run({ finishedAt: now });
    const alerts = evaluateMissedRuns(now, null, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("no digest"))).toBe(true);
  });

  it("does not alert on a collection gap under two intervals", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastCollect = run({
      finishedAt: new Date("2026-08-15T11:00:00Z"), // 2h ago, < 8h threshold
    });
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("collection run"))).toBe(false);
  });

  it("alerts once the collection gap reaches two intervals (self-heals otherwise)", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastCollect = run({
      finishedAt: new Date("2026-08-15T04:00:00Z"), // 9h ago, > 8h threshold
    });
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const alerts = evaluateMissedRuns(now, lastDeliver, lastCollect, config);
    expect(alerts.some((a) => a.text.includes("collection run"))).toBe(true);
  });

  it("alerts when no collection run has ever succeeded", () => {
    const now = new Date("2026-08-15T13:00:00Z");
    const lastDeliver = run({
      kind: "scoreAndDeliver",
      finishedAt: new Date("2026-08-15T09:00:00Z"),
    });
    const alerts = evaluateMissedRuns(now, lastDeliver, null, config);
    expect(alerts.some((a) => a.text.includes("collection run"))).toBe(true);
  });
});

describe("evaluateSourceFreshness (docs/11-known-issues.md B13)", () => {
  const NOW = new Date("2026-08-22T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

  it("is silent when every configured source is within its window", () => {
    expect(
      evaluateSourceFreshness(
        NOW,
        { gupy: hoursAgo(3), indeed: hoursAgo(10) },
        { gupy: 72, indeed: 36 },
      ),
    ).toEqual([]);
  });

  it("alerts on the real B13 scenario: a pushed source silent for days while pulled ones are fine", () => {
    // Indeed's systemd timer had never fired; gupy/ciee kept succeeding, so
    // every run-log-based check reported green. This is the signal that
    // would have caught it.
    const alerts = evaluateSourceFreshness(
      NOW,
      { gupy: hoursAgo(2), ciee: hoursAgo(1), indeed: hoursAgo(144) },
      { gupy: 72, ciee: 72, indeed: 36 },
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('"indeed"');
    expect(alerts[0]?.text).toContain("144h");
    expect(alerts[0]?.text).toContain("36h");
  });

  it("distinguishes a source that has NEVER delivered from one that went stale", () => {
    // "never" is a deployment problem (B14's Catho), "stale" an operational
    // one (B13's Indeed) — an operator sent to the wrong one wastes the
    // trip.
    const [neverAlert] = evaluateSourceFreshness(NOW, {}, { catho: 36 });
    expect(neverAlert?.text).toContain("never delivered");
    expect(neverAlert?.text).toContain("not deployed");

    const [staleAlert] = evaluateSourceFreshness(
      NOW,
      { indeed: hoursAgo(100) },
      { indeed: 36 },
    );
    expect(staleAlert?.text).toContain("delivered nothing for");
    expect(staleAlert?.text).not.toContain("never delivered");
  });

  it("does not check a source with no configured expectation", () => {
    // An unlisted source is dormant-by-choice, not broken — listing every
    // known source would alert forever about decisions nobody has made.
    expect(
      evaluateSourceFreshness(
        NOW,
        { catho: hoursAgo(9999), gupy: hoursAgo(1) },
        { gupy: 72 },
      ),
    ).toEqual([]);
  });

  it("reports every stale source, in a stable order", () => {
    const alerts = evaluateSourceFreshness(
      NOW,
      { indeed: hoursAgo(200), gupy: hoursAgo(200) },
      { indeed: 36, gupy: 72 },
    );
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.text).toContain('"gupy"');
    expect(alerts[1]?.text).toContain('"indeed"');
  });
});

describe("collection-health alerts must not name a single source (2026-08-30)", () => {
  // Both messages used to be prefixed `gupy:` — true when written and Gupy
  // was the only collector, stale since. `config/criteria.yaml` now issues 20
  // queries across four pulled sources, and one `collect` run covers all of
  // them. An operator woken by "gupy: 3 consecutive collection runs errored"
  // would go and check the one source that may have been fine.
  it("does not name gupy when every source found nothing", () => {
    const alerts = evaluateCollectionHealth(
      [run({ collectedCount: 0 }), run({ collectedCount: 0 })],
      2,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).not.toContain("gupy");
    expect(alerts[0]?.text).toContain("across every source");
    expect(alerts[0]?.key).toBe("collection:empty");
  });

  it("names the sources that actually failed, from failed_sources", () => {
    const alerts = evaluateCollectionHealth(
      [
        run({ outcome: "failed", failedSources: JSON.stringify(["nerdin"]) }),
        run({
          outcome: "failed",
          failedSources: JSON.stringify(["ciee", "nerdin"]),
        }),
      ],
      2,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("failing sources: ciee, nerdin");
    expect(alerts[0]?.text).not.toContain("gupy");
  });

  it("still reads cleanly when no run recorded which source failed", () => {
    const alerts = evaluateCollectionHealth(
      [run({ outcome: "failed" }), run({ outcome: "failed" })],
      2,
    );
    expect(alerts[0]?.text).toBe("2 consecutive collection runs errored.");
  });
});

describe("a deferred posting is named, not reported as unclassified", () => {
  // `evaluateDeliveryOutcome` computes missingScores = filteredCount -
  // scoredCount, and filteredCount deliberately includes what ADR-068's
  // budget deferred. It only trusts the persisted breakdown when the two
  // reconcile, so a healthy run that deferred anything reported
  // "N postings were left without a score (unclassified=N)" — telling the
  // operator there is something to investigate and giving it no name.
  it("reports the budget by name when the breakdown reconciles", () => {
    const alerts = evaluateDeliveryOutcome(
      run({
        kind: "scoreAndDeliver",
        filteredCount: 25,
        scoredCount: 20,
        scoreFailureCounts: JSON.stringify({
          deferred_international_budget: 5,
        }),
      }),
      0.5,
    );
    const impact = alerts.find((a) => a.key === "scoring:impact");
    expect(impact?.text).toContain("deferred_international_budget=5");
    expect(impact?.text).not.toContain("unclassified");
  });
});

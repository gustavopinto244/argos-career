import {
  parseFailedSources,
  parseLlmErrorTypeCounts,
  parseLlmOutcomeCounts,
  parseLlmProviderCounts,
  parseScoreFailureCounts,
  RunRow,
} from "../../persistence/infrastructure/runs-repository";

/**
 * `docs/08-observability.md`'s alerting table, as pure functions over
 * `RunRow[]` already returned by `RunsRepository`. No I/O here — the
 * scheduler infrastructure calls these after a cron tick and sends whatever
 * comes back through `TelegramNotifier.sendText`. Kept pure so every branch
 * is a unit test against constructed fixtures, not a real cron or a real
 * Telegram call (docs/07-testing-strategy.md).
 */
export interface Alert {
  readonly text: string;
  /**
   * A stable identity for "this condition", independent of the numbers the
   * message happens to quote (ADR-067 Amendment 1).
   *
   * `text` cannot serve as that identity: half these alerts embed a value
   * that changes every cycle — `staleForHours` grows, `runId` differs per
   * run — so deduplicating the queue on `text` deduplicates nothing for
   * exactly the alerts most likely to repeat during an outage. A channel
   * down for two days would enqueue a dozen near-identical rows per source
   * and then replay them all as stale news.
   *
   * Keys are coarse on purpose: one per condition-and-subject, not per
   * occurrence. Re-raising an alert replaces the queued text with the newer
   * one, so what finally arrives states the situation as of the last time
   * it was true, not as of the first.
   */
  readonly key: string;
}

/**
 * Consecutive-empty and consecutive-errored collection runs (the canonical
 * silent failure of principle 1). `recentRuns` must be `kind: "collect"`
 * runs ordered most-recent-first — the caller's responsibility, since
 * ordering is a query concern this function has no I/O to perform itself.
 *
 * Tolerant by design (docs/08): collection runs every few hours, so a single
 * quiet or failed cycle is routine. Only `threshold` in a row, both counted
 * from the most recent run backward, trigger an alert. Fewer than
 * `threshold` runs recorded yet is "not enough data", not an alert.
 */
export function evaluateCollectionHealth(
  recentRuns: readonly RunRow[],
  threshold: number,
): Alert[] {
  const alerts: Alert[] = [];
  if (recentRuns.length < threshold) return alerts;

  const lastN = recentRuns.slice(0, threshold);

  // Neither message names a source any more. Both used to be prefixed
  // `gupy:` — true when this was written and Gupy was the only collector,
  // and stale since: `config/criteria.yaml` now issues 20 queries across
  // four pulled sources (ciee, gupy, infojobs, nerdin), and one `collect`
  // run covers all of them, with `collectedCount` summing the lot. An
  // operator woken by "gupy: 3 consecutive collection runs errored" would go
  // and check Gupy, which may be the one source that was fine.
  //
  // The errored case can do better than merely not lying: `failed_sources`
  // already records which sources actually failed each run (docs/11 B2), so
  // the alert names them instead of leaving the operator to go and look.
  if (lastN.every((r) => r.outcome === "success" && r.collectedCount === 0)) {
    alerts.push({
      text: `${threshold} consecutive collection runs found zero postings across every source.`,
      key: "collection:empty",
    });
  }

  if (lastN.every((r) => r.outcome === "failed")) {
    const failed = [...new Set(lastN.flatMap((r) => parseFailedSources(r)))]
      .sort()
      .join(", ");
    alerts.push({
      text:
        `${threshold} consecutive collection runs errored` +
        (failed ? ` (failing sources: ${failed}).` : "."),
      key: "collection:errored",
    });
  }

  return alerts;
}

/**
 * A single `scoreAndDeliver` run's own outcome. Digest impact and scorer
 * health are separate signals: any posting left without a score is real
 * user impact, while an attempt-rate alert needs a minimum sample and says
 * nothing about regression unless a separate baseline proves one.
 */
const MIN_LLM_ATTEMPTS_FOR_RATE_ALERT = 10;

function countSummary(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

export function evaluateDeliveryOutcome(
  run: RunRow,
  failureRateThreshold: number,
): Alert[] {
  const alerts: Alert[] = [];

  if (run.outcome === "failed") {
    alerts.push({
      text: `Delivery failed (run ${run.runId}).`,
      key: "delivery:failed",
    });
  }

  const missingScores = Math.max(0, run.filteredCount - run.scoredCount);
  if (missingScores > 0) {
    const persistedCounts = parseScoreFailureCounts(run);
    const persistedTotal = Object.values(persistedCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    const failureCounts =
      persistedTotal === missingScores
        ? persistedCounts
        : { unclassified: missingScores };
    const breakdown = countSummary(failureCounts);
    alerts.push({
      text: `Scoring impact on run ${run.runId}: ${missingScores}/${run.filteredCount} postings were left without a score${breakdown ? ` (${breakdown})` : ""}.`,
      key: "scoring:impact",
    });
  }

  const outcomeCounts = parseLlmOutcomeCounts(run);
  const accountedAttempts = Object.values(outcomeCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const totalOperations = run.llmAttempts + run.llmBlockedByCircuit;
  if (
    run.llmAttempts >= MIN_LLM_ATTEMPTS_FOR_RATE_ALERT &&
    accountedAttempts === run.llmAttempts &&
    totalOperations > 0
  ) {
    const failedOperations = totalOperations - (outcomeCounts.success ?? 0);
    const failureRate = failedOperations / totalOperations;
    if (failureRate >= failureRateThreshold) {
      const outcomes = countSummary(
        Object.fromEntries(
          Object.entries(outcomeCounts).filter(([name]) => name !== "success"),
        ),
      );
      const providers = countSummary(parseLlmProviderCounts(run));
      const errorTypes = countSummary(parseLlmErrorTypeCounts(run));
      const details = [
        outcomes && `outcomes: ${outcomes}`,
        providers && `providers: ${providers}`,
        errorTypes && `error types: ${errorTypes}`,
        run.llmBlockedByCircuit > 0 &&
          `circuit blocks: ${run.llmBlockedByCircuit}`,
      ].filter(Boolean);
      alerts.push({
        text: `Scorer health on run ${run.runId}: ${failedOperations}/${totalOperations} LLM operations failed (${(failureRate * 100).toFixed(0)}%)${details.length > 0 ? ` — ${details.join("; ")}` : ""}.`,
        key: "scoring:health",
      });
    }
  }

  return alerts;
}

/**
 * Formats an instant as `YYYY-MM-DD HH:mm` in `timeZone` — a
 * lexicographically comparable wall-clock string, using `Intl` (built into
 * Node's ICU, no dependency added) rather than reimplementing timezone
 * offset arithmetic.
 */
function wallClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export interface MissedRunConfig {
  readonly scoreAndDeliver: {
    readonly time: string;
    readonly timezone: string;
  };
  readonly collection: { readonly intervalHours: number };
}

/**
 * The two missed-run checks, deliberately asymmetric (ADR-009): a missed
 * `scoreAndDeliver` run means no digest that day, so it alerts on the
 * **first** miss; a missed `collection` cycle self-heals a few hours later,
 * so it alerts only after **two** in a row.
 */
export function evaluateMissedRuns(
  now: Date,
  lastSuccessfulDeliver: RunRow | null,
  lastSuccessfulCollect: RunRow | null,
  config: MissedRunConfig,
): Alert[] {
  const alerts: Alert[] = [];
  const { time, timezone } = config.scoreAndDeliver;

  const nowWallClock = wallClock(now, timezone);
  const [nowDate, nowTime] = nowWallClock.split(" ") as [string, string];
  const scheduledPassedToday = nowTime >= time;

  if (scheduledPassedToday) {
    const lastDeliverDate = lastSuccessfulDeliver
      ? wallClock(lastSuccessfulDeliver.finishedAt ?? now, timezone).split(
          " ",
        )[0]
      : null;
    if (lastDeliverDate !== nowDate) {
      alerts.push({
        text: `No successful scoreAndDeliver run today (scheduled ${time} ${timezone}) — no digest sent.`,
        key: "run:missed:scoreAndDeliver",
      });
    }
  }

  const missedCollectionThresholdMs =
    2 * config.collection.intervalHours * 60 * 60 * 1000;
  const lastCollectAt = lastSuccessfulCollect?.finishedAt ?? null;
  if (
    lastCollectAt === null ||
    now.getTime() - lastCollectAt.getTime() > missedCollectionThresholdMs
  ) {
    alerts.push({
      text: `No successful collection run in the last ${2 * config.collection.intervalHours}h (two cycles).`,
      key: "run:missed:collection",
    });
  }

  return alerts;
}

/**
 * Per-source freshness (docs/11-known-issues.md B13).
 *
 * Every other signal in this file reads `runs` — which is exactly why none
 * of them could see the failure this one exists for. A push-based external
 * collector (ADR-027) never appears in a `collect` run's
 * `attempted_sources`, so its silence is indistinguishable from success:
 * Indeed contributed nothing for six days while every run row said
 * `success`, because the pulled sources were genuinely fine.
 *
 * So this reads the **corpus** instead of the run log — the newest
 * `lastSeenAt` per source is the one fact that is true regardless of how a
 * posting arrived, pulled or pushed.
 *
 * A source with no configured expectation is not checked at all, and a
 * source that has never delivered anything (`null`) alerts with different
 * wording from one that has gone quiet — "never" is a deployment problem
 * (B14's Catho), "stale" is an operational one (B13's Indeed), and telling
 * an operator the wrong one sends them to the wrong place.
 */
export function evaluateSourceFreshness(
  now: Date,
  lastSeenBySource: Readonly<Record<string, Date | null>>,
  expectedHoursBySource: Readonly<Record<string, number>>,
): Alert[] {
  const alerts: Alert[] = [];
  for (const source of Object.keys(expectedHoursBySource).sort()) {
    const expectedHours = expectedHoursBySource[source];
    if (expectedHours === undefined) continue;
    const lastSeen = lastSeenBySource[source] ?? null;

    if (lastSeen === null) {
      alerts.push({
        text: `Source "${source}" has never delivered a posting, but a freshness window of ${expectedHours}h is configured for it — it is probably not deployed.`,
        key: `source:never-delivered:${source}`,
      });
      continue;
    }

    const staleForMs = now.getTime() - lastSeen.getTime();
    if (staleForMs > expectedHours * 60 * 60 * 1000) {
      const staleForHours = Math.floor(staleForMs / (60 * 60 * 1000));
      alerts.push({
        text: `Source "${source}" has delivered nothing for ${staleForHours}h (expected at least every ${expectedHours}h) — last posting seen ${lastSeen.toISOString()}.`,
        key: `source:stale:${source}`,
      });
    }
  }
  return alerts;
}

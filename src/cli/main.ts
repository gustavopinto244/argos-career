#!/usr/bin/env node
/**
 * Each pipeline stage invocable independently, the actual test of principle 2
 * (docs/02-architecture.md) for this milestone: `dedup` re-scans the corpus
 * for near-duplicates without touching a collector or the network at all.
 *
 *   argos collect [--job-name <text>] [--city <text>] [--max-results <n>]
 *                 [--since-days <n>]  # one-off wider window, e.g. after
 *                                     # adding a query term (ADR-019)
 *   argos dedup [--similarity-threshold <0-1>] [--window-days <n>] [--reset]
 *   argos deliver
 *   argos studyplan
 *   argos discard <fingerprint> [--reason <text>]
 */
import { parseArgs } from "node:util";
import { CollectorPort } from "../posting/domain/ports/collector.port";
import { Posting } from "../posting/domain/posting";
import { collectorFor } from "../posting/infrastructure/collector-registry";
import {
  Normalizer,
  normalizerFor,
} from "../posting/infrastructure/normalizer-registry";
import {
  DEFAULT_DEDUP_CONFIG,
  DedupConfig,
  dedupSimilarPostings,
  DedupOutcome as DedupSimilarPostingsOutcome,
  ShadowDuplicateCandidate,
} from "../persistence/application/dedup-similar-postings";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../persistence/infrastructure/db";
import { PostingsRepository } from "../persistence/infrastructure/postings-repository";
import {
  RunCounts,
  RunsRepository,
  parseFailedSources,
  parseTruncatedSources,
} from "../persistence/infrastructure/runs-repository";
import { PostingEventsRepository } from "../persistence/infrastructure/posting-events-repository";
import { DeliveryOperationsRepository } from "../persistence/infrastructure/delivery-operations-repository";
import { applyPreFilter } from "../prefilter/domain/pre-filter";
import { Criteria } from "../prefilter/domain/criteria";
import { loadCriteria } from "../prefilter/infrastructure/criteria-loader";
import { hashCriteria } from "../prefilter/domain/criteria-hash";
import { Profile } from "../profile/domain/profile";
import { loadProfile } from "../profile/infrastructure/profile-loader";
import { deriveProfileKeywords } from "../profile/domain/profile-keywords";
import { hashProfile } from "../profile/domain/profile-hash";
import { ScorerPort } from "../scoring/domain/ports/scorer.port";
import { EMPTY_RECOMMENDATION } from "../scoring/domain/recommendation";
import { scoreFailureOutcome } from "../scoring/domain/types";
import { buildScorer } from "../scoring/infrastructure/build-scorer";
import {
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_VERSION,
} from "../scoring/infrastructure/prompts";
import { UsageTotals } from "../scoring/infrastructure/openrouter-client";
import { NotifierPort } from "../delivery/domain/ports/notifier.port";
import {
  composeDigest,
  PeriodBlockedEntry,
  ScoredPosting,
} from "../delivery/domain/digest";
import {
  TelegramNotifier,
  TextNotifier,
} from "../delivery/infrastructure/telegram-notifier";
import { loadTelegramConfig } from "../delivery/infrastructure/telegram-config";
import { Taxonomy } from "../market/domain/taxonomy";
import { loadTaxonomy } from "../market/infrastructure/taxonomy-loader";
import { MarketRepository } from "../market/infrastructure/market-repository";
import { composeStudyPlan } from "../market/domain/study-plan";
import { renderStudyPlanText } from "../market/domain/render-study-plan";

export interface CollectOutcome {
  readonly runId: string;
  readonly collected: number;
  readonly normalized: number;
  /** Dropped by the recency window (ADR-019) — visible so a window that is
   * quietly discarding everything shows up instead of looking like a dead
   * source. */
  readonly tooOld: number;
  /** A raw item that never became a valid `Posting` — either no normalizer
   * is registered for its source (a wiring bug) or the registered
   * normalizer ran and rejected it (docs/audit/AUDIT_REPORT.md AC-012:
   * previously silently dropped, uncounted, in this internal path only —
   * `executeIngestExternal` already counted it). Both cases mean the same
   * thing downstream (no `Posting` to score), so they share one counter. */
  readonly unnormalizable: number;
  /** Total raw items every collector reported receiving this run, summed
   * across queries. `null` when at least one query's collector could not
   * report it — reversing this field's original "undefined contributes 0"
   * convention (AC-012), which made an incomplete run's total indistinguishable
   * from a complete one that happened to sum to the same number
   * (docs/audit PR-014). */
  readonly received: number | null;
  /** Of `received`, how many failed a collector's own item schema before
   * `postings` was ever built. Same `null`-means-unreconcilable convention
   * as `received` (AC-012, docs/audit PR-014). */
  readonly schemaRejected: number | null;
  /** Source(s) that stopped paginating this run because they hit their own
   * cap while more results were plausibly available (AC-013) — a "success"
   * outcome that still left something uncollected. */
  readonly truncatedSources: readonly string[];
  readonly isNew: number;
  readonly alreadySeen: number;
  readonly error?: string;
}

const DEFAULT_QUERY_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The testable core of `collect`, independent of argv parsing. The collector
 * is injected — tests exercise this with a stub, no network call, matching
 * docs/07-testing-strategy.md.
 *
 * Takes a **list** of queries and folds them into **one** run row: a
 * collection cycle is one run regardless of how many questions it had to ask
 * the source (`config/criteria.yaml`'s `collection.queries`). Recording one
 * row per query instead would quietly break two things that count runs — the
 * digest's "collected since last delivery" summary, and
 * `evaluateCollectionHealth`, which alerts on consecutive *empty* collection
 * runs and would start firing whenever one of several queries legitimately
 * returned nothing.
 *
 * Partial failure is degraded, not down (principle 1): whatever succeeded is
 * persisted, the first error is reported on the outcome, and the run is
 * marked `failed` only when **every** query failed. One dead query out of
 * four must not look identical to a dead source.
 */
export interface RecencyWindow {
  readonly recencyDays: number;
  readonly backfillDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Gap-aware recency window (ADR-019, "the honest fix," deliberately
 * deferred there until a real outage existed to size it against —
 * docs/audit AC-028). No successful `collect` on record means no earlier
 * cycle could have caught the past week, so `backfillDays` applies, same as
 * before. Otherwise the window is measured from the *actual* gap since the
 * last success, not always `recencyDays` — an outage longer than
 * `recencyDays` used to make every posting published during it permanently
 * unreachable, because the very next successful run's window started
 * counting from "now," not from "the last time this succeeded."
 *
 * Bounded both ends: never narrower than `recencyDays` (a normal cycle,
 * gap ≈ the collection interval, still gets the deliberately generous
 * day of overlap), never wider than `backfillDays` (an outage of months
 * does not turn into an unbounded backfill — recovery beyond that is a
 * deliberate manual `--since-days` call, not automatic).
 */
export function computeRecencyWindowDays(
  lastSuccessfulCollectAt: Date | null,
  now: Date,
  recency: RecencyWindow,
): number {
  if (lastSuccessfulCollectAt === null) return recency.backfillDays;
  const gapDays =
    (now.getTime() - lastSuccessfulCollectAt.getTime()) / MS_PER_DAY;
  return Math.min(Math.max(gapDays, recency.recencyDays), recency.backfillDays);
}

/**
 * Resolves the collector for a query's `source`. Production passes
 * `collectorFor`; tests pass a stub so no suite ever touches the network
 * (docs/07-testing-strategy.md).
 */
export type CollectorResolver = (source: string) => CollectorPort | null;

export async function executeCollect(
  db: Db,
  collectors: CollectorResolver,
  queries: readonly unknown[],
  now: () => Date = () => new Date(),
  queryIntervalMs: number = DEFAULT_QUERY_INTERVAL_MS,
  recency?: RecencyWindow,
  triggeredBy: string = "internal",
): Promise<CollectOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const postingEventsRepo = new PostingEventsRepository(db);

  // Per-source, not one global window (docs/audit PR-003): the previous
  // single `lastSuccessfulCollectAt` read from `findLatestFinished("collect",
  // "success")` let one healthy source's success mark the whole run
  // "success" and silently advance every *other* source's recovery clock
  // too — a real four-day Sólides outage while Gupy stayed healthy would
  // have looked like nothing happened, and Sólides's first run back would
  // have received only the ordinary one-day window, permanently losing
  // three days of postings. Each source's cutoff is computed lazily, from
  // its own history, the first time a query for it is seen this run —
  // read BEFORE this run is started (via `findLastSuccessfulSourceCollectAt`,
  // which only ever looks at already-finished runs), or it would find
  // itself. Memoized per source so a source with several queries (per-city
  // Gupy queries) computes its window once, not once per query.
  const cutoffCache = new Map<string, Date | null>();
  function cutoffForSource(source: string): Date | null {
    const cached = cutoffCache.get(source);
    if (cached !== undefined) return cached;
    const windowDays = recency
      ? computeRecencyWindowDays(
          runsRepo.findLastSuccessfulSourceCollectAt(source),
          now(),
          recency,
        )
      : null;
    const cutoff =
      windowDays === null
        ? null
        : new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000);
    cutoffCache.set(source, cutoff);
    return cutoff;
  }

  const runId = runsRepo.start("collect", now(), triggeredBy);

  let collected = 0;
  let normalized = 0;
  let isNew = 0;
  let alreadySeen = 0;
  let failures = 0;
  let tooOld = 0;
  let unnormalizable = 0;
  // `null` means at least one query this run could not report a
  // reconcilable count (docs/audit PR-014) — reversing this same
  // variable's prior "undefined contributes 0" convention, which made an
  // incomplete run's total look exactly like a complete one that happened
  // to add up the same way. Once null, stays null: one unreconcilable
  // query taints the whole run's total, since a partial sum mislabeled as
  // complete is worse than an honest "unknown."
  let received: number | null = 0;
  let schemaRejected: number | null = 0;
  let firstError: string | undefined;
  // Which source(s) actually failed this run (docs/11-known-issues.md B2) —
  // a Set because the same source can appear in several queries
  // (config/criteria.yaml's per-city Gupy queries) and should only be
  // reported once.
  const failedSources = new Set<string>();
  // Which source(s) reported truncation this run (docs/audit AC-013) — a Set
  // for the same reason failedSources is: the same source can appear in
  // several queries.
  const truncatedSources = new Set<string>();
  // Every source at least one query targeted this run (docs/audit PR-003) —
  // what makes `findLastSuccessfulSourceCollectAt` able to tell "this source
  // was queried and failed" apart from "this source was never queried".
  const attemptedSources = new Set<string>();
  const sourceQueryStats: Readonly<Record<string, unknown>>[] = [];

  // Same bookkeeping guarantee `executeDeliver` documents: a throw between
  // `start` and `finish` must not leave the row open. Collectors cannot throw
  // (principle 1) and the normalizers use `safeParse`, so the realistic
  // trigger here is the database itself — a locked or full disk mid-upsert.
  // Narrower than the deliver case, identical in consequence.
  try {
    for (const [index, query] of queries.entries()) {
      // The collector's own interval only spaces out pages *within* one query,
      // so the gap between queries is this loop's responsibility (CLAUDE.md §6).
      if (index > 0 && queryIntervalMs > 0) await sleep(queryIntervalMs);

      // `source` decides who fetches, exactly as `RawPosting.source` decides
      // who normalizes. A query naming a source this build cannot collect from
      // is a config error, reported rather than skipped.
      const source =
        typeof query === "object" && query !== null && "source" in query
          ? String((query as { source?: unknown }).source ?? "gupy")
          : "gupy";
      attemptedSources.add(source);
      const collector = collectors(source);
      if (!collector) {
        failures += 1;
        failedSources.add(source);
        firstError ??= `No collector registered for source "${source}"`;
        sourceQueryStats.push({
          queryIndex: index,
          source,
          received: null,
          schemaRejected: null,
          businessRejected: null,
          normalized: 0,
          normalizationRejected: 0,
          tooOld: 0,
          isNew: 0,
          alreadySeen: 0,
          truncated: false,
          error: "collector_missing",
        });
        continue;
      }

      const result = await collector.collect(query);
      const beforeNormalized = normalized;
      const beforeUnnormalizable = unnormalizable;
      const beforeTooOld = tooOld;
      const beforeNew = isNew;
      const beforeAlreadySeen = alreadySeen;
      collected += result.postings.length;
      received =
        result.receivedCount === undefined || received === null
          ? null
          : received + result.receivedCount;
      schemaRejected =
        result.schemaRejectedCount === undefined || schemaRejected === null
          ? null
          : schemaRejected + result.schemaRejectedCount;
      if (result.truncated) truncatedSources.add(source);
      if ((result.schemaRejectedCount ?? 0) > 0) {
        postingEventsRepo.record({
          runId,
          source,
          stage: "collect",
          outcome: "schema_rejected",
          reason: `${result.schemaRejectedCount} raw item(s) rejected by collector schema`,
          metadata: { count: result.schemaRejectedCount },
          occurredAt: result.collectedAt,
        });
      }

      if (result.error) {
        failures += 1;
        failedSources.add(source);
        firstError ??= result.error.message;
        // No `continue` here (docs/audit AC-004): a page-2+ failure still
        // leaves `result.postings` holding whatever pages already
        // succeeded, and those are real, valid postings — normalizing and
        // persisting them below is not a consolation prize, it is the
        // point. The run is still recorded failed via `failures`/
        // `failedSources` above; only the postings survive.
      }

      const collectedAt = now();
      const cutoff = cutoffForSource(source);
      const persistable: { readonly posting: Posting }[] = [];
      for (const raw of result.postings) {
        // Dispatch by the source the payload declares, not by which collector
        // was passed in — an unregistered source is a wiring bug, and saying
        // so beats dropping every posting and looking like an empty source.
        //
        // Raw-stage events use source/sourceId and a nullable fingerprint;
        // this preserves the rejection even when no Posting can be built.
        const normalize = normalizerFor(raw.source);
        if (!normalize) {
          firstError ??= `No normalizer registered for source "${raw.source}"`;
          failedSources.add(raw.source);
          unnormalizable += 1;
          postingEventsRepo.record({
            runId,
            source: raw.source,
            sourceId: raw.sourceId,
            stage: "collect",
            outcome: "normalizer_missing",
            reason: `No normalizer registered for source "${raw.source}"`,
            occurredAt: collectedAt,
          });
          continue;
        }
        const posting = normalize(raw, collectedAt);
        if (!posting) {
          // The normalizer ran and rejected this item — same downstream
          // consequence as "no normalizer registered" above (no `Posting`
          // to score), previously uncounted here (AC-012).
          unnormalizable += 1;
          postingEventsRepo.record({
            runId,
            source: raw.source,
            sourceId: raw.sourceId,
            stage: "collect",
            outcome: "normalization_rejected",
            occurredAt: collectedAt,
          });
          continue;
        }
        // A posting the source never dated passes: absence of a date is not
        // evidence of an old posting, the same leniency ADR-011 applies to an
        // unknown location/workMode.
        if (
          cutoff !== null &&
          posting.publishedAt !== null &&
          posting.publishedAt.getTime() < cutoff.getTime()
        ) {
          tooOld += 1;
          // Collection had no posting_events coverage at all before this
          // (docs/audit PR-021) — a posting dropped here previously left
          // no trace beyond the run-level `tooOldCount` aggregate, giving
          // no way to answer "why isn't this specific posting in the
          // corpus" the way prefilter/score/dedup already can.
          postingEventsRepo.record({
            runId,
            fingerprint: posting.fingerprint,
            source: posting.source,
            sourceId: posting.sourceId,
            stage: "collect",
            outcome: "too_old",
            reason: `publishedAt ${posting.publishedAt.toISOString()} before cutoff ${cutoff.toISOString()}`,
            occurredAt: collectedAt,
          });
          continue;
        }
        normalized += 1;
        persistable.push({ posting });
      }
      const persisted = postingsRepo.upsertMany(
        persistable.map(({ posting }) => posting),
      );
      persisted.forEach(({ wasNew }, index) => {
        const posting = persistable[index]!.posting;
        if (wasNew) isNew += 1;
        else alreadySeen += 1;
        postingEventsRepo.record({
          runId,
          fingerprint: posting.fingerprint,
          source: posting.source,
          sourceId: posting.sourceId,
          stage: "collect",
          outcome: wasNew ? "new" : "already_seen",
          reason: null,
          occurredAt: collectedAt,
        });
      });
      sourceQueryStats.push({
        queryIndex: index,
        source,
        received: result.receivedCount ?? null,
        schemaRejected: result.schemaRejectedCount ?? null,
        businessRejected: result.businessRejectedCount ?? null,
        collectorReturned: result.postings.length,
        normalized: normalized - beforeNormalized,
        normalizationRejected: unnormalizable - beforeUnnormalizable,
        tooOld: tooOld - beforeTooOld,
        isNew: isNew - beforeNew,
        alreadySeen: alreadySeen - beforeAlreadySeen,
        truncated: result.truncated ?? false,
        error: result.error?.message ?? null,
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    runsRepo.finish(runId, now(), "failed", {
      collectedCount: collected,
      normalizedCount: normalized,
      newCount: isNew,
      alreadySeenCount: alreadySeen,
      tooOldCount: tooOld,
      unnormalizableCount: unnormalizable,
      receivedCount: received,
      schemaRejectedCount: schemaRejected,
      failureReason: firstError ?? message,
      failedSources: [...failedSources],
      truncatedSources: [...truncatedSources],
      attemptedSources: [...attemptedSources],
      sourceQueryStats,
    });
    throw cause;
  }

  const allFailed = failures === queries.length;
  runsRepo.finish(runId, now(), allFailed ? "failed" : "success", {
    collectedCount: collected,
    normalizedCount: normalized,
    newCount: isNew,
    alreadySeenCount: alreadySeen,
    tooOldCount: tooOld,
    unnormalizableCount: unnormalizable,
    receivedCount: received,
    schemaRejectedCount: schemaRejected,
    failureReason: firstError ?? null,
    failedSources: [...failedSources],
    truncatedSources: [...truncatedSources],
    attemptedSources: [...attemptedSources],
    sourceQueryStats,
  });

  return {
    runId,
    collected,
    normalized,
    tooOld,
    unnormalizable,
    received,
    schemaRejected,
    truncatedSources: [...truncatedSources],
    isNew,
    alreadySeen,
    ...(firstError === undefined ? {} : { error: firstError }),
  };
}

export interface ExternalRawPosting {
  readonly sourceId: string;
  readonly payload: unknown;
}

export interface IngestExternalOutcome {
  readonly runId: string;
  readonly collected: number;
  readonly normalized: number;
  readonly unnormalizable: number;
  readonly isNew: number;
  readonly alreadySeen: number;
}

/**
 * Content-free structural summary of a rejected external-ingest item —
 * field *names*, never values (docs/08-observability.md's boundary around
 * log lines applies equally to event metadata). Added after
 * `docs/11-known-issues.md` B15: a whole batch of real LinkedIn postings
 * was silently discarded for days because `unnormalizable_count` and the
 * `normalization_rejected` event carried no information about *why* — only
 * a direct read of the caller's actual field-casing bug (found by pasting
 * a real payload) explained it. This is what should have made that
 * diagnosable from the database alone.
 */
function describeUnnormalizablePayload(
  raw: ExternalRawPosting,
): Readonly<Record<string, unknown>> {
  const hasSourceId =
    typeof raw.sourceId === "string" && raw.sourceId.trim().length > 0;
  const payload = raw.payload;
  if (payload === null || typeof payload !== "object") {
    return { hasSourceId, payloadType: typeof payload };
  }
  return {
    hasSourceId,
    payloadType: "object",
    payloadKeys: Object.keys(payload as Record<string, unknown>).sort(),
  };
}

/**
 * The testable core of the external-ingest endpoint (ADR-027) — a source
 * that fetches outside this process (jobspy, in an ephemeral container on
 * Atlas's host, never inside the app container) and hands over already-
 * fetched raw postings instead of this process making the network call
 * itself. Everything after "already have the raw payloads" is identical to
 * `executeCollect`'s inner loop: normalize, upsert, count.
 *
 * `normalize` is passed in already resolved, not looked up by `source`
 * internally — the caller (`RunsService.ingestExternal`) rejects an
 * unregistered source with 400 before a run row is even opened, since every
 * item would be unnormalizable and starting a run to record that is not
 * useful. This function's contract is simpler as a result: given a working
 * normalizer, normalize and store this exact batch.
 *
 * No recency-window filtering (ADR-019/`executeCollect`'s `cutoff`) —
 * deliberately out of scope for v1. The pre-filter's `maxAgeDays`
 * (ADR-011 Amendment 4) already bounds what reaches the LLM regardless of
 * which stage a posting entered through, so skipping the window here costs
 * extra storage of an old posting, never extra LLM spend — see ADR-027's
 * consequences.
 *
 * Bookkeeping matches `executeCollect`/`executeDedup`: the run row closes
 * as `failed` before a throw is re-raised, never left open (#49).
 *
 * `truncated` (docs/audit PR-015, ADR-027 Amendment 1) carries forward
 * whether the *caller* — the host-side process that actually talked to the
 * source — hit its own configured cap this run: jobspy's `results_wanted`,
 * or Catho's `MAX_PAGES_PER_RUN` leaving title-matched candidates
 * unfetched. This process never sees the source's raw response, so unlike
 * `GupyCollector`/`CieeCollector`/`SolidesCollector` it cannot detect
 * truncation itself — it can only record what the caller already knows,
 * the same way `attemptedSources`/`failedSources` are supplied rather than
 * derived for every other run kind.
 */
export async function executeIngestExternal(
  db: Db,
  source: string,
  normalize: Normalizer,
  postings: readonly ExternalRawPosting[],
  now: () => Date = () => new Date(),
  truncated: boolean = false,
  triggeredBy: string = "internal",
): Promise<IngestExternalOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const postingEventsRepo = new PostingEventsRepository(db);
  const runId = runsRepo.start("collect", now(), triggeredBy);

  let normalized = 0;
  let unnormalizable = 0;
  let isNew = 0;
  let alreadySeen = 0;
  const truncatedSources = truncated ? [source] : [];

  try {
    const collectedAt = now();
    const persistable: {
      readonly posting: Posting;
      readonly sourceId: string;
    }[] = [];
    for (const raw of postings) {
      const posting = normalize(
        { source, sourceId: raw.sourceId, payload: raw.payload },
        collectedAt,
      );
      if (!posting) {
        unnormalizable += 1;
        postingEventsRepo.record({
          runId,
          source,
          sourceId: raw.sourceId,
          stage: "collect",
          outcome: "normalization_rejected",
          occurredAt: collectedAt,
          metadata: describeUnnormalizablePayload(raw),
        });
        continue;
      }
      normalized += 1;
      persistable.push({ posting, sourceId: raw.sourceId });
    }
    const persisted = postingsRepo.upsertMany(
      persistable.map(({ posting }) => posting),
    );
    persisted.forEach(({ wasNew }, index) => {
      const item = persistable[index]!;
      if (wasNew) isNew += 1;
      else alreadySeen += 1;
      postingEventsRepo.record({
        runId,
        fingerprint: item.posting.fingerprint,
        source,
        sourceId: item.sourceId,
        stage: "collect",
        outcome: wasNew ? "new" : "already_seen",
        occurredAt: collectedAt,
      });
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    runsRepo.finish(runId, now(), "failed", {
      collectedCount: postings.length,
      normalizedCount: normalized,
      newCount: isNew,
      alreadySeenCount: alreadySeen,
      truncatedSources,
      attemptedSources: [source],
      failureReason: message,
      sourceQueryStats: [
        {
          queryIndex: 0,
          source,
          received: null,
          schemaRejected: null,
          businessRejected: null,
          collectorReturned: postings.length,
          normalized,
          normalizationRejected: unnormalizable,
          isNew,
          alreadySeen,
          truncated,
          error: message,
        },
      ],
    });
    throw cause;
  }

  runsRepo.finish(runId, now(), "success", {
    collectedCount: postings.length,
    normalizedCount: normalized,
    newCount: isNew,
    alreadySeenCount: alreadySeen,
    truncatedSources,
    attemptedSources: [source],
    sourceQueryStats: [
      {
        queryIndex: 0,
        source,
        received: null,
        schemaRejected: null,
        businessRejected: null,
        collectorReturned: postings.length,
        normalized,
        normalizationRejected: unnormalizable,
        isNew,
        alreadySeen,
        truncated,
        error: null,
      },
    ],
  });

  return {
    runId,
    collected: postings.length,
    normalized,
    unnormalizable,
    isNew,
    alreadySeen,
  };
}

export interface DedupOutcome {
  readonly runId: string;
  readonly scanned: number;
  readonly markedDuplicate: number;
  /** How many shadow candidates layer 2 logged this pass (docs/audit
   * PR-006) — none of them excluded, all of them recorded as
   * `posting_events` for review. */
  readonly shadowCandidateCount: number;
  readonly comparisonTruncatedCount: number;
}

/**
 * Records one `posting_events` row per shadow candidate `dedupSimilarPostings`
 * found (docs/audit PR-006, ADR-010 Amendment 3) — the auditability half of
 * shadow mode. `reason` carries everything a human needs to judge the call
 * without re-running anything: the canonical it would have merged into, the
 * two titles compared, and the computed similarity score.
 */
function recordShadowDuplicateEvents(
  postingEventsRepo: PostingEventsRepository,
  runId: string,
  candidates: readonly ShadowDuplicateCandidate[],
  occurredAt: Date,
): void {
  for (const candidate of candidates) {
    postingEventsRepo.record({
      runId,
      fingerprint: candidate.candidateFingerprint,
      stage: "dedup-similarity",
      outcome: "shadow_candidate",
      reason:
        `similarity ${candidate.similarity.toFixed(2)} to ${candidate.canonicalFingerprint} ` +
        `("${candidate.candidateTitle}" vs "${candidate.canonicalTitle}")`,
      occurredAt,
    });
  }
}

/** The testable core of `dedup`. Touches only PostingsRepository — no
 * collector, no network, at all. */
export function executeDedup(
  db: Db,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
  now: () => Date = () => new Date(),
  triggeredBy: string = "internal",
): DedupOutcome {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const postingEventsRepo = new PostingEventsRepository(db);
  const runId = runsRepo.start("dedup", now(), triggeredBy);

  let outcome;
  try {
    outcome = dedupSimilarPostings(postingsRepo, config);
  } catch (cause) {
    // See `executeCollect` — the row is closed before the throw is re-raised
    // so an open `finishedAt: null` can only ever mean "still running".
    runsRepo.finish(runId, now(), "failed", { duplicateCount: 0 });
    throw cause;
  }

  recordShadowDuplicateEvents(
    postingEventsRepo,
    runId,
    outcome.shadowCandidates,
    now(),
  );
  if (outcome.comparisonTruncatedCount > 0) {
    postingEventsRepo.record({
      runId,
      stage: "dedup-similarity",
      outcome: "comparison_bound_reached",
      metadata: { postingCount: outcome.comparisonTruncatedCount },
      occurredAt: now(),
    });
  }

  runsRepo.finish(runId, now(), "success", {
    duplicateCount: outcome.markedDuplicate,
  });

  return {
    runId,
    scanned: outcome.scanned,
    markedDuplicate: outcome.markedDuplicate,
    shadowCandidateCount: outcome.shadowCandidates.length,
    comparisonTruncatedCount: outcome.comparisonTruncatedCount,
  };
}

/**
 * `executeDeliver`'s own dedup pass, atomic with the scoring-candidate claim
 * that follows it (docs/audit PR-004) — the fix for "dedup-before-delivery
 * is not an atomic admission barrier." The plain `executeDedup(db, ...)`
 * used before this ADR left a real gap: dedup ran, committed, and only
 * *afterward* did `findUnnotified()` read the candidate set in a separate
 * query — a window in which a concurrent process's insert (external ingest,
 * or a second `deliver` invocation `RunLock` cannot see across processes)
 * could add a near-duplicate that this run's dedup pass never evaluated, yet
 * which was still eligible for paid Stage A/B scoring.
 *
 * Wrapping `dedupSimilarPostings` and `claimForScoring` in one
 * `db.transaction()` closes that window: `better-sqlite3` serializes write
 * transactions at the file level, so any other process's own write
 * transaction is fully before or fully after this whole unit, never
 * interleaved partway through it (the same guarantee
 * `PostingsRepository.upsert`'s docstring already relies on for a different
 * invariant). A posting inserted by another process during this transaction
 * simply is not visible to either half of it, and is correctly left
 * unclaimed for the next run's own atomic pass.
 */
function executeDedupAndClaim(
  db: Db,
  dedupConfig: DedupConfig,
  scoringRunId: string,
  now: () => Date,
  triggeredBy: string,
): DedupOutcome & { readonly claimed: readonly Posting[] } {
  const runsRepo = new RunsRepository(db);
  const dedupRunId = runsRepo.start("dedup", now(), triggeredBy);

  let outcome: DedupSimilarPostingsOutcome;
  let claimed: readonly Posting[];
  try {
    const result = db.transaction((tx) => {
      const txRepo = new PostingsRepository(tx);
      const txPostingEventsRepo = new PostingEventsRepository(tx);
      const dedupOutcome = dedupSimilarPostings(txRepo, dedupConfig);
      recordShadowDuplicateEvents(
        txPostingEventsRepo,
        dedupRunId,
        dedupOutcome.shadowCandidates,
        now(),
      );
      if (dedupOutcome.comparisonTruncatedCount > 0) {
        txPostingEventsRepo.record({
          runId: dedupRunId,
          stage: "dedup-similarity",
          outcome: "comparison_bound_reached",
          metadata: {
            postingCount: dedupOutcome.comparisonTruncatedCount,
          },
          occurredAt: now(),
        });
      }
      const claimedPostings = txRepo.claimForScoring(scoringRunId, now());
      return { dedupOutcome, claimedPostings };
    });
    outcome = result.dedupOutcome;
    claimed = result.claimedPostings;
  } catch (cause) {
    runsRepo.finish(dedupRunId, now(), "failed", { duplicateCount: 0 });
    throw cause;
  }

  runsRepo.finish(dedupRunId, now(), "success", {
    duplicateCount: outcome.markedDuplicate,
  });

  return {
    runId: dedupRunId,
    scanned: outcome.scanned,
    markedDuplicate: outcome.markedDuplicate,
    shadowCandidateCount: outcome.shadowCandidates.length,
    comparisonTruncatedCount: outcome.comparisonTruncatedCount,
    claimed,
  };
}

export interface DeliverOutcome {
  readonly runId: string;
  readonly filtered: number;
  readonly scored: number;
  readonly delivered: number;
  readonly error?: string;
  /** docs/11-known-issues.md C1: set when a cancel request (not a failure)
   * stopped the scoring loop early. Whatever scored before the request was
   * observed was still delivered normally -- `delivered` above already
   * reflects that -- this only distinguishes "stopped on purpose" from
   * `error`'s "stopped because something broke" for a caller that cares. */
  readonly cancelled?: boolean;
}

/**
 * A posting whose scoring keeps failing run after run stops being retried
 * automatically once it has failed this many consecutive times (docs/audit
 * PR-002) — the same "give up after five" ceiling this project already uses
 * for Catho's checkpoint quarantine, chosen for the same reason: enough
 * attempts to absorb a multi-day transient provider outage, not so many that
 * a permanently malformed posting spends a model call every night forever.
 * A posting that hits the ceiling is marked notified with
 * `max_retries_exceeded` rather than retried again automatically — recovery
 * from there is manual (fix the underlying problem and re-run, or discard).
 */
export const DEFAULT_MAX_SCORE_FAILURES = 5;

/**
 * The testable core of `deliver`: dedup+claim → pre-filter → score → compose
 * → notify. `executeDedupAndClaim` (docs/audit PR-004, ADR-040) atomically
 * claims every active, not-yet-notified, not-already-claimed posting as this
 * run's own candidate set in the same transaction as the dedup pass — a
 * persisted admission barrier a second process's own claim attempt cannot
 * see past, unlike a plain read. A posting that fails the pre-filter or
 * scores `discard`, or that this run claimed but a permanent transport
 * failure (ADR-039) stopped it from ever reaching, has its claim released
 * (`releaseUnresolvedClaims`) rather than marked notified — it stays a
 * candidate for the next run's own claim, the same "corpus is never
 * deleted" discipline the rest of the pipeline follows (ADR-007). Only
 * postings that actually appear in a *successfully sent* digest are marked
 * notified, so a failed send never causes a silent skip (ADR-007's re-run
 * test).
 *
 * A posting whose scoring *fails* is the one deliberate exception to "in the
 * digest means notified" (docs/audit PR-002, ADR-038): failure is reported,
 * but `notifiedAt` is left null and its claim released, so the posting is
 * eligible for the next run's claim and gets a fresh attempt — up to
 * `maxScoreFailures`, after which it is marked notified with
 * `max_retries_exceeded` so it stops being retried automatically. Before
 * ADR-038, every entry in the digest was marked notified unconditionally,
 * so a transient provider failure permanently removed a posting from future
 * scoring the moment its one failure message was delivered.
 *
 * `collected`/`deduplicated` in the run summary are read from `collect` and
 * `dedup` runs since the last successful delivery, not from this run
 * itself — this run does not collect. `deduplicated` approximates "new
 * postings surviving dedup" as `newCount - duplicateCount` over that window,
 * clamped at zero, rather than joining against which specific postings were
 * marked duplicate; exact enough for a summary line, not for accounting.
 */
export async function executeDeliver(
  db: Db,
  scorer: ScorerPort,
  notifier: NotifierPort,
  criteria: Criteria,
  profile: Profile,
  /** Present only when `scorer` is backed by `OpenRouterClient` — read once
   * after scoring completes and persisted onto this run's row so "what did
   * tonight's run cost" is answerable from `runs` itself, not only from a
   * separately-run calibration script (docs/audit AC-015). */
  getUsage?: () => UsageTotals,
  now: () => Date = () => new Date(),
  /** docs/audit AC-005: external ingest (Indeed/Catho/LinkedIn) upserts
   * into `postings` without ever running similarity dedup itself — only the
   * scheduler's own collection cycle does that, on its own schedule. A
   * posting ingested after the last scheduled dedup could otherwise reach
   * paid Stage A/B scoring never having been compared against an
   * already-active near-duplicate. `deliver()` now runs `executeDedup` as
   * its own first step, so every entry path funnels through the same
   * barrier immediately before scoring, regardless of how the posting
   * arrived. */
  dedupConfig: DedupConfig = DEFAULT_DEDUP_CONFIG,
  /** docs/audit PR-002 — see `DEFAULT_MAX_SCORE_FAILURES`. A parameter,
   * not only a constant, so a test can reach the ceiling without seeding
   * five real runs' worth of failures. */
  maxScoreFailures: number = DEFAULT_MAX_SCORE_FAILURES,
  triggeredBy: string = "internal",
  /** docs/11-known-issues.md C1. Polled once per posting in the scoring
   * loop below -- the caller decides what "requested" means (`RunLock`'s
   * in-memory flag for the real server; a test's own closure). Defaults to
   * never cancelling, so every existing caller that does not pass this is
   * unaffected. */
  isCancelRequested: () => boolean = () => false,
): Promise<DeliverOutcome> {
  const postingsRepo = new PostingsRepository(db);
  const runsRepo = new RunsRepository(db);
  const postingEventsRepo = new PostingEventsRepository(db);
  const runId = runsRepo.start("scoreAndDeliver", now(), triggeredBy);

  // Read fresh right before each `finish()` call below — the client's
  // running totals as of that moment, best-effort even when scoring never
  // completed (the catch branch calls this too, reflecting whatever usage
  // accrued before the failure).
  function usageCounts(): Partial<RunCounts> {
    const usage = getUsage?.();
    if (!usage) return {};
    return {
      llmAttempts: usage.attempts,
      llmCostUsd: usage.costUsd,
      llmAttemptsWithoutUsage: usage.attemptsWithoutUsage,
      llmPromptTokens: usage.promptTokens,
      llmCompletionTokens: usage.completionTokens,
      llmCachedPromptTokens: usage.cachedPromptTokens,
      llmBlockedByCircuit: usage.blockedByCircuit,
      llmOutcomeCounts: usage.attemptsByOutcome,
      llmStageOutcomeCounts: usage.attemptsByStageOutcome,
      llmProviderCounts: usage.providerCounts,
      llmErrorTypeCounts: usage.errorTypeCounts,
    };
  }
  const startedAt = now();

  // Counters live outside the try so the catch can record how far the run
  // actually got, rather than writing zeroes over a batch that filtered 200
  // postings and died on the 30th.
  let filteredCount = 0;
  let scoredCount = 0;
  let batchFatalReason: string | undefined;
  let cancelRequested = false;
  const scoreFailureCounts: Record<string, number> = {};

  function finalScoreFailureCounts(): Readonly<Record<string, number>> {
    const counts = { ...scoreFailureCounts };
    const recordedFailures = Object.values(counts).reduce(
      (sum, count) => sum + count,
      0,
    );
    const notAttempted = filteredCount - scoredCount - recordedFailures;
    if (notAttempted > 0) {
      counts.not_attempted_after_run_failure = notAttempted;
    }
    return counts;
  }

  // Every exit from here on must close the run row. It did not before: when
  // `scorer.score` threw (2026-08-16, a prompt template missing from the
  // container image), the row was left with `finishedAt: null` forever, which
  // `/health` reads as "still running" and `findLatestFinished` skips
  // entirely — so a hard failure was indistinguishable from a long batch, and
  // `lastSuccessfulRun` kept pointing at the previous day. The throw is
  // re-raised after bookkeeping: alerting is the caller's job, this only
  // makes sure the row tells the truth first.
  try {
    return await deliver();
  } catch (cause) {
    // docs/audit PR-004: whatever this run claimed but never got to notify
    // must not stay claimed past this run's own lifetime, or it becomes
    // unclaimable (and therefore unscoreable) until DEFAULT_STALE_CLAIM_MS
    // elapses for no reason -- the claim's job ends when this run does.
    postingsRepo.releaseUnresolvedClaims(runId);
    runsRepo.finish(runId, now(), "failed", {
      filteredCount,
      scoredCount,
      deliveredCount: 0,
      scoreFailureCounts: finalScoreFailureCounts(),
      ...usageCounts(),
    });
    throw cause;
  }

  async function deliver(): Promise<DeliverOutcome> {
    // The dedup barrier (AC-005, see the constructor doc comment above),
    // now atomic with the scoring-candidate claim (docs/audit PR-004) — run
    // before `findRunsSince("dedup", since)` below is computed, so this
    // run's own duplicate count is folded into the summary the same way a
    // scheduled dedup's would be, not double-counted or missed.
    const { claimed } = executeDedupAndClaim(
      db,
      dedupConfig,
      runId,
      now,
      triggeredBy,
    );

    const lastDelivery = runsRepo.findLatestFinished(
      "scoreAndDeliver",
      "success",
    );
    const since = lastDelivery?.finishedAt ?? null;
    const collectRuns = runsRepo.findRunsSince("collect", since);
    const dedupRuns = runsRepo.findRunsSince("dedup", since);

    const collected = collectRuns.reduce((sum, r) => sum + r.collectedCount, 0);
    const newCount = collectRuns.reduce((sum, r) => sum + r.newCount, 0);
    const duplicateCount = dedupRuns.reduce(
      (sum, r) => sum + r.duplicateCount,
      0,
    );
    const deduplicated = Math.max(0, newCount - duplicateCount);
    // Real per-source breakdown (docs/11-known-issues.md B2) — each collect
    // run now records which source(s) actually failed it, so this is a
    // union over the window rather than a guess.
    const failedSources = [
      ...new Set(collectRuns.flatMap((r) => parseFailedSources(r))),
    ];
    // Was already persisted per collect run (internal collector caps via
    // `CollectionResult.truncated`, external caps via the `truncated` flag
    // `executeIngestExternal` now accepts) but never read back into
    // anything an operator actually sees before this (docs/audit PR-015).
    const truncatedSources = [
      ...new Set(collectRuns.flatMap((r) => parseTruncatedSources(r))),
    ];

    const profileKeywords = deriveProfileKeywords(profile);
    const profileHash = hashProfile(profile, startedAt);
    const criteriaHash = hashCriteria(criteria);

    // Every candidate gets a recorded prefilter decision, not only the ones
    // that pass — this is the direct fix for docs/audit AC-019: "why isn't
    // this posting in the digest" used to be answerable only by re-running
    // the pure function by hand, with no trace of what a past run actually
    // decided or why.
    const filtered: Posting[] = [];
    for (const posting of claimed) {
      const result = applyPreFilter(
        posting,
        criteria,
        profileKeywords,
        startedAt,
      );
      postingEventsRepo.record({
        runId,
        fingerprint: posting.fingerprint,
        source: posting.source,
        sourceId: posting.sourceId,
        stage: "prefilter",
        outcome: result.passed ? "passed" : "rejected",
        reason: result.reason,
        criteriaHash,
        metadata: {
          tracks: result.tracks,
          anomalies: result.anomalies,
        },
        occurredAt: startedAt,
      });
      if (result.passed) filtered.push(posting);
    }
    filteredCount = filtered.length;

    const scoredEntries: ScoredPosting[] = [];
    const periodBlockedEntries: PeriodBlockedEntry[] = [];
    for (const posting of filtered) {
      // docs/11-known-issues.md C1: checked once per posting, the same
      // checkpoint granularity `batchFatalReason` below already uses --
      // never mid-Stage-A/B call, which is already a single bounded
      // request/retry cycle with its own timeout, not something worth
      // teaching to abort partway through. A cancel request seen here stops
      // the batch exactly like a permanent provider failure does: whatever
      // scored before this point is kept and delivered, nothing already
      // spent is thrown away, and every posting from here on is simply
      // never reached this run -- unclaimed and unnotified, reconsidered in
      // full next run.
      if (cancelRequested === false && isCancelRequested()) {
        cancelRequested = true;
        break;
      }
      // docs/audit PR-002: a posting that has already failed
      // `maxScoreFailures` times in a row does not get another model call --
      // it has had its fair chance at a transient issue resolving itself,
      // and spending another attempt on what is, by this point, very likely
      // a permanently malformed description is exactly the unbounded-retry
      // cost the finding warned against.
      if (
        postingsRepo.getScoreFailureCount(posting.fingerprint) >=
        maxScoreFailures
      ) {
        scoreFailureCounts.max_retries_exceeded =
          (scoreFailureCounts.max_retries_exceeded ?? 0) + 1;
        const scoredAt = now();
        postingEventsRepo.record({
          runId,
          fingerprint: posting.fingerprint,
          source: posting.source,
          sourceId: posting.sourceId,
          stage: "score",
          outcome: "failed",
          reason: "max_retries_exceeded",
          occurredAt: scoredAt,
        });
        scoredEntries.push({
          posting,
          outcome: {
            ...scoreFailureOutcome("max_retries_exceeded"),
            ...EMPTY_RECOMMENDATION,
          },
        });
        continue;
      }

      const result = await scorer.score(posting, profileHash, startedAt);
      const scoredAt = now();
      postingEventsRepo.record({
        runId,
        fingerprint: posting.fingerprint,
        source: posting.source,
        sourceId: posting.sourceId,
        stage: "score",
        outcome: result.ok ? result.verdict : "failed",
        reason: result.ok ? null : result.reason,
        metadata: {
          profileHash,
          criteriaHash,
          promptVersions: {
            stageA: STAGE_A_PROMPT_VERSION,
            stageB: STAGE_B_PROMPT_VERSION,
          },
          model: process.env.LLM_MODEL ?? "stub",
          ...(result.ok
            ? {
                inputTruncated: result.inputTruncated,
                stageACacheHit: result.stageACacheHit,
                stageBCacheHit: result.stageBCacheHit,
                evidenceRejectedCount: result.evidenceRejectedCount,
              }
            : {
                attempts: result.attempts,
                batchFatal: result.permanent,
                diagnostic: result.diagnostic,
              }),
        },
        occurredAt: scoredAt,
      });
      if (result.ok) {
        // A posting that failed before and now scores cleanly should not
        // carry a stale near-ceiling count into whatever reads it next.
        postingsRepo.clearScoreFailures(posting.fingerprint);
        // A period gate (period-gate.ts) means this posting is not a
        // rejection, just not reachable *yet* — routed to its own digest
        // section (CLAUDE.md §9) instead of scoredEntries, so it never
        // shows up as `discard`/`review` at all.
        if (result.periodGate) {
          periodBlockedEntries.push({
            posting,
            opensAtLabel: result.periodGate.opensAtLabel,
          });
        } else {
          scoredEntries.push({ posting, outcome: result });
        }
        scoredCount += 1;
      } else {
        scoreFailureCounts[result.reason] =
          (scoreFailureCounts[result.reason] ?? 0) + 1;
        // ADR-006 / docs/audit AC-009: a posting that fails scoring is not
        // discarded -- it carries the failure reason into the digest's
        // review section instead of silently vanishing. Deliberately not
        // counted in scoredCount, which evaluateDeliveryOutcome's
        // scoreFailureRateThreshold alert reads as "successfully scored";
        // this posting was not.
        postingsRepo.recordScoreFailure(posting.fingerprint, scoredAt);
        scoredEntries.push({
          posting,
          outcome: {
            ...scoreFailureOutcome(result.reason),
            ...EMPTY_RECOMMENDATION,
          },
        });
        // docs/audit PR-007: a permanent OpenRouter transport failure (a
        // revoked API key, an unsupported model) is a fact about this
        // run's configuration, not about this one posting -- every
        // remaining posting in `filtered` would fail for the identical
        // reason. Stopping here turns what used to be one doomed request
        // per remaining posting into exactly one. Postings not yet reached
        // are simply never scored this run; they stay unnotified and are
        // reconsidered in full next run once the config problem is fixed.
        if (result.permanent) {
          batchFatalReason = `Scoring stopped after a run-wide permanent provider failure (${result.reason})`;
          break;
        }
      }
    }

    const digest = composeDigest({
      runId,
      generatedAt: startedAt,
      scored: scoredEntries,
      periodBlocked: periodBlockedEntries,
      summary: {
        collected,
        deduplicated,
        filtered: filteredCount,
        scored: scoredCount,
        failedSources,
        truncatedSources,
      },
    });

    const notifyResult = await notifier.notify(digest);

    if (!notifyResult.ok) {
      // docs/audit PR-004: nothing was notified on this path -- every
      // claim this run holds must go back to the pool for the next run.
      postingsRepo.releaseUnresolvedClaims(runId);
      runsRepo.finish(runId, now(), "failed", {
        filteredCount,
        scoredCount,
        deliveredCount: 0,
        scoreFailureCounts: finalScoreFailureCounts(),
        ...usageCounts(),
      });
      return {
        runId,
        filtered: filteredCount,
        scored: scoredCount,
        delivered: 0,
        error: notifyResult.error.message,
      };
    }

    const deliveredAt = now();
    const sent = [...digest.recommended, ...digest.review];
    const notifiedFingerprints: string[] = [];
    for (const entry of sent) {
      // docs/audit PR-002: a *recoverable* scoring failure (any
      // scoreFailureReason short of max_retries_exceeded) is reported in
      // this digest, but deliberately left unnotified -- notifiedAt marks
      // "this vacancy was evaluated", not "a message about it was sent",
      // and a failure was never evaluated. Leaving it null is what keeps
      // the posting in findUnnotified's pool for another attempt next run.
      // Every other entry (a real apply/review verdict, or a failure that
      // has already exhausted maxScoreFailures) is marked normally.
      const failureReason = entry.outcome.scoreFailureReason;
      const isRecoverableFailure =
        failureReason != null && failureReason !== "max_retries_exceeded";
      if (!isRecoverableFailure) {
        notifiedFingerprints.push(entry.posting.fingerprint);
      }
      postingEventsRepo.record({
        runId,
        fingerprint: entry.posting.fingerprint,
        source: entry.posting.source,
        sourceId: entry.posting.sourceId,
        stage: "delivery",
        outcome: "delivered",
        occurredAt: deliveredAt,
      });
    }
    postingsRepo.markNotifiedMany(notifiedFingerprints, deliveredAt);

    // docs/audit PR-004: releases the claim on every posting this run
    // pulled in but did not end up notifying -- a prefilter reject, a
    // discard verdict, a recoverable scoring failure (ADR-038), or a
    // posting never reached because a permanent transport failure stopped
    // the batch early (ADR-039). Anything actually notified above is a
    // no-op here (the `notifiedAt IS NULL` guard in `releaseUnresolvedClaims`
    // excludes it), so this is safe to call unconditionally.
    postingsRepo.releaseUnresolvedClaims(runId);

    runsRepo.finish(
      runId,
      deliveredAt,
      // Priority order matters: a cancel request is checked first because
      // it can only ever be observed on an otherwise-healthy iteration
      // (the check above runs before any scoring attempt), so the two
      // conditions are mutually exclusive within one run in practice --
      // this ordering just documents that "cancelled" wins if that were
      // ever not true.
      cancelRequested ? "cancelled" : batchFatalReason ? "failed" : "success",
      {
        filteredCount,
        scoredCount,
        deliveredCount: sent.length,
        scoreFailureCounts: finalScoreFailureCounts(),
        ...usageCounts(),
      },
    );

    return {
      runId,
      filtered: filteredCount,
      scored: scoredCount,
      delivered: sent.length,
      ...(batchFatalReason ? { error: batchFatalReason } : {}),
      ...(cancelRequested ? { cancelled: true } : {}),
    };
  }
}

export interface StudyPlanOutcome {
  readonly corpusSize: number;
  readonly extractedCount: number;
  readonly highCompatibilityCount: number;
  readonly gapCount: number;
  readonly delivered: boolean;
  readonly error?: string;
}

/**
 * The testable core of `studyplan` (M10): assemble the corpus via
 * `MarketRepository`, compose the ranked plan, render it in pt-BR, send it
 * — "delivered to Telegram on request" (docs/10-milestones.md), not on the
 * nightly cron, so this has no `RunsRepository` row of its own the way
 * `collect`/`dedup`/`scoreAndDeliver` do: it reads the corpus, it never
 * mutates it, and there is nothing here for a missed-run alert to watch.
 */
export async function executeStudyPlan(
  db: Db,
  criteria: Criteria,
  profile: Profile,
  taxonomy: Taxonomy,
  notifier: TextNotifier,
  now: () => Date = () => new Date(),
  /** docs/audit PR-017 — which model's cached extractions/matches to read.
   * Defaults to the same env var `build-scorer.ts` reads for the real
   * scorer, so a studyplan run reads exactly what last night's
   * `scoreAndDeliver` run (under the same `LLM_MODEL`) actually wrote,
   * without this function needing to construct a scorer itself just to
   * learn its model string. */
  model: string = process.env.LLM_MODEL ?? "unknown",
): Promise<StudyPlanOutcome> {
  const profileHash = hashProfile(profile, now());
  const entries = new MarketRepository(db, criteria).loadCorpus(
    profileHash,
    model,
  );
  const plan = composeStudyPlan(entries, profile, taxonomy, now());
  const text = renderStudyPlanText(plan);

  const notifyResult = await notifier.sendText(text);

  return {
    corpusSize: plan.corpusSize,
    extractedCount: plan.extractedCount,
    highCompatibilityCount: plan.highCompatibilityCount,
    gapCount: plan.gaps.length,
    delivered: notifyResult.ok,
    ...(notifyResult.ok ? {} : { error: notifyResult.error.message }),
  };
}

function openDatabase(): Db {
  const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
  const db = createDatabase(databasePath);
  runMigrations(db);
  return db;
}

async function collectCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "job-name": { type: "string" },
      city: { type: "string" },
      "max-results": { type: "string" },
      "since-days": { type: "string" },
    },
  });

  const adHoc = {
    jobName: values["job-name"],
    city: values.city,
    maxResults: values["max-results"]
      ? Number(values["max-results"])
      : undefined,
  };

  // No flags means "run the configured cycle" — the same queries the cron
  // issues (`config/criteria.yaml`, `collection.queries`), so a manual run
  // and a scheduled one exercise the identical path. Any flag makes it a
  // deliberate one-off that overrides the configuration.
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const isAdHoc = Object.values(adHoc).some((value) => value !== undefined);
  const queries = isAdHoc ? [adHoc] : criteria.collection.queries;

  /**
   * `--since-days` widens the recency window for one manual run. It exists
   * for a specific, real situation: adding a query term to
   * `collection.queries` does **not** backfill, because everything the new
   * term finds was published before the one-day window (ADR-019). Without
   * this the only way to pick those up is to wait for them to be reposted.
   * Deliberately manual — the scheduled cycle always uses the configured
   * window.
   */
  const sinceDays = values["since-days"]
    ? Number(values["since-days"])
    : undefined;
  if (
    sinceDays !== undefined &&
    (!Number.isFinite(sinceDays) || sinceDays <= 0)
  ) {
    console.error("collect: --since-days must be a positive number");
    process.exitCode = 1;
    return;
  }
  const recency =
    sinceDays === undefined
      ? criteria.collection
      : { recencyDays: sinceDays, backfillDays: sinceDays };

  const outcome = await executeCollect(
    openDatabase(),
    collectorFor,
    queries,
    () => new Date(),
    criteria.collection.queryIntervalMs,
    recency,
  );

  if (outcome.error) {
    console.error(`collect (run ${outcome.runId}) failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `collect (run ${outcome.runId}): ${outcome.collected} collected, ` +
      `${outcome.normalized} normalized, ${outcome.tooOld} outside the recency window, ` +
      (outcome.unnormalizable > 0
        ? `${outcome.unnormalizable} with no normalizer, `
        : "") +
      `${outcome.isNew} new, ${outcome.alreadySeen} already seen`,
  );
}

function dedupCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      "similarity-threshold": { type: "string" },
      "window-days": { type: "string" },
      reset: { type: "boolean" },
    },
  });

  const db = openDatabase();
  // `--reset` clears existing flags first, so a corrected pass can re-decide
  // every posting. Needed because markDuplicate only ever sets: fixing the
  // rule does not un-flag what the old rule got wrong.
  if (values.reset) {
    const cleared = new PostingsRepository(db).clearDuplicateFlags();
    console.log(`dedup --reset: cleared ${cleared} existing duplicate flags`);
  }

  const outcome = executeDedup(db, {
    similarityThreshold: values["similarity-threshold"]
      ? Number(values["similarity-threshold"])
      : DEFAULT_DEDUP_CONFIG.similarityThreshold,
    windowDays: values["window-days"]
      ? Number(values["window-days"])
      : DEFAULT_DEDUP_CONFIG.windowDays,
  });

  console.log(
    `dedup (run ${outcome.runId}): scanned ${outcome.scanned}, ` +
      `${outcome.shadowCandidateCount} shadow candidate(s) logged (docs/audit PR-006 — ` +
      `none merged automatically; inspect posting_events or use "restore-duplicate" ` +
      `to reverse a legacy flag), ${outcome.comparisonTruncatedCount} posting(s) hit the comparison bound`,
  );
}

async function deliverCommand(): Promise<void> {
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );

  const db = openDatabase();
  const built = buildScorer(db, criteria, profile);
  if (!built.ok) {
    console.error(`deliver: ${built.error}`);
    process.exitCode = 1;
    return;
  }
  const { scorer, getUsage } = built;

  const notifier = new TelegramNotifier(loadTelegramConfig(), fetch, {
    deliveryStore: new DeliveryOperationsRepository(db),
  });

  const outcome = await executeDeliver(
    db,
    scorer,
    notifier,
    criteria,
    profile,
    getUsage,
  );

  if (outcome.error) {
    console.error(`deliver (run ${outcome.runId}) failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `deliver (run ${outcome.runId}): ${outcome.filtered} passed the pre-filter, ` +
      `${outcome.scored} scored, ${outcome.delivered} delivered`,
  );
}

async function studyPlanCommand(): Promise<void> {
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );
  const taxonomy = loadTaxonomy(
    process.env.TAXONOMY_PATH ?? "./config/taxonomy.yaml",
  );

  const db = openDatabase();
  const notifier = new TelegramNotifier(loadTelegramConfig());

  const outcome = await executeStudyPlan(
    db,
    criteria,
    profile,
    taxonomy,
    notifier,
  );

  if (outcome.error) {
    console.error(`studyplan failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `studyplan: ${outcome.corpusSize} postings in corpus, ${outcome.extractedCount} extracted, ` +
      `${outcome.highCompatibilityCount} high-compatibility, ${outcome.gapCount} gaps identified, delivered`,
  );
}

/**
 * Records a human decision — never surfaced again, regardless of a later
 * profile edit or re-scoring — the same core `PostingsRepository.discard`
 * `PostingsService` (M9's REST/MCP surface) calls, so the CLI and Hermes
 * can never implement "discard this posting" two different ways.
 */
function discardCommand(args: string[]): void {
  const { positionals, values } = parseArgs({
    args,
    options: { reason: { type: "string" } },
    allowPositionals: true,
  });

  const fingerprint = positionals[0];
  if (!fingerprint) {
    console.error("Usage: argos discard <fingerprint> [--reason <text>]");
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  const found = new PostingsRepository(db).discard(
    fingerprint,
    new Date(),
    values.reason ?? null,
  );

  if (!found) {
    console.error(`discard: no posting with fingerprint ${fingerprint}`);
    process.exitCode = 1;
    return;
  }

  console.log(`discard: ${fingerprint} will never be surfaced again`);
}

/**
 * Reverses a duplicate flag on one specific posting (docs/audit PR-006) —
 * the scoped counterpart `restoreDuplicate` gives shadow mode, next to
 * `dedup --reset`'s blunt "clear everything." Exists mainly for flags a
 * pre-shadow-mode `dedup` run already set: shadow mode itself never calls
 * `markDuplicate`, so nothing new needs this going forward, but a legacy
 * flag is still a real posting silently withheld from every later stage
 * until it is undone.
 */
function restoreDuplicateCommand(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true });

  const fingerprint = positionals[0];
  if (!fingerprint) {
    console.error("Usage: argos restore-duplicate <fingerprint>");
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  const restored = new PostingsRepository(db).restoreDuplicate(fingerprint);

  if (!restored) {
    console.error(
      `restore-duplicate: ${fingerprint} was not flagged as a duplicate`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`restore-duplicate: ${fingerprint} is active again`);
}

/**
 * The "a human who sees the failure reason can re-run scoring manually"
 * path ADR-006 promised but never built until now (docs/audit PR-024) —
 * SECURITY.md-adjacent documentation drift the audit flagged: a stated
 * guarantee with no supported operation behind it. Thin over
 * `PostingsRepository.rescore`, same shape as `discard`/`restore-duplicate`.
 */
function rescoreCommand(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true });

  const fingerprint = positionals[0];
  if (!fingerprint) {
    console.error("Usage: argos rescore <fingerprint>");
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  const rescored = new PostingsRepository(db).rescore(fingerprint);

  if (!rescored) {
    console.error(
      `rescore: ${fingerprint} does not exist, or its last scoring attempt did not fail`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `rescore: ${fingerprint} is eligible for the next deliver run again`,
  );
}

function reconcileDeliveryCommand(args: string[]): void {
  const { positionals, values } = parseArgs({
    args,
    options: {
      resolution: { type: "string" },
      "message-id": { type: "string" },
    },
    allowPositionals: true,
  });
  const operationId = positionals[0];
  const chunkIndex = Number(positionals[1]);
  const resolution = values.resolution;
  const messageId =
    values["message-id"] === undefined ? null : Number(values["message-id"]);
  if (
    !operationId ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0 ||
    (resolution !== "confirmed" && resolution !== "retry") ||
    (messageId !== null && (!Number.isInteger(messageId) || messageId < 1))
  ) {
    console.error(
      "Usage: argos reconcile-delivery <operation-id> <chunk-index> " +
        "--resolution <confirmed|retry> [--message-id <id>]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    new DeliveryOperationsRepository(openDatabase()).reconcileUncertainChunk(
      operationId,
      chunkIndex,
      resolution,
      new Date(),
      messageId,
    );
    console.log(
      `reconcile-delivery: ${operationId} chunk ${chunkIndex} marked ${resolution}`,
    );
  } catch (cause) {
    console.error(
      `reconcile-delivery: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "collect":
      await collectCommand(rest);
      break;
    case "dedup":
      dedupCommand(rest);
      break;
    case "deliver":
      await deliverCommand();
      break;
    case "studyplan":
      await studyPlanCommand();
      break;
    case "discard":
      discardCommand(rest);
      break;
    case "restore-duplicate":
      restoreDuplicateCommand(rest);
      break;
    case "rescore":
      rescoreCommand(rest);
      break;
    case "reconcile-delivery":
      reconcileDeliveryCommand(rest);
      break;
    default:
      console.error(
        "Usage: argos <collect|dedup|deliver|studyplan|discard|restore-duplicate|rescore|reconcile-delivery> [options]",
      );
      process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

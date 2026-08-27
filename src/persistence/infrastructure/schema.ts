import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One row per posting, keyed by fingerprint (ADR-007). Never deleted — the
 * corpus is a record of everything ever collected, including what a later
 * pre-filter (M5) rejects, because market questions in M10 are about the
 * whole market, not the shortlist (docs/05-domain-model.md).
 *
 * `firstSeenAt` is written once and never touched again by the upsert that
 * writes every other column; `lastSeenAt` moves on every sighting. See the
 * ADR-007 amendment and `postings-repository.ts`.
 *
 * `rawPayload` retains the source's raw JSON so a later Normalize change can
 * re-derive this row without a network request (ADR-007, principle 2).
 */
export const postings = sqliteTable(
  "postings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    // 'known' | 'unknown' — mirrors src/posting/domain/posting.ts's Location
    locationKind: text("location_kind").notNull(),
    locationCity: text("location_city"),
    // 'remote' | 'hybrid' | 'onsite' | 'unknown'
    workMode: text("work_mode").notNull(),
    // Null until stage A extraction populates it (M7) — Gupy-sourced
    // postings normalize with no seniority signal of their own.
    seniority: text("seniority"),
    experienceYears: integer("experience_years"),
    // Null when the source did not state one — the pre-filter's expiry rule
    // (M5) treats this as unknown, not automatically pass or fail.
    applicationDeadline: integer("application_deadline", {
      mode: "timestamp_ms",
    }),
    // When the SOURCE published the posting, as opposed to firstSeenAt,
    // which is when we first observed it. The recency window (ADR-019)
    // needs the former: a posting published last month and first collected
    // today is old, and firstSeenAt cannot say so.
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    // Null when the source provided no link. The digest (M6) treats the
    // original posting link as mandatory on every entry it can fill in.
    sourceUrl: text("source_url"),
    // ISO 3166-1 alpha-2, uppercase, or null when the source states none
    // (ADR-068). Not the same axis as `location_city`: that is where the work
    // happens, this is whose jurisdiction the hiring falls under — which
    // decides whether an internship is takeable from Brazil at all, and how
    // the nightly scoring budget is split (national first, international
    // capped). Null from a source listed in `criteria.sourceDefaultCountry`
    // reads as that source's country, so a legacy row backfills to national
    // without a data migration.
    country: text("country"),
    // Null when the source provided none — stage A (M7) has nothing to
    // extract requirements from, distinct from a genuinely empty posting.
    description: text("description"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    rawPayload: text("raw_payload").notNull(),
    // Set by the similarity dedup layer (ADR-0010) when this posting is a
    // near-duplicate, under a different fingerprint, of an earlier one.
    // Null means "not a known duplicate of anything."
    duplicateOfFingerprint: text("duplicate_of_fingerprint"),
    // Null until delivered. Set once and never cleared — a posting already
    // notified is never notified again (ADR-007, M6), the same "write once"
    // discipline firstSeenAt already follows.
    notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
    // A human decision, not a scoring outcome (M9 feedback, pulled forward
    // early) — a posting rejected here stays rejected across a profile
    // change, unlike `discard` the *verdict*, which is derived from
    // scoring and re-evaluates every time the profile does. Null means "no
    // decision"; once set, never cleared by anything but another explicit
    // discard call — there is no "undiscard" (see `postings-repository.ts`).
    discardedAt: integer("discarded_at", { mode: "timestamp_ms" }),
    // Free text, optional. Not read by any scoring or matching path — a
    // note for the human who made the call, not an input to the pipeline.
    discardReason: text("discard_reason"),
    // How many consecutive scoreAndDeliver runs have failed to score this
    // posting (docs/audit PR-002) — 0 means never failed, or reset by a
    // subsequent success. Read before every scoring attempt so a posting
    // stuck failing forever (a permanently broken description, not a
    // transient provider issue) eventually stops being retried, rather than
    // spending a model call on it every single night indefinitely.
    scoreFailureCount: integer("score_failure_count").notNull().default(0),
    // Null until the first scoring failure. Observability only — nothing
    // reads this to make a decision, `scoreFailureCount` does that; this is
    // what lets a human answer "when did this start failing" without
    // reconstructing it from posting_events.
    lastScoreFailedAt: integer("last_score_failed_at", {
      mode: "timestamp_ms",
    }),
    // Persisted admission barrier for paid scoring (docs/audit PR-004). Null
    // means "not currently claimed by any run." Set atomically, in the same
    // transaction as the dedup pass that precedes it, by whichever
    // scoreAndDeliver run picks this posting as a scoring candidate — so a
    // second process (a concurrent CLI invocation, or the API triggering a
    // run while a scheduled one is still in flight) sees it as unavailable
    // rather than independently selecting it too. `RunLock`
    // (`scheduling/domain/run-lock.ts`) already prevents this within one
    // process; this is what closes the same gap across two.
    scoringClaimedAt: integer("scoring_claimed_at", { mode: "timestamp_ms" }),
    // Which run holds the claim above — needed to release only *this* run's
    // claims (a posting still claimed by a still-running concurrent process
    // must not have its claim cleared out from under it).
    scoringClaimRunId: text("scoring_claim_run_id"),
  },
  (table) => [
    uniqueIndex("postings_fingerprint_unique").on(table.fingerprint),
    index("postings_company_idx").on(table.company),
  ],
);

/**
 * Stage A's cache (ADR-007: keyed `(fingerprint, promptVersion)`). One row
 * per posting per prompt version — re-extracting the same posting under the
 * same prompt is a cache hit, and a prompt change during M7 calibration
 * produces a new key rather than invalidating what came before, so old and
 * new prompt results can be compared side by side.
 *
 * `requirements` is the JSON-serialized `Requirement[]` (docs/04). Stored as
 * text, not normalized into rows, because it is never queried by field —
 * only ever read back whole for stage B or the digest.
 */
export const extractions = sqliteTable(
  "extractions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    promptVersion: text("prompt_version").notNull(),
    requirements: text("requirements").notNull(),
    // 'internship' | 'trainee' | 'junior' | 'mid' | 'senior' | null —
    // mirrors Posting.seniority. Cached alongside requirements (v2 prompt)
    // so a cache hit still has a value to write back onto the posting row.
    seniority: text("seniority"),
    experienceYears: integer("experience_years"),
    // hashExtractionInput(title, description) — docs/audit AC-006. Nullable
    // because rows written before this column existed have no way to know
    // what content produced them; ExtractionsRepository.find treats a null
    // (or mismatched) contentHash as a miss rather than trusting a legacy
    // row blindly.
    contentHash: text("content_hash"),
    // Which model actually answered (docs/audit AC-007) — nullable for the
    // same reason contentHash is: a legacy row predates this column and is
    // treated as a miss, not assumed to match whatever LLM_MODEL is set to
    // today.
    model: text("model"),
    extractedAt: integer("extracted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Composite identity (docs/audit PR-017): before this, uniqueness was
    // only (fingerprint, promptVersion), so a different model or content
    // under that same pair didn't get its own row -- it silently
    // overwrote whatever was there, even though `find` already treated a
    // model/contentHash mismatch as a miss. Switching LLM_MODEL back and
    // forth, or editing a description and reverting it, paid for the same
    // extraction repeatedly because the previous valid answer had already
    // been evicted by the very write that should have coexisted with it.
    uniqueIndex("extractions_composite_identity_unique").on(
      table.fingerprint,
      table.promptVersion,
      table.model,
      table.contentHash,
    ),
  ],
);

/**
 * Stage B's cache (ADR-007: keyed `(fingerprint, profileHash, promptVersion)`).
 * `profileHash` is what makes this cache correct rather than merely fast:
 * editing the profile must invalidate every match that used the old one, and
 * a stale match is worse than a missing one — it is a wrong answer that
 * looks computed (`05-domain-model.md`).
 *
 * `matches` is the JSON-serialized `Match[]` for every requirement in the
 * corresponding extraction, for the same reason `requirements` above is text:
 * read back whole, never queried by field.
 */
export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    profileHash: text("profile_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    matches: text("matches").notNull(),
    // hashRequirements(requirements) — docs/audit AC-007. Nullable for the
    // same reason extractions.contentHash is: a row predating this column
    // is a miss, not a trusted hit, since there is no way to know which
    // requirement set actually produced it.
    requirementsHash: text("requirements_hash"),
    // Which model actually answered (docs/audit AC-007) — same nullable/
    // miss-on-legacy-row treatment as extractions.model.
    model: text("model"),
    matchedAt: integer("matched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Composite identity (docs/audit PR-017) — same reasoning as
    // `extractions_composite_identity_unique`: a different model or
    // requirement set under the same (fingerprint, profileHash,
    // promptVersion) now gets its own row instead of overwriting a still
    // valid one.
    uniqueIndex("matches_composite_identity_unique").on(
      table.fingerprint,
      table.profileHash,
      table.promptVersion,
      table.model,
      table.requirementsHash,
    ),
  ],
);

/** Crash/retry checkpoint for each independently validated Stage B answer.
 * The completed `matches` manifest remains the fast whole-set cache; these
 * rows let a later run resume only missing requirements after a partial
 * provider failure. */
export const partialMatches = sqliteTable(
  "partial_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    profileHash: text("profile_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    requirementsHash: text("requirements_hash").notNull(),
    requirementIndex: integer("requirement_index").notNull(),
    match: text("match").notNull(),
    matchedAt: integer("matched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("partial_matches_semantic_identity_unique").on(
      table.fingerprint,
      table.profileHash,
      table.promptVersion,
      table.model,
      table.requirementsHash,
      table.requirementIndex,
    ),
    index("partial_matches_lookup_idx").on(
      table.fingerprint,
      table.profileHash,
      table.promptVersion,
      table.model,
      table.requirementsHash,
    ),
  ],
);

/**
 * One row per pipeline execution (docs/08-observability.md). `kind` names
 * the CLI stage that produced it ("collect", "dedup", and later
 * "scoreAndDeliver" per ADR-009) rather than a fixed enum — SQLite has no
 * real enum type, and the set of kinds grows as later milestones add stages.
 */
export const runs = sqliteTable("runs", {
  runId: text("run_id").primaryKey(),
  kind: text("kind").notNull(),
  // Non-secret actor identifier (role/source plus a short key digest) for
  // API-triggered runs; "internal" for scheduler/CLI. Enables attribution
  // and per-principal abuse investigation without persisting credentials.
  triggeredBy: text("triggered_by").notNull().default("internal"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  // 'success' | 'failed' — null while the run is still in progress.
  outcome: text("outcome"),
  collectedCount: integer("collected_count").notNull().default(0),
  normalizedCount: integer("normalized_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  alreadySeenCount: integer("already_seen_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  // Populated by a "deliver" run (M6): postings that passed the pre-filter,
  // were scored, and were included in the digest actually sent.
  filteredCount: integer("filtered_count").notNull().default(0),
  scoredCount: integer("scored_count").notNull().default(0),
  deliveredCount: integer("delivered_count").notNull().default(0),
  // The rest (docs/11-known-issues.md B2): a `collect` run with
  // `collectedCount: N, normalizedCount: 0` used to be unexplainable after
  // the fact — recency window, a missing normalizer and a source that
  // returned nothing all looked identical. These four columns are exactly
  // what `executeCollect` already computed in memory and previously
  // discarded once the run row was written.
  tooOldCount: integer("too_old_count").notNull().default(0),
  unnormalizableCount: integer("unnormalizable_count").notNull().default(0),
  // docs/audit/AUDIT_REPORT.md AC-012: without these, `collectedCount` (raw
  // items that passed a collector's own item schema) could not be checked
  // against how many the source actually returned, or how many silently
  // failed that schema before ever becoming a candidate `Posting`.
  //
  // Nullable, no default (docs/audit PR-014, reversing this same column's
  // original `.notNull().default(0)`): that default meant a run where
  // nothing ever set these columns -- every external-ingest run, since
  // `executeIngestExternal` has no receivedCount concept of its own --
  // silently read back as "0 received," indistinguishable from a source
  // that genuinely returned nothing. NULL is what "no query in this run
  // reported a reconcilable count" actually means; a real zero is now only
  // ever a query that ran and truly received nothing.
  receivedCount: integer("received_count"),
  schemaRejectedCount: integer("schema_rejected_count"),
  // The first error message seen this run, collector-reported or a caught
  // exception — null on a clean run. Free text, not structured: the sources
  // of an error message are too varied (an HTTP status line, a Zod issue, a
  // driver exception) to usefully type any tighter than `Error.message`.
  failureReason: text("failure_reason"),
  // JSON-serialized string[] of source names that failed this run — parse
  // with `parseFailedSources` (runs-repository.ts), the same manual
  // serialize/parse precedent `requirements`/`matches` already use rather
  // than drizzle's json column mode. Null, not "[]", when nothing failed.
  failedSources: text("failed_sources"),
  // Same shape as failedSources, for docs/audit AC-013: which source(s)
  // stopped paginating this run because they hit their own cap while the
  // upstream source's last page was still full — a "success" run that
  // silently left more results uncollected, previously invisible.
  truncatedSources: text("truncated_sources"),
  // Same shape as failedSources: every source at least one query targeted
  // this run, regardless of outcome (docs/audit PR-003). Needed alongside
  // failedSources to answer "did THIS source succeed", not just "did it
  // fail" — a source absent from both arrays was never attempted at all,
  // which is a different fact than it having quietly succeeded.
  attemptedSources: text("attempted_sources"),
  // JSON array with one reconcilable funnel per source/query. Aggregate
  // columns above remain for dashboards; this preserves where each drop
  // happened instead of merging several queries into one ambiguous total.
  sourceQueryStats: text("source_query_stats"),
  // scoreAndDeliver runs only, from OpenRouterClient.getUsage() (docs/audit
  // AC-015). llmAttempts counts every network attempt regardless of
  // outcome -- calls that never made it into scoredCount at all (a 429, a
  // timeout, a malformed body) were previously invisible to any persisted
  // number. llmCostUsd is a floor, not a reconciled total, whenever
  // llmAttemptsWithoutUsage is nonzero -- the provider's own dashboard is
  // still the source of truth for anything more precise.
  llmAttempts: integer("llm_attempts").notNull().default(0),
  llmCostUsd: real("llm_cost_usd").notNull().default(0),
  llmAttemptsWithoutUsage: integer("llm_attempts_without_usage")
    .notNull()
    .default(0),
  llmPromptTokens: integer("llm_prompt_tokens").notNull().default(0),
  llmCompletionTokens: integer("llm_completion_tokens").notNull().default(0),
  llmCachedPromptTokens: integer("llm_cached_prompt_tokens")
    .notNull()
    .default(0),
  llmBlockedByCircuit: integer("llm_blocked_by_circuit").notNull().default(0),
  llmOutcomeCounts: text("llm_outcome_counts"),
  // JSON maps containing only operational labels and counts. The nested
  // stage map makes a Stage A timeout distinguishable from a Stage B one;
  // provider/error-type maps expose routing and in-band provider failures
  // without storing prompts or model output.
  llmStageOutcomeCounts: text("llm_stage_outcome_counts"),
  llmProviderCounts: text("llm_provider_counts"),
  llmErrorTypeCounts: text("llm_error_type_counts"),
  // extraction_failed / matching_failed / max_retries_exceeded and, when a
  // batch-fatal error stops the loop, not_attempted_after_batch_failure.
  scoreFailureCounts: text("score_failure_counts"),
});

/**
 * One append-only row per (run, posting, stage) decision — the run↔posting
 * traceability docs/audit/AUDIT_REPORT.md AC-027 asks for, built to also
 * carry AC-019's prefilter-reason persistence rather than as two separate
 * mechanisms: a prefilter rejection is exactly one more "stage decision" a
 * posting has, the same shape as a score verdict or a delivery outcome.
 *
 * Deliberately not a mutable per-posting column set: `postings` already
 * changes on every re-collection (ADR-007), and a prefilter/score decision
 * is a function of *this run's* criteria/profile, not a permanent property
 * of the posting. Appending a new row when criteria changes preserves the
 * previous decision for comparison (REMEDIATION_PLAN.md AC-019's own
 * requirement) instead of overwriting it.
 *
 * No foreign keys to `runs`/`postings` (SQLite would allow them, but
 * neither table is ever deleted — ADR-007, docs/05 — so there is nothing a
 * constraint would protect against here that append-only + indexes don't
 * already give for the query patterns this exists to serve).
 */
export const postingEvents = sqliteTable(
  "posting_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    // Nullable for raw/schema/normalizer rejections that never became a
    // Posting and therefore never acquired a fingerprint.
    fingerprint: text("fingerprint"),
    source: text("source"),
    sourceId: text("source_id"),
    // "prefilter" | "score" | "delivery" — open string, not an enum, same
    // reasoning `runs.kind` already uses: the set of stages that report
    // here grows over time and SQLite has no real enum to constrain it.
    stage: text("stage").notNull(),
    // Stage-dependent: "passed"/"rejected" for prefilter, a Verdict or
    // "failed" for score, "delivered" for delivery.
    outcome: text("outcome").notNull(),
    // The specific reason, when there is one to give — a
    // PreFilterRejectionReason, a ScoreFailureReason, null on an
    // unqualified pass/success.
    reason: text("reason"),
    // Only set on "prefilter" events (docs/prefilter/domain/criteria-hash.ts)
    // — identifies which criteria version produced this decision, so a
    // later criteria change is visible as "a new decision", not a
    // contradiction of the old one.
    criteriaHash: text("criteria_hash"),
    // Versioned, non-sensitive structured identities for cache/model/input
    // audit. Free JSON object so stages can add fields without a migration.
    metadata: text("metadata"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("posting_events_run_id_idx").on(table.runId),
    index("posting_events_fingerprint_idx").on(table.fingerprint),
  ],
);

/** Durable Telegram delivery operation. Content identity, rather than runId,
 * lets a retrying scoreAndDeliver run resume the exact same digest while a
 * changed digest becomes a separate version. */
export const deliveryOperations = sqliteTable(
  "delivery_operations",
  {
    operationId: text("operation_id").primaryKey(),
    channelKey: text("channel_key").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull(),
    claimedBy: text("claimed_by"),
    claimExpiresAt: integer("claim_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("delivery_operations_channel_content_unique").on(
      table.channelKey,
      table.contentHash,
    ),
    index("delivery_operations_status_idx").on(table.status),
  ],
);

/**
 * Alerts that could not be delivered, held until the channel comes back
 * (ADR-067).
 *
 * Alerting runs over the same Telegram notifier as the digest, deliberately
 * — `docs/08-observability.md` rejects a second channel as "infrastructure
 * nobody maintains", and that reasoning still holds. The gap it leaves is
 * narrow and real: when Telegram itself is what failed, the alert *about*
 * that failure goes out over the channel that just broke, and its only trace
 * is a `logger.error` line in journald that nobody reads casually. That is
 * exactly what happened on 2026-08-25 (docs/11 B20) — the digest never
 * arrived and nothing said so.
 *
 * Queueing keeps the single-channel decision and closes the gap by moving
 * the alert in time rather than in space: it is redelivered on the next
 * cycle whose send succeeds, late but not lost.
 *
 * **`alertKey` is unique, not `text`** (ADR-067 Amendment 1). Deduplicating
 * on the message was wrong for exactly the alerts most likely to repeat: half
 * of them embed a value that changes every cycle — `staleForHours` grows,
 * `runId` differs per run — so a channel down for two days queued a dozen
 * near-identical rows per source and would have replayed them all as stale
 * news. The key names the *condition and its subject*; the row keeps the
 * newest text, so what finally arrives states the situation as of the last
 * time it was true.
 */
export const pendingAlerts = sqliteTable(
  "pending_alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Stable identity for the condition — see `Alert.key`.
    alertKey: text("alert_key").notNull(),
    text: text("text").notNull(),
    firstQueuedAt: integer("first_queued_at", {
      mode: "timestamp_ms",
    }).notNull(),
    lastQueuedAt: integer("last_queued_at", { mode: "timestamp_ms" }).notNull(),
    // How many times this same alert was raised while the channel was down.
    occurrences: integer("occurrences").notNull().default(1),
    // Why the send failed, most recently. Observability only — the redelivery
    // path does not branch on it.
    lastError: text("last_error"),
  },
  (table) => [uniqueIndex("pending_alerts_key_unique").on(table.alertKey)],
);

/** One stable, ordered checkpoint per Telegram message. Confirmed chunks are
 * immutable and skipped on resume. */
export const deliveryChunks = sqliteTable(
  "delivery_chunks",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    contentHash: text("content_hash").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    telegramMessageId: integer("telegram_message_id"),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("delivery_chunks_operation_index_unique").on(
      table.operationId,
      table.chunkIndex,
    ),
    index("delivery_chunks_operation_idx").on(table.operationId),
  ],
);

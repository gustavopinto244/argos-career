# 08 — Observability

## The problem this exists to solve

Principle 1 says a broken source degrades the digest instead of cancelling it.
`docs/02-architecture.md` already admits the cost: **a silently empty source
looks identical to a source with no matching postings.**

That is a failure mode the architecture deliberately creates. Without something
watching, the Gupy adapter can break on a Tuesday and the first symptom is
noticing, weeks later, that the digest has been thin. For a system whose whole
purpose is to stop job postings from being missed, silent degradation is the
worst possible failure.

Observability here is not operational polish. It is the counterweight to
principle 1.

## Logging

**What exists today: NestJS's built-in `Logger`, human-readable, to stdout.**
The long-running service (`SchedulerService`, and Nest's own boot output) logs
through it; the CLI writes to stdout with `console.log`/`console.error`, which
is correct for a command a person runs and reads. In production that means
`docker logs argos-career` gives readable lines, and nothing else consumes them.

> **This page described Pino, JSON output and journald integration for a long
> time, and none of it was ever built.** Pino was never a dependency,
> `LOG_LEVEL` was documented but read by no code, and the structured fields
> below were never emitted. Found by the audit of 2026-08-15 and corrected
> here rather than left as a promise: a specification nobody implemented is
> worse than an honest gap, because it makes every later reader trust
> something that is not there. The design is kept below, marked for what it
> is — a plan, not a description.

### Levels, and what each means

Conventions for the `Logger` calls that exist, and the contract structured
logging would have to keep if it lands.

| Level   | Meaning                        | Example                                                                    |
| ------- | ------------------------------ | -------------------------------------------------------------------------- |
| `error` | The run could not do its job   | Digest delivery failed                                                     |
| `warn`  | Degraded but continuing        | A source returned an error; scoring failed for a posting after all retries |
| `info`  | Run lifecycle and stage totals | Run started, 47 collected, 12 after dedup, 4 scored                        |
| `debug` | Per-posting decisions          | Why one posting was filtered out                                           |

**`warn` is the interesting level.** Everything that principle 1 lets the
pipeline survive lands here, which makes "warnings in the last week" the question
worth asking.

### Every log line carries the run — **not implemented**

The design below is what structured logging should emit. Nothing emits it
today; `runId` reaches the operator only through the `runs` table and the
CLI's own output.

```
runId        ULID, one per cron trigger
kind         collection | scoreAndDeliver — the two schedules of ADR-009
stage        collect | normalize | dedup | prefilter | score | deliver
source       when the line concerns one source
fingerprint  when the line concerns one posting
```

**What the gap actually costs.** Little, at this size: one operator, one
machine, a corpus in the hundreds, and `runs` rows that already answer "what
happened in this cycle" better than a log grep would. The `runs` table is the
real observability surface, and it is implemented.

**What would justify building it.** A second consumer reading logs
programmatically, a second machine to correlate across, or a debugging session
that `runs` rows genuinely cannot answer. Until one of those is true, adding
Pino would be work spent on a problem this project does not have — which is
why the correction here was to fix the document, not to install the library.

Two independent crons (ADR-009) means two kinds of run, each with its own
`runId`: a `collection` run touches `collect` through `prefilter`; a
`scoreAndDeliver` run touches `score` and `deliver` only, over postings the
collection runs already placed in the corpus. `runId` plus `kind` is what makes
a specific run reconstructable after the fact — without them, logs from several
collection cycles and one nightly delivery interleave in journald and cannot be
told apart.

**No personal data in logs.** No profile text, no evidence quotes, no recruiter
contact details. Logs go to journald on a server and get read casually; ADR-004's
boundary applies to them exactly as it applies to the repository. A posting is
identified by fingerprint and title, never by its full description.

## The `runs` record

Principle 2 — every stage independently re-runnable — needs state, and this is
where it lives. Designed in M4 alongside the schema; recorded here because it is
what makes both principle 2 and the alerting below possible.

Per run: `runId`, kind, non-secret `triggeredBy` principal identifier,
started/finished timestamps, outcome, and per-stage counts — collected,
rejected in normalization, deduplicated, filtered out, scored, failed to score,
delivered. Collection runs also retain `sourceQueryStats`, one funnel per
source/query with received/schema/business rejection, normalization, age,
new/already-seen, truncation and failure fields. A `null` upstream count means
the source could not report it; it is never silently converted into zero.

**A run that ends `failed` names what failed** (ADR-067). Every path that
closes a run as failed writes `failure_reason`; a row saying `failed` with a
null reason is a bug, not a run whose cause was unknowable. `docs/11` B20 is
what that costs — an `outcome: failed, failure_reason: null` delivery failure
was read as an LLM problem for a day, because the logs at that moment were
full of unrelated model timeouts.

Scoring runs persist attempts, outcomes, outcomes split by Stage A/B,
provider/error-type counts, score-failure counts, prompt/completion/cached token
totals, circuit-breaker refusals, provider-reported cost and attempts without
usable usage. The last count is important: when nonzero, local cost is
explicitly a floor rather than a reconciled provider bill. Posting-level
append-only score events carry a content-free failure diagnostic (stage,
category, `error_type`, provider/model, finish reason, generation id, HTTP
status and final-attempt latency); prompts, response content and profile
evidence are excluded.

Those counters are not decoration. They are the input to every alert below, and
the evidence behind the pre-filter cut numbers `02-architecture.md` measures
(84-97%, city-dependent).

## Durable Telegram delivery and reconciliation

Digest delivery is checkpointed in `delivery_operations` and
`delivery_chunks`, keyed by a hash of the destination and rendered content.
Each chunk moves through `pending`, `sending`, `failed`, `uncertain` or
`confirmed`; confirmed chunks store Telegram's `message_id` and are skipped on
retry. A lease prevents two workers from owning the same operation, and an
exact retry after completion performs no network call.

A timeout, connection loss, invalid success acknowledgement or 5xx is
`uncertain`: Telegram may have accepted the message even though ArgosCareer
could not prove it. Automatic retry would risk a duplicate, so the operation
stops for a human decision. Inspect the operation/chunk in SQLite or the error's
operation id, verify the target chat, then run one of:

```bash
npm run cli -- reconcile-delivery <operation-id> <chunk-index> --resolution confirmed --message-id <id>
npm run cli -- reconcile-delivery <operation-id> <chunk-index> --resolution retry
```

Use `confirmed` when the message is visible in Telegram; use `retry` only after
accepting the duplicate risk. Definite failures such as a 403 remain retryable
without this manual ambiguity step. This durability applies to digest
`notify()` calls; short operational alerts sent through `sendText()` still use
the direct, non-checkpointed path.

## Alerting

Delivered through the same Telegram notifier as the digest. A separate alerting
channel for a personal project would be infrastructure nobody maintains.

**An alert whose send fails is queued, not dropped** (ADR-067). The hole in
sharing one channel is specific: when Telegram is what broke, the alert about
it goes out over the broken channel, and its only trace is a `logger.error`
line — which is how `docs/11` B20 went unreported for a day. Rather than add a
second channel, a failed alert is held in `pending_alerts` and redelivered on
the next cycle whose send succeeds, prefixed with when it was first raised and
how often the condition recurred. Deduped on the alert text, oldest first,
capped per cycle against Telegram's per-chat rate limit, and drained on every
collection cycle — including quiet ones, which is when a backlog is most
likely to be waiting.

This makes a transient failure self-healing within one collection cycle. It
does **not** make alerting reliable: if the channel stays down, the alert
still never arrives. That remains an accepted limitation, for the same reason
the second channel is.

| Condition                                                                  | Why it matters                                  | Action                               |
| -------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| A source returns **zero postings** on consecutive **collection** runs      | The canonical silent failure of principle 1     | Alert naming the source              |
| A source **errors** on consecutive collection runs                         | Adapter broken or blocked                       | Alert with the error                 |
| Any eligible posting is left **without a score**                           | Immediate digest impact (ADR-052)               | Alert with failure breakdown         |
| Accounted **LLM operation failure rate** is above threshold (≥10 attempts) | Scorer/provider health, not proof of regression | Alert with outcome/routing breakdown |
| The **`scoreAndDeliver`** run did not start when scheduled                 | No digest that day (ADR-009)                    | Alert immediately                    |
| A **`collection`** run did not start when scheduled                        | Self-heals next cycle, a few hours later        | Alert only after two misses          |
| Delivery failed                                                            | The product did not reach the user              | Retry, then alert                    |

**Consecutive, not single — and the two run kinds need different patience.**
Collection runs every few hours (ADR-009), so one empty or missed cycle is
routine; a missed `collection` run alerts only after two in a row. A missed
`scoreAndDeliver` run means no digest that day, so it alerts on the first miss.
Conflating the two thresholds would either desensitize you to a missed digest or
page you for a normal quiet collection cycle.

Digest impact and regression are also deliberately not conflated. A single
small run can prove that postings were left without scores, so impact alerts on
the first affected posting. The operation-rate signal needs at least 10 fully
accounted network attempts. Neither is called a regression: that word is
reserved for a future alert with a version/baseline comparison and consecutive
degraded runs.

### The run summary is the everyday signal

Every digest ends with its run summary: collected, deduplicated, filtered,
scored, failed, plus any source that errored. This is what makes principle 1
honest — a source that failed is _visible in the product_, not merely absent from
it.

Most degradation gets noticed here, by a human reading a digest they were going
to read anyway, before any alert threshold trips. The alerts above are the
backstop for when nobody is reading.

## Health and metrics

**No Prometheus, no dashboards, no metrics backend.** The budget is ~150 MB at
rest on a server already running four other things, and a metrics stack would
cost more than the application it watches.

The `runs` table is the metrics store. Questions like "how many postings did the
pre-filter cut last month" are SQL queries against data that has to exist for
principle 2 anyway.

M9 adds an HTTP health endpoint reporting last successful run per kind, which is
what an external check — including Hermes — can poll.

### `npm run report:supply` — the metric that decides whether a source is worth it

Every source this project added (Gupy, CIEE, Sólides, Indeed, LinkedIn) was
decided on a one-off probe or raw volume; none had an ongoing number
answering "is it still worth the request and maintenance budget." That gap
is exactly what let Indeed go silent for six days before anyone noticed
(`docs/11-known-issues.md` B13) and let Catho accumulate four ADRs before
anyone measured that it delivers nothing (B14) — both found by a one-off
audit, not a number anyone was already watching.

**"Postings collected" is the wrong number to watch — it rewards volume a
source cannot use.** CIEE alone supplies 87% of the corpus by raw count and
a small single-digit fraction of it ever reaches `apply`; a source doubling
its collected count while its on-track rate halves would look like progress
on that metric and be a regression in practice. The number this project
actually needs is **on-track, in-region postings per source per week** —
what a source contributes to the outcome CLAUDE.md §1 cares about (cutting
triage time), not to the database's row count.

`report:supply` re-runs the real `applyPreFilter`/`classifyTrack` functions
against every active posting, bucketed by source and by the ISO week it was
first seen, evaluated with today's criteria — deliberately not a replay of
each posting's own historical pre-filter decision, which would mix outcomes
across however many criteria versions have shipped since. Delivered counts
come from the real `posting_events` history instead, since that decision is
recorded once, permanently, and does not need re-computing. Read-only,
never alerts, never blocks a run — a report for periodic human review, the
complement to `sourceFreshnessHours`'s automated silence check, not a
replacement for it.

## What is deliberately not done

- **Distributed tracing.** One process, sequential stages. `runId` in every log
  line is the whole requirement.
- **Log shipping.** journald on Atlas, read over SSH. Shipping logs off the box
  means another service to run and secure.
- **Alerting on latency.** A batch that takes twenty minutes instead of ten is
  not a problem; a batch that does not finish is, and that is covered by the
  missing-run alert.
- **Paging.** There is nobody on call. Every alert here is a Telegram message
  that can wait until morning.

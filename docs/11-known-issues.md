# 11 — Known issues

## What this page is for

`docs/10-milestones.md` records what each milestone deferred, organised by
milestone. That is the wrong shape for a problem found in production, which
belongs to no milestone and is discovered in the order incidents happen rather
than the order work was planned.

This page is the register for those. One entry per problem, each with what it
actually is, how it was observed, and what resolving it would take. An entry
leaves this page when it is fixed — in the same pull request that fixes it —
or when it is deliberately accepted, in which case it moves to an ADR that
says so.

**Nothing here is a nice-to-have.** Ideas and improvements belong in
`docs/10`. This page is for things that are wrong.

Opened 2026-08-16, after the incident recorded in
[PR #49](https://github.com/gustavopinto244/ArgosCareer/pull/49).

---

## Severity

|       | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| **A** | Breaks a promise the system makes. Fix before it happens again.             |
| **B** | Real defect with a bounded blast radius, or a latent one not yet triggered. |
| **C** | Correct as built, but the behaviour is misleading or undocumented.          |

---

## A1 — Scoring the backlog takes ~18 hours

**Status:** resolved — the premise no longer holds, confirmed against a real
mostly-cold run · **Found:** 2026-08-16, measuring the fix for #49

> **Resolution.** Stage B now issues its requirement calls concurrently,
> bounded by `scoring.stageBConcurrency` (default 8), with the first call of
> each posting issued alone to warm ADR-013's cached prefix.
>
> Measured on the same posting, same 25 requirements, cache-busted so both
> arms really call the model: **146.9 s → 10.2 s, a 14.4× speedup**, and cost
> fell rather than rose. Full reasoning, the measurement's caveats, and why
> batching was rejected for now, in
> [ADR-022](adr/022-bounded-concurrency-in-stage-b.md).
>
> **The backlog is now ~4–6 h, not ~18 h — but not the 2–3 h first guessed,
> because the bottleneck moved rather than disappeared.** See A3. This entry
> stays open until a real run replaces the extrapolation with a number.
>
> One correction to what this entry originally said: it claimed bounded
> concurrency "changes scoring behaviour". It does not. Same prompt per
> requirement, same isolation, same cache keys, same answers — only the
> waiting overlaps. Batching is the option that changes behaviour.
>
> **Checked against a real run, 2026-08-17 — still not the number this
> entry is waiting for.** The most recent real `scoreAndDeliver` run
> scored 40 postings in 830.9 s, but 34 of those 40 read a cached Stage A
> extraction rather than calling the model — see A3's matching note. A
> mostly-cached run cannot stand in for "the backlog," which is by
> definition mostly cold. Stays open.
>
> **Resolved, 2026-08-22 — not by fixing anything further, by re-measuring
> against what the pipeline actually does today.** This entry's own
> "310 postings currently pass the pre-filter" no longer describes the
> system: ADR-051 (reject-unknown-track, 2026-08-17) and the keyword work
> since have cut that number by roughly two orders of magnitude. Queried
> Atlas's real corpus directly before running anything, to know what a real
> run would actually face rather than guess: of 3,182 unclaimed, unnotified
> postings, only a handful pass the pre-filter today (5, on the run
> measured below) — nothing close to a multi-hour backlog exists to
> measure.
>
> Ran a real `deliver` anyway (`01M0N5T4MWARP2EKX3SF6DN4CM`) rather than
> stopping at "the backlog doesn't exist" as an assumption: **5 filtered, 5
> scored, 3 delivered, 8 real LLM attempts (4 Stage A/B pairs genuinely
> cold — `stageACacheHit: false` — one posting fully cache-hit), 0
> failures, 0 timeouts, $0.0014, and the entire cycle — pre-filtering the
> whole ~3,187-posting corpus, 4 cold Stage A/B pairs, composing and
> sending a real Telegram digest — finished in 62 seconds.** Not a
> handful-of-cache-hits number: 4 of those 5 postings had never been scored
> under this profile/criteria hash before.
>
> **This closes both the volume half and the latency half of the original
> concern.** Volume: the pre-filter now admits a small enough fraction of
> the corpus that "the backlog" in this entry's original 18-hour sense no
> longer exists — a nightly cycle processes single-digit postings, not
> hundreds. Latency: A3's `40–67 s/posting` Stage A estimate, extrapolated
> from ADR-022 measurements taken _during_ the B6/ADR-052 incident, does
> not hold post-fix either — 4 cold pairs finished in well under a minute
> combined. Neither number this entry was built around is still true, and
> both changed for real, verified reasons (ADR-051's admission rate, ADR-052's
> reasoning-token cap), not by coincidence.
>
> **What would reopen this:** if the pre-filter's admission rate ever grows
> back toward the low-hundreds this entry originally measured (a criteria
> change, a new high-volume source), the same latency-per-posting math
> would need re-checking at that scale — today's 62-second run does not
> prove a 300-posting cold run would scale linearly, only that neither the
> volume nor the per-posting cost that made 18 hours plausible are still
> true today.

Stage B issues one sequential model call **per requirement**. One real posting
measured end to end against `deepseek/deepseek-v4-flash-0731`:

|              |                                  |
| ------------ | -------------------------------- |
| Calls        | 26 (1 stage A + 25 stage B)      |
| Duration     | **213.8 s**                      |
| Cost         | $0.0026                          |
| Prompt cache | 25 088 / 35 421 tokens hit (71%) |

310 postings currently pass the pre-filter. Extrapolated: **≈ 18.4 hours** and
~$0.80 for one pass. The cost is irrelevant; the wall-clock is not. A nightly
cycle starting at 03:00 finishes in the evening, and ADR-009's "the only
window the model runs in" stops being true.

The 71% cache hit rate says ADR-013's static-prefix design is working, so the
remaining time is latency × 26 round trips, not prompt size.

**Related:** A2 — an 18-hour run and a scheduler with no overlap guard are
only compatible by luck. Concurrency shortens the run; it does not add the
guard, and A2 stays open.

**Also related:** concurrency makes HTTP 429 reachable where sequential calls
never approached a rate limit, and `OpenRouterClient` folds a non-2xx into the
retry budget instead of backing off. Same shape as B3. Not triggered yet;
noted so it is not a surprise if it is.

---

## A3 — Stage A is now the pipeline's bottleneck

**Status:** resolved — see A1's 2026-08-22 entry, same measurement answers
both · **Found:** 2026-08-16, measuring ADR-022

With Stage B down to ~10 s per posting, the dominant cost is Stage A: one call
per posting, emitting the entire requirement list as JSON, which is the
largest completion the pipeline produces. Back-solved from the ADR-022
measurements it sits around **40–67 s per posting**, against ~10 s for all 25
Stage B calls combined.

Stage A cannot be split the way Stage B was — it is a single call, not a fan
out. The levers are different ones:

- **Concurrency across postings.** ADR-022 rejected this for Stage B (option
  D) because Stage B already had a better axis. Stage A does not, so the
  reasoning that rejected it does not carry over and it should be
  re-evaluated on its own terms.
- **A smaller completion.** Much of Stage A's output is requirement text
  copied near-verbatim from the posting. Whether it needs to be is a prompt
  question, and a prompt change means a new version and recalibration.

Both are scoring-adjacent enough to want an ADR, and neither should be
attempted while the numbers are extrapolations from a handful of postings.
**Measure the first real backlog run first.**

> **A real run measured, 2026-08-17 — still not the measurement this entry
> needs.** Queried Atlas's production database directly: the most recent
> real `scoreAndDeliver` run (`01M05CE3730E1V91P2APN78XG9`) scored 40
> postings in 830.9 s (~20.8 s/posting average) — much faster than this
> entry's 40–67 s/posting Stage A estimate. Checked why before trusting
> it: only **6 of the 40** postings got a _new_ Stage A extraction during
> the run's window; the other extractions it read already existed
> (ADR-007's per-fingerprint cache), most of them from earlier work (M7
> calibration and similar). **The average is fast because it is mostly
> cache hits, not because cold Stage A got cheaper.** This run still does
> not answer what this entry is actually asking — real Stage A cost at
> backlog scale, mostly cache _misses_. That measurement has not happened
> yet. Left open.

> **Resolved, 2026-08-22 — the mostly-cache-miss run this entry asked for,
> finally measured.** Same run as A1's closing entry
> (`01M0N5T4MWARP2EKX3SF6DN4CM`): 4 of 5 scored postings were genuinely
> cold (`stageACacheHit: false`), 8 real LLM attempts total (4 Stage A + 4
> Stage B), 0 timeouts, 0 failures, whole cycle in 62 seconds. Back-solving
> the same way this entry's original 40–67 s/posting estimate was
> derived: 4 cold Stage A/B pairs fit inside 62 seconds _combined_, well
> under 20 s/posting for the full pair, let alone Stage A alone. B6/ADR-052
> (the `reasoning.max_tokens` cap, landed 2026-08-18) is the concrete,
> already-documented reason this changed — this entry's own 40–67 s
> estimate was extrapolated from ADR-022 measurements taken while B6's
> reasoning-token blowup was still live and undiagnosed, the same
> incident A1 references. There is no longer a bottleneck to split
> concurrency across: **both options this entry proposed (concurrency
> across postings, a smaller Stage A completion) are moot** — there is no
> multi-hour run left for either to shorten.

---

## A2 — The scheduler has no overlap guard

**Status:** fixed by ADR-024 · **Found:** 2026-08-16, sweeping after #49

`SchedulerService` registered both cron jobs with
`onTick: () => void this.run…Cycle()` and nothing tracked whether the
previous tick was still running. This stopped being theoretical the same
day: `POST /runs/deliver` was called manually to test a build while the
scheduled cycle's own multi-hour run (ADR-022) was in flight, and only a
direct database check established the two had not actually collided.

> **Resolution.** `RunLock` (`scheduling/domain/run-lock.ts`), one
> in-memory, per-kind lock shared by `SchedulerService` and `RunsService`
> via the same DI token — sufficient because both live in one process
> (`app.module.ts`). A locked-out REST/MCP call gets 409; a locked-out cron
> tick logs and skips, no alert (an expected outcome, not a failure).
> Mutation-checked at both layers — the core `tryAcquire` guard, disabled,
> fails 6 tests including two real concurrent-HTTP-request integration
> tests, not just the pure unit tests. Full reasoning in
> [ADR-024](adr/024-scheduler-overlap-guard.md).
>
> **Explicitly not covered:** a separate process (e.g. the CLI invoked by
> hand via `docker exec`) racing the running server. An in-memory lock
> cannot see across process boundaries; ADR-024 states this as a deliberate
> limitation, not solved speculatively for a risk that has not been
> observed.

---

## B1 — CIEE is exempt from the recency window

**Status:** resolved by decision (ADR-019 Amendment 3) · **Found:**
2026-08-16, explaining a `normalized: 0` run

ADR-019 filters **collected** postings by publication date, with
`recencyDays: 1`, and deliberately lets a posting with no date through:
absence of a date is not evidence of an old posting.

In production, **every** CIEE posting has no date, and the Gupy figure has
gotten worse since this entry was first written:

```
source  count  published_at IS NULL
ciee     2079  2079   (100%)
gupy      558   436   (78%, was 44% on 2026-08-15)
```

CIEE supplies 89% of the corpus, so for the dominant source the window is not
lenient — it is inert. This is why 2092 postings entered in a single cycle on
2026-08-16 and why scheduled runs alternate between `normalized: 0` (Gupy
only, all older than a day) and thousands.

Not a bug in the sense that the code does what ADR-019 says. The problem is
that ADR-019's reasoning assumed the undated posting was the exception.

> **Mitigated at the pre-filter, 2026-08-16.** `criteria.maxAgeDays`
> (ADR-011 Amendment 4) stops an old posting from reaching the LLM, with the
> same `firstSeenAt` fallback this entry proposed, and
> `criteria.undatedBacklogCutoverAt` (Amendment 5) turns that into an
> immediate business rule rather than a week-long wait: every undated
> posting collected up to 2026-08-16T12:15:00Z — the entire pre-existing
> CIEE backlog — is presumed already past `maxAgeDays` outright, once this
> code is deployed. **This is still a pre-filter rule, not a collection
> rule — a different stage from the one this entry is actually about.** It
> bounds what gets scored, which is the concrete cost this project pays
> (Stage A/B calls). It does nothing about what ADR-019 governs: the corpus
> itself still grows without limit, every CIEE posting is still collected
> and stored regardless of age, and `recencyDays: 1` is still inert for
> 100% of CIEE. Left open for that reason.
>
> **Deployment note:** this needs a container restart to take effect, and a
> restart mid-run kills whatever `scoreAndDeliver` cycle is in flight — no
> graceful drain exists, so the run's row orphans (C1) and that night's
> digest does not go out. Deploy only between cycles, never during one.

**Resolving the rest** means deciding what "recent" means for a source that
never publishes dates, at the **collection** stage — not re-admitting the
whole corpus on the first run that adopts it. Amends ADR-019.

> **Decided, 2026-08-22 (ADR-019 Amendment 3).** Re-confirmed there is
> still no date-like field anywhere in CIEE's real payload (`ciee-schema.ts`'s
> own doc comment, checked against the full fixture sample again rather than
> trusted from memory) — this genuinely cannot be fixed the way Gupy's
> `publishedAt` was, there is no fact to map. Measured the actual cost of
> leaving it unbounded instead of guessing: CIEE's real production growth,
> read day by day from Atlas (`docker exec argos-career node
...better-sqlite3...`), is a one-time 2,091-row backfill on enablement day
> followed by a steady **~100-170 new rows/day** — not runaway. The whole
> database, every table combined, measures 44.9 MB after six days of real
> operation. **Decision: no new collection-stage mechanism.** "Recent"
> already means what this entry's own 2026-08-16 mitigation made it mean —
> `firstSeenAt`, bounded by `maxAgeDays`/`undatedBacklogCutoverAt` at the
> pre-filter, which is the layer that actually spends money. Building
> storage pruning now would defend against a cost the measurement shows
> does not exist. A concrete revisit trigger is recorded instead of a vague
> "someday": 500 MB total database size, or any real `df`/`docker stats`
> disk pressure on Atlas, whichever comes first. Full reasoning and the
> measurement in ADR-019 Amendment 3.

---

## B2 — The `runs` table records no failure reason

**Status:** fixed, pending confirmation against a real failure · **Found:**
2026-08-16, trying to explain a collect run

`executeCollect` computes `tooOld`, `unnormalizable` and a first `error`
string, and returns all three on its outcome. None is persisted: the `runs`
table has counters and an `outcome` enum, and nothing else.

So a row reading `collectedCount: 313, normalizedCount: 0` cannot be explained
after the fact — recency window, missing normalizer, and a source that
returned nothing are indistinguishable. Worse, a single source failing among
several still records `success`, by design (principle 1, partial failure is
degraded not down), with nothing in the row naming which one failed.

`docs/08` already identifies silent degradation as the failure mode this
project most needs to catch. This is a hole in exactly that.

> **Resolution, 2026-08-17.** Four columns added to `runs`
> (`too_old_count`, `unnormalizable_count`, `failure_reason`,
> `failed_sources` — migration `drizzle/0010_amused_winter_soldier.sql`,
> additive only, no backfill for existing rows). `executeCollect` now
> writes all four on both the normal-finish and the caught-exception path;
> `failedSources` is a `Set<string>` built from every point that already
> knew which source it was looking at (no collector registered, a
> collector-reported error, an unregistered normalizer), serialized to
> JSON text (`parseFailedSources` reads it back), the same manual
> serialize/parse precedent `requirements`/`matches` already use rather
> than a new drizzle json-mode column.
>
> **The second symptom is also fixed:** `executeDeliver`'s `failedSources`
> was hardcoded to `["gupy"]` regardless of which source actually failed.
> It now unions `parseFailedSources` over every `collect` run in the
> delivery window — a real per-source breakdown, not a guess.
>
> **Not yet observed against a real failure in production** — covered by
> unit tests (`test/persistence/runs-repository.test.ts`,
> `test/cli/main.test.ts`) exercising the exact `collectedCount: N,
normalizedCount: 0` scenario this entry describes, but the real value is
> reading an actual failed run's row on Atlas once one occurs.

---

## B3 — Telegram delivery has no pacing and no 429 handling

**Status:** fixed, pending confirmation against a real large digest ·
**Found:** 2026-08-16, sizing the digest A1 will produce

`TelegramNotifier` splits a digest into 4096-byte chunks and sends them in a
loop with no delay between them. `sendMessage` treats any non-2xx as a plain
failure — a 429 is not retried and `retry_after` is not read.

Never exercised beyond a handful of messages. The first run after A1 drains
will produce a digest large enough to matter, and Telegram rate-limits a
single chat at roughly one message per second.

> **Resolution, 2026-08-17.** `TelegramNotifier` now paces every chunk after
> the first by `pacingMs` (default 1,100 ms — over Telegram's stated ~1
> msg/s/chat limit on purpose, not exactly at it) before sending, and
> retries a `429` up to `maxRetries` (default 3) times, sleeping
> `retry_after` (parsed from Telegram's real response shape,
> `parameters.retry_after`, in seconds) before each retry, capped at
> `retryAfterCapMs` (default 30 s) against a malformed or unexpectedly
> large stated value. A `429` with no parseable `retry_after` falls back to
> a conservative 5 s wait rather than retrying immediately. Only `429` gets
> this treatment — a plain `5xx` still fails on the first non-2xx response,
> unchanged, per the existing "stops sending further chunks once one chunk
> fails" contract.
>
> The ADR-007 interaction this entry named is preserved exactly: retries
> happen _within_ one `sendMessage` call, so exhausting them still means
> the whole digest is marked undelivered and re-sent next run, not that a
> chunk is lost silently.
>
> Covered by fake-timer tests (`test/delivery/infrastructure/telegram-notifier.test.ts`)
> — pacing actually delays the next chunk, a `429` retries and succeeds
> once `retry_after` elapses, retries are bounded, a missing `retry_after`
> falls back to the default, and an excessive one is capped. **Not yet
> exercised against Telegram's real API** — no test here claims to know
> Telegram's actual rate-limit behavior beyond its documented response
> shape.
>
> **Follow-up, 2026-08-17 (docs/audit AC-022).** A post-remediation audit
> found the one piece this entry's own fix left open: `fetch` had no
> timeout at all. A hung TCP connection (not an HTTP error Telegram
> itself returns) could hold the delivery run's `RunLock` open
> indefinitely, blocking every later scheduled run behind it — worse than
> the "re-sends whole digest next run" cost this entry already accepted
> as an ADR-007 trade-off. `TelegramNotifier` now wraps every
> `sendMessage` attempt in an `AbortController` timeout (`timeoutMs`,
> default 20 s), the same pattern `GupyCollector`/`OpenRouterClient`
> already use.
>
> **Second follow-up, 2026-08-17 (ADR-048): AC-022's remaining delivery
> gap is implemented.** Digest chunks now have durable operation/chunk
> checkpoints keyed by destination and rendered-content hashes. A valid
> Telegram success acknowledgement must contain `ok: true` and an integer
> `message_id`; confirmed chunks survive restart and are skipped on retry.
> Definite failures resume from the failed chunk. Ambiguous failures
> (network/timeout/5xx/invalid acknowledgement, including a crash after send
> before confirmation) stop in `uncertain`/`sending` and require the explicit
> `argos reconcile-delivery` command to mark the chunk confirmed or authorize
> a retry. This provides resumability without falsely promising exactly-once
> delivery from an API that has no caller-supplied idempotency key. Restart,
> lease takeover, manifest mismatch and partial retry are covered against a
> real temporary SQLite database. A live ambiguous Telegram failure has not
> been manufactured in production; short `sendText()` alerts remain outside
> the durable digest path and are documented as such.

---

## B4 — Jooble's API returns 403 regardless of key

**Status:** parked — investigated as far as reasonably possible, no path
forward found · **Found:** 2026-08-16 · **Closed off:** 2026-08-16

`POST https://jooble.org/api/{key}` returns 403 with a real registered key.
The decisive measurement is that it returns **byte-identical** 403s (4631
bytes) for a real key and for `00000000-0000-0000-0000-000000000000` —
from this machine and from Atlas, with the honest User-Agent and with curl's
default, and for `GET` as well as `POST`.

A response that does not vary with the key means nothing behind it has
evaluated the key.

This **falsifies the finding recorded in commit `d971c76`**, which read a
403 without Cloudflare markers as Jooble's application rejecting a bad key,
and concluded a valid key would get through. The absence of `cf-mitigated`
distinguishes less than it appeared to. `scripts/fixture-jooble.ts` now
records both probes and the correction.

> **Follow-up, 2026-08-16.** The obvious next step — log into
> `jooble.org/api/about`, confirm the key is active, and either read the
> documented request format or capture a working request from a live
> "try it" console via the browser's network inspector — was attempted and
> did not turn up a path forward. The account side offers nothing that
> explains a 403 identical for a real and a fake key; whatever is blocking
> this sits somewhere this project has no visibility into (the account, a
> plan restriction, an IP-range block, or the endpoint having moved).
>
> **Parked, not actively pursued further.** Forging a browser User-Agent to
> get past an unexplained block is not on the table (CLAUDE.md §6), and
> without a working request to observe, no fixture can be captured and no
> honest Zod schema can be written (CLAUDE.md §15 — do not invent a fact
> that can be checked, and this one currently cannot be). Worth noting while
> parking it: Jooble is an **aggregator** (`docs/02-architecture.md`'s
> source-topology table) — "high by construction" overlap with whatever it
> republishes, which for a Brazilian internship search likely means
> Gupy/CIEE postings a second time. Getting it working would also mean
> building the cross-source dedup layer `docs/02` already flags as
> necessary "the moment one [aggregator] is added" — real additional work,
> not just a fixture and a schema. That cost, on top of a block with no
> known fix, is why this is parked rather than escalated (e.g. a support
> ticket to Jooble) for now.
>
> `JOOBLE_API_KEY` stays in `.env`/`.env.example` and the fixture script
> stays in `scripts/` — inert, no cost to leaving them — in case the block
> resolves itself later (a plan change, a fixed endpoint) without this
> being revisited deliberately.

---

## B5 — Three hot-path inefficiencies, measured against a corpus that hasn't grown into them yet

**Status:** fixed, confirmed against production ·
**Found:** 2026-08-17, a post-remediation audit (docs/audit AC-032) ·
**Implemented:** 2026-08-17 (ADR-050)

Three separate spots do more work than they need to, none yet a real cost
at this project's current corpus size:

- **Stage B re-reads and re-renders on every requirement.**
  `buildStageBPrompt` (`prompts.ts`) calls `loadTemplate` — a synchronous
  `readFileSync` — and rebuilds the full profile evidence catalog
  (`buildEvidenceCatalog`/`formatEvidenceCatalog`) from scratch, once per
  requirement. A 25-requirement posting does this 25 times for output
  that would be identical within one `match()` call, if not for
  `evaluatedAt` being captured fresh per requirement rather than once for
  the whole call (`stage-b-matcher.ts`'s own comment explains why: two
  provenance checks within _one_ requirement's prompt must agree on "what
  time is it," not that every requirement in a posting needs to).
- **Layer-2 dedup is O(n²) in the worst company group.**
  `dedupSimilarPostings` (`dedup-similar-postings.ts`) compares each
  candidate against every earlier posting already `seen` in its company
  group via `.find()` — fine at this project's per-company posting
  counts, not fine for a single employer with thousands of listings.
- **Upsert and notification are per-item**, not batched — a
  select-then-write-then-select per posting, a mark-notified call per
  posting delivered.

**Resolution, 2026-08-17.** The changes are semantic-preserving bounds and
elimination of repeated work, not a claimed benchmark win:

- prompt templates are cached by resolved path and Stage B renders the
  invariant evidence prefix once per posting; one `evaluatedAt` now owns the
  profile hash, prompt, provenance checks and cache timestamps;
- layer-2 comparison is capped at 500 recent in-window postings per candidate,
  and `comparisonTruncatedCount` makes every activation of that cap visible;
  layer 2 is shadow-only, so truncation cannot suppress a posting;
- collection uses one transaction per query/batch and notification updates
  delivered fingerprints together, while retaining the existing upsert and
  write-once semantics.

Regression tests prove output/order/cache and persistence behavior. No
wall-clock or fsync benchmark has yet been run on the production corpus, so
this entry does not claim a measured latency improvement. Revisit measurement
when `comparisonTruncatedCount` becomes nonzero, collection volume grows, or
A1/A3 receive their cold-cache backlog benchmark.

> **Benchmarked against real production data, 2026-08-22.** Queried Atlas's
> live database directly (`docker exec argos-career node ...better-sqlite3...`,
> read-only). The corpus has grown 6× since this entry was opened
> (3,067 active postings now, ~500 when ADR-050 landed) — enough growth to
> actually test the bound, not just restate the original theory:
>
> - **Layer-2 dedup, the O(n²) risk.** 20 consecutive real `dedup` runs
>   against the full corpus: **107–461 ms each**, no outliers. The largest
>   real company group is "Confidencial" at 121 postings — comfortably under
>   the 500-comparison cap ADR-050 set. `comparison_bound_reached`
>   (`posting_events.outcome`, emitted every time the cap actually
>   activates) has **zero occurrences in the database's entire history** —
>   the cap has never fired once, on any run, ever. The worst-case cost
>   this entry worried about has not materialized at 6× the corpus size
>   that prompted it.
> - **Collection, the per-item write concern.** 20 recent real `collect`
>   runs: consistently 236–330 s (one 764 s outlier, not investigated
>   further — CIEE alone issues ~58 sequential HTTP requests at ADR-011's
>   1.5 s politeness delay, so network variance on a mini PC easily
>   explains a single slow run without implicating the batching change).
>   Collection duration is dominated by network I/O and the deliberate
>   politeness delay, not by write batching — expected, and consistent
>   with ADR-050 never having claimed collection would get dramatically
>   faster, only that it would stop doing avoidable per-item work.
> - **Stage B's repeated-render cost** was not independently re-measured
>   here — it is folded into A1/A3's Stage A/B backlog numbers, which get
>   their own real measurement below, and re-deriving it separately would
>   only restate that entry's data under a different name.
>
> No regression, no residual hot path at today's corpus size. Status
> promoted from "bounded, not yet benchmarked" to fixed and confirmed —
> the last of the three original conditions for revisiting ("collection
> volume grows") is the one that was actually met, and it changed nothing
> concerning.

---

## B6 — Stage A/B's LLM call failure rate was 70% on the 2026-08-17 calibration run

**Status:** resolved, confirmed against production ·
**Found:** 2026-08-17, calibration run `01M09542FFR83M5V8HPSAQ68F3`

`runs.llm_outcome_counts` for that run: 125 attempts, 37 `success`, 31
`timeout`, 57 `invalidOutput` ("Unexpected OpenRouter response shape"), 0 of
every other category. Only 5 of the 28 pre-filter-passing postings finished
scoring; the rest fell back to the `lowConfidence` review path (ADR-006),
which is why most of that run's digest read "⚠ Não foi possível pontuar
automaticamente" instead of a real score.

Not investigated further this session — out of scope for the pre-filter
work ADR-051 covers, and the pre-filter changes in ADR-051/Amendment 1
(28 → 6 pre-filter passes) mean the next calibration run pays for far fewer
Stage A/B calls, which will itself shrink the sample this was measured on.
Worth root-causing if it recurs: candidates not yet checked are
`LLM_MODEL`'s actual output shape against what `openrouter-client.ts`
expects, whether `timeout` (30s) is short for this model specifically, and
whether the 57 `invalidOutput` failures cluster on particular postings
(retried into a different failure each time, per the transcript) or are
uniform across the batch.

**Planned check, 2026-08-18:** re-run `argos deliver` after a fresh
`collect`, then compare `runs.llm_outcome_counts` against this entry's
125/37/31/57 split. If the failure rate holds, it is a systemic issue with
the model/client pairing, not one-run noise, and should get its own ADR.

> **Follow-up, 2026-08-18.** The planned check recurred on production run
> `01M09Q92RQQF91PDS6YVD1FB4J`: 3 postings passed the pre-filter, only 1
> scored, and 23 OpenRouter attempts split into 9 transport-level successes,
> 4 timeouts and 10 `invalidOutput` responses. The two failed postings both
> stopped in Stage A after four attempts and had already failed the same way
> on the preceding run, with the same `a-v4`/`b-v4` prompts and configured
> model. This confirms a recurring model/client/provider problem, but does
> not support a prompt-regression diagnosis. Full evidence, limitations and
> prioritized remediation are recorded in
> [`docs/audit/SCORING-INCIDENT-2026-08-18.md`](audit/SCORING-INCIDENT-2026-08-18.md).

> **Remediation, 2026-08-18 (ADR-052).** The client now recognizes OpenRouter's
> documented top-level and choice-level HTTP 200 error envelopes, classifies
> canonical `error_type` values, opts into router metadata and persists only
> content-free stage/provider diagnostics. Run rows retain stage/outcome,
> provider, error-type and score-failure counts. The old alert was split:
> every missing score reports digest impact, while an accounted
> operation-rate signal needs at least 10 attempts and no longer claims a
> prompt/model regression.
>
> **Amendment 1 validated, did not close it.** A manual `deliver`
> (`01M0AJ0CY37MD7XAWX5XZEQNR0`) confirmed the 120s Stage A timeout worked
> (0 timeouts, down from 4) but digest impact was unchanged (1/3 scored) —
> the failure mode shifted to `finishReason: "length"` with empty content,
> uniform across 8 providers.
>
> **Actual root cause, found the same session.** Two single, no-retry calls
> against the same two postings that had failed every run — as collected
> and with all emoji stripped — reproduced the same `length` truncation
> every time, each carrying a `reasoning` field 70,000+ characters long.
> `deepseek/deepseek-v4-flash-0731` is a reasoning model; its
> chain-of-thought was consuming the entire completion budget before
> writing the JSON answer. Raising the ceiling to 8,192 tokens (Amendment 1)
> only gave it more room to do the same thing for longer, at the cost of
> more timeouts and a circuit-breaker trip.
>
> **Fix, Amendment 2.** `reasoning.max_tokens` (OpenRouter's documented
> control) caps Stage A at 3,000 and Stage B at 300, leaving the majority
> of each budget for the answer. Confirmed twice: an isolated call for both
> previously-failing postings returned `finish_reason: "stop"` with valid
> JSON (18 and 6 requirements), then a full production `deliver`
> (`01M0AZQ7Q83008FXK00AQKK36X`) scored **4 of 4** filtered postings —
> `scoreFailureCounts: {}` — including both postings that had failed every
> run of this incident. **Resolved.**

---

## C1 — Production run rows are permanently open

**Status:** fixed (the two known rows and, as of ADR-054, the underlying
graceful-cancellation gap) · **Found:** 2026-08-16, grown by one more the
same day

Run `01M04JFMRPWY4660K4SBV97QBW` (`scoreAndDeliver`, started
2026-08-16T06:00:00Z) has `finishedAt: null` and `outcome: null`, because the
throw that killed it predates the fix in #49.

A second row joined it the same day: `01M055DMPHHE2RV05YK97Q5TA5`
(`scoreAndDeliver`, started ~11:30 UTC), the 6-hour backlog-draining run,
deliberately killed by a container restart once the maxAgeDays/cutover work
(#52/#53) made most of what it would have scored not worth scoring. #49's
fix only closes a row on a _throw inside the same process_; a hard restart
(the only way to cancel an in-flight run — no graceful drain exists) doesn't
give that code a chance to run at all. Killing a run this way always leaves
an open row behind, by construction, not as a bug.

While either exists, `GET /health` reports `lastSuccessfulRun.scoreAndDeliver`
as whatever the last row that actually finished was, and the open rows are
indistinguishable from a run genuinely still in progress.

**Resolving it** is a one-off `UPDATE` marking both `failed`. Left undone on
purpose: it is a manual write to the production database, and it should be a
deliberate act rather than a side effect of a deploy. Note that ADR-024 (A2)
does not touch this: it stops two runs from executing at once, which is a
different failure than a single run's process being killed mid-flight — a
restart will orphan a row exactly like this again, any time one is used to
cancel an in-flight run. Graceful cancellation (a way to actually stop a run
without killing the process) would be the real fix; not attempted here.

> **Resolution, verified 2026-08-17.** Queried Atlas's real production
> database directly (`docker exec argos-career node -e '...better-sqlite3...'`,
> read-only, not the app's own API) rather than trusting this entry's
> age: both rows already carry `finishedAt`/`outcome: "failed"`, both with
> the identical timestamp `2026-08-16T13:17:48Z` — the fingerprint of a
> single bulk `UPDATE`, exactly the deliberate one-off act this entry
> called for. It had already happened by the time this was re-checked;
> this entry was simply never updated to say so. `SELECT ... WHERE
finished_at IS NULL` against the live database returns zero rows as of
> this check.
>
> **The underlying gap is genuinely still open, not just this entry's
> staleness:** a hard restart mid-run still orphans a row exactly this way,
> with no graceful cancellation to prevent it. The next occurrence needs
> the same deliberate manual fix — this entry stays, minus the two now-closed
> rows, as the runbook for doing it again.

> **Graceful cancellation built, 2026-08-22 (ADR-054).** `RunLock` gained
> `requestCancel`/`isCancelRequested`; `executeDeliver`'s scoring loop polls
> it once per posting, the same checkpoint granularity the existing
> permanent-transport-failure short-circuit already uses. A cancelled run
> still composes and delivers whatever it scored before the request landed,
> still releases unresolved claims, and still finishes its row normally —
> with a new `RunOutcome`, `"cancelled"`, distinct from `"failed"` — so it
> can never reproduce this entry's original `finishedAt: null` shape.
> Reachable via `POST /runs/:kind/cancel` and the `cancel_run` MCP tool
> (`kind` must be `scoreAndDeliver` — `collect`/`dedup` have no checkpoint
> that reads the flag, per A1/A3's own measurement that neither runs long
> enough to need one). 4 new tests at the `executeDeliver`/`RunLock` level,
> 5 more at the REST/MCP integration level; full suite and typecheck stay
> green.
>
> **Deliberately still not covered, stated plainly rather than implied:** a
> hard process kill — `docker restart`, an OOM kill, a crashed host — still
> orphans a row exactly as this entry originally described. This gives an
> operator (or Hermes, over the same MCP boundary) an alternative to
> killing the process, not a change to what killing the process does. If a
> run needs to stop, cancel it before restarting the container, not after —
> the same operational discipline B1's deployment note already asks for
> ("deploy only between cycles, never during one"), now with a real way to
> end a cycle early instead of only waiting for it or killing it.

---

## B7 — `run-calibration.ts` never got the ADR-052 fixes, so it silently reproduced B6

**Status:** fixed · **Found:** 2026-08-19, running the M7 calibration protocol
against a freshly-expanded worksheet

`scripts/run-calibration.ts` built its own `OpenRouterClient`/`StageAExtractor`/
`StageBMatcher`/`ApiScorer` by hand instead of calling `buildScorer()` — the
function `src/scoring/infrastructure/build-scorer.ts` exists specifically so
the scheduler and the CLI construct a scorer identically (its own docstring
already flagged this exact script as the one place that didn't use it,
docs/audit AC-015). The practical effect: calibration ran with the library's
30 s default timeout and no `reasoning.max_tokens` cap, never the Stage A
120 s timeout or the 3,000/300-token reasoning ceilings ADR-052 added to fix
B6.

First calibration run against 18 labelled postings: **78% parse-failure
rate, correlation 0.054** (indistinguishable from noise) — B6's incident,
reproduced by tooling drift months after it was closed in production.

> **Resolution, 2026-08-19.** `run-calibration.ts` now calls `buildScorer()`
> instead of constructing its own client, so calibration exercises the exact
> configuration a real nightly run does. Re-run against the same 18
> postings: **17% parse-failure rate, correlation 0.412**. Remaining
> failures are Stage B `matching_failed` (`invalidOutput` after 4 retries on
> individual requirements) — smaller-scale noise of the same shape B6 named,
> not a new cause. `getUsage()` is now read from `buildScorer`'s return value
> too, closing the same drift for cost reporting.

---

## B8 — The `dev` track keyword `desenvolvimento` false-positives on non-software postings

**Status:** fixed (the two observed cases), the underlying pattern stays
worth watching · **Found:** 2026-08-19, selecting postings for the M7
calibration worksheet

`classifyTrack` (`src/prefilter/domain/classify-track.ts`) matches
`desenvolvimento` as a whole word in the **title only** (ADR-011 Amendment 2).
Two real postings from the production corpus were classified `dev` and would
reach the LLM despite having nothing to do with software:

- **Duty Cosméticos — "Estagiário de Pesquisa & Desenvolvimento"**: cosmetics
  R&D, requires Química/Farmácia/Engenharia Química. "Desenvolvimento" here
  means product development, not software.
- **Jobbol — "ESTAGIÁRIO NA ÁREA DE PSICOLOGIA... (Humano Desenvolvimento)"**
  ×5 postings: Psychology internships. "Desenvolvimento" is part of the
  staffing agency's own name, "Humano Desenvolvimento", parenthesized in the
  title — not a job-content word at all.

Same failure shape ADR-011/015 already fixed once for `soc`/`api` substring
collisions and for "ESTAGIÁRIO DE DESENVOLVIMENTO DE EMBALAGENS" (packaging)
— `desenvolvimento` alone is common enough in Portuguese HR boilerplate that
whole-word matching does not save it the way it saves `api`/`soc`.

**Cost is real, not hypothetical:** every false positive here passes the
pre-filter's track check and reaches Stage A/B, spending a real LLM call on
a posting no configuration of the profile could ever score `apply`. It also
pollutes M10's market-analysis corpus, which reads `tracks` on every active
posting regardless of pre-filter outcome.

> **Resolution, 2026-08-19.** Narrower than it first looked: **both
> canonical exclusion phrases already existed** in `criteria.yaml`
> (`pesquisa e desenvolvimento`, `desenvolvimento humano`) — the actual
> titles just did not literally match them. Duty Cosméticos writes
> "Pesquisa **&** Desenvolvimento"; `&` normalizes to a bare space
> (`title-match.ts`), not the word "e", so it never matched "pesquisa e
> desenvolvimento". Jobbol's title carries "(**Humano Desenvolvimento**)",
> the staffing agency's own name, word order reversed from "desenvolvimento
> humano". `title-match.ts`'s exclusion matching is literal word order —
> the canonical phrasing does not cover its own variants. Added `pesquisa
desenvolvimento` and `humano desenvolvimento` to `trackExclusions.dev`.
> Verified against the real config loader:
> `classifyTrack("Estagiário de Pesquisa & Desenvolvimento", ...)` and the
> Jobbol title both now return `[]`, and
> `classifyTrack("Estágio em Desenvolvimento Backend", ...)` still returns
> `["dev"]` — the fix is additive, not a behavior change for genuine dev
> postings. Two regression tests added
> (`test/prefilter/domain/classify-track.test.ts`).
>
> **The underlying pattern — a fixed exclusion phrase can always miss a
> real title's wording — stays open as a class of risk**, not a specific
> bug: any future posting phrasing "desenvolvimento" in an order or with
> punctuation none of today's exclusions anticipate will pass through
> exactly the same way these two did, until it is observed and added.
> Nothing here makes exclusion matching order-independent or
> punctuation-tolerant; it only patches the two instances found so far.

---

## B9 — Genuinely good postings were being discarded; `apply` recall measured at 13-17%

**Status:** partially fixed (period-gate cause, CS-fundamentals evidence,
Smarthis's Stage A extraction shape), two real gaps stay open (ELDORADO's
missing evidence, Smarthis's residual Stage B matching) · **Found:**
2026-08-19, the first real M7 calibration run after B7's fix

With B7 fixed, the 18-posting calibration run gave a real, trustworthy
number for the first time: **correlation 0.412-0.455, but `apply` recall of
only 13-17%** — of every posting hand-scored ≥70 ("I would apply"), the
computed score agreed on just 1 in 6-8. Per the M7 protocol's own stated
priority (`docs/04-scoring-model.md`), this is the worse direction of error:
a missed good posting costs more than a reviewed bad one.

Traced per-posting (`run-calibration.ts`'s new verbose output, this
session), the six misses split into two causes:

- **Two (Flamengo hand 70→35, MIDI hand 65→35) were a not-yet-reached
  academic period, hard-capping an otherwise-strong match to
  `blockingCapScore` and landing it in `discard`.** This is exactly the
  gap `docs/audit AC-026` already named and `digest.ts`'s own
  `PeriodBlockedEntry` comment described as never built.
- **Four (Bemobi Wave hand 100→65, ELDORADO hand 90→65, Anbima DevOps
  hand 100→63, Smarthis hand 100→40) were low `mandatoryCoverage`** — Stage
  B matching the profile against the posting's stated requirements more
  conservatively than the hand label expected. Model/prompt/evidence
  quality, not a structural bug; not touched here.

> **Resolution, the period-gate half, 2026-08-19 (ADR-053).**
> `src/scoring/domain/period-gate.ts` now detects exactly this shape — a
> not-yet-reached academic period as the _sole_ blocking failure — and
> `executeDeliver` routes it into the digest's already-existing (but
> never populated) `periodBlocked` section instead of capping the score.
> Full reasoning, the parser's heuristic limits, and why the other four
> cases are explicitly out of scope for this fix: ADR-053.

**The other four stay open.** Fixing them by guessing a prompt or weight
change would break the M7 protocol's "change one variable at a time" rule,
and 18 labelled postings (down from a nominal 20 — two more `matching_failed`
this run) is still a thin sample to trust a specific correction against.
Revisit once the worksheet is closer to the full 50 `docs/04` calls for.

> **Verified against the real corpus, 2026-08-19.** Re-scored Flamengo and
> MIDI directly (cached Stage A/B, no new model calls): Flamengo now
> carries `periodGate: { minimumPeriod: 4, opensAtLabel: "2027.2" }` as
> intended. **MIDI does not** — its extraction has _two_ `blocking`
> requirements, "Semestre exigido: 4 a 9" and "Nível escolar: SU" (higher
> education), and Stage B matched the second `not_met` too, despite the
> profile almost certainly evidencing current higher-ed enrollment.
> `detectPeriodGate`'s "only when it is the sole blocker" rule correctly
> refuses to reclassify MIDI — but the reason it refuses is a second, real
> Stage B miss, the same category as the four open `mandatoryCoverage`
> cases above, not a period-gate defect. Worth a dedicated look: "Nível
> escolar: SU" reads like exactly the kind of requirement that should be
> close to universally `met` for this profile and evidently is not.

> **Root cause found and fixed, 2026-08-19.** "Nível escolar: SU" was never
> a real requirement to begin with. `ciee-collector.ts`'s own `keep()`
> already filters collection to `DEFAULT_EDUCATION_LEVELS = ["SU"]`, with
> no override in `criteria.yaml` — every CIEE posting that reaches the
> corpus at all already has `nivelEscolar: "SU"`, by construction. But
> `ciee-normalizer.ts` folded the raw two-letter code into `description`
> verbatim regardless, as pure noise: always true, so not discriminating
> information, and an opaque code ("SU" for "superior") no profile
> evidence could ever literally quote even for a candidate who obviously
> qualifies. Stage A extracted it as an ordinary `blocking` requirement
> anyway, Stage B correctly found no evidence for a code that appears
> nowhere in any real résumé, and it capped MIDI's otherwise-100%-matching
> score at 35 — a second, independent false rejection on the same posting
> the period gate above already explains half of.
>
> `composeDescription` no longer includes `nivelEscolar`. **Forward-looking
> only** — this fixes newly-collected CIEE postings; MIDI's own row,
> already normalized with the field baked into its stored `description`,
> keeps it until re-collected with a changed payload invalidates its
> cache (this project does not rewrite already-stored `description` values
> as a side effect of a code change, matching this page's C1 precedent for
> not touching production data outside a deliberate act). One regression
> test added (`test/posting/infrastructure/ciee-normalizer.test.ts`) pins
> the fixture's own `nivelEscolar: "SU"` and asserts it never reaches the
> composed description.

> **Investigated the remaining three low-`mandatoryCoverage` cases,
> 2026-08-19 — none are code bugs.** Pulled each real match array directly:
>
> - **Bemobi Wave (hand 100, mandatoryCoverage 0%).** The three unmet
>   verifiable mandatory requirements are "lógica de programação bem
>   fundamentada", "domínio das principais estruturas de dados (pilha,
>   fila, árvores)" and "algoritmos de busca e ordenação" — classical CS
>   fundamentals. `config/profile.yaml` has zero competency entries for
>   any of them; every entry is framed around a named tool (Node.js,
>   PostgreSQL, React, ...), never generic data-structures/algorithms
>   knowledge. Stage B is being accurate, not conservative: it cannot
>   quote evidence the profile does not contain. **Not a scoring bug — a
>   profile gap.** Fixable only by adding a real, evidenced competency
>   (a course, a project that used them) — this project does not invent
>   evidence (CLAUDE.md §15), so that edit has to come from a human.
> - **ELDORADO (hand 90, mandatoryCoverage 43%).** Confirmed to be exactly
>   ADR-026's own worked example, still true: Angular and Java/Spring Boot
>   are genuinely absent from the profile. The three soft-trait
>   requirements in the same extraction ("apaixonadas por tecnologia",
>   "motive por desafios", "espírito colaborativo") are correctly
>   `verifiable: false` and already excluded from coverage — ADR-015 is
>   working as designed here, not the cause.
>   **Reviewed with the profile owner, 2026-08-22: confirmed valid, no
>   error.** No real Angular or Java/Spring Boot evidence exists to add —
>   this stays a genuine profile gap, not a scoring defect, and is not
>   pursued further unless real evidence (a course, a project) arises
>   later. The system correctly scores this posting low for this profile
>   as it stands today.
> - **Smarthis (hand 100, mandatoryCoverage 40%) — two separate findings.**
>   "Disponibilidade para atuar em modelo híbrido ou remoto" is `not_met`
>   with no evidence, and `config/profile.yaml` indeed states no
>   remote/hybrid-availability fact anywhere (only `minimumStipend` and
>   `maxWeeklyHours` are declared) — the same profile-gap shape as Bemobi
>   Wave, and likely the single highest-leverage one to close: this exact
>   requirement phrasing recurs across many postings, not just this one.
>   **Separately, a real extraction-quality issue**: the posting text
>   reads "**Para vagas com foco em Desenvolvimento:** conhecimento em
>   uma linguagem de programação... **Para vagas com foco em Processos e
>   Projetos:** conhecimento em gestão de processos..." — two
>   track-conditional requirement branches for a multi-track internship
>   program. Stage A extracted _both_ as unconditional flat `mandatory`
>   requirements instead of recognizing the "Para vagas com foco em X:"
>   qualifier, so a dev-track candidate (who correctly matched the
>   Desenvolvimento branch) is also penalized for not meeting the
>   Processos e Projetos branch, which was never actually asked of them.
>   **Not fixed here** — this is a Stage A prompt question (recognizing
>   and either resolving or excluding track-conditional clauses), and the
>   M7 protocol's "change one variable at a time" rule means a prompt
>   version bump needs its own dedicated calibration run to evaluate, not
>   a same-session bundle with three unrelated fixes. Worth an ADR when
>   picked up — flag if this conditional-clause shape recurs on other
>   postings before spending the prompt-version cost on a single
>   observation.

> **Picked up and fixed, 2026-08-22 (ADR-055).** `prompts/stage-a-extraction.v5.md`
> teaches Stage A to recognize the "Para vagas com foco em X: ... Para
> vagas com foco em Y: ..." shape and merge the parallel branches into one
> alternative ("OR") requirement, instead of emitting each as an
> independent unconditional `mandatory`. Verified directly against
> Smarthis's real re-extracted data, not just the aggregate calibration
> number: the two separate branch requirements from every prior prompt
> version (`a-v2` through `a-v4`) collapse into a single merged requirement
> under `a-v5`. Calibration re-run against the full 18-posting worksheet,
> only the Stage A prompt changed (Stage B stayed `b-v4`): correlation
> 0.357 → 0.468, parse-failure rate 28% → 0% (very likely provider noise,
> not attributable to this change — see ADR-055's own caveat), no verdict
> precision regression. Full comparison table and the direct
> before/after extraction diff: ADR-055.
>
> **Does not fully rescue Smarthis's score, and was never expected to.**
> The posting's real Stage B match for the new merged requirement still
> answers `not_met` despite the profile evidencing Node.js — a programming
> language, which should satisfy the "Desenvolvimento" side of the OR.
> This is the same Stage B matching-quality ceiling the `workAvailability`
> note above already named, a second variable ADR-055 deliberately left
> untouched. **This closes the extraction-shape defect B9 identified,
> not Smarthis's score** — the residual gap is now entirely a Stage B
> question, tracked here, not reopened as a new entry.

> **Stage B fix attempted and reverted, 2026-08-22 — real measured
> regression, not shipped.** Wrote `prompts/stage-b-matching.v5.md`, adding
> an instruction for requirements stating alternatives (the exact shape
> `a-v5` now produces), and re-ran calibration with only
> `STAGE_B_PROMPT_VERSION` changed, `a-v5` held fixed. Result: **parse-
> failure rate 0% → 72%** (5/18 scored, down from 18/18) — a real
> regression, not noise, since failures did not recover across retries the
> way ordinary transient provider errors do. Reverted to `b-v4` the same
> session, before it ever reached Atlas. Working hypothesis (not yet
> confirmed by an isolated reproduction the way B6's root cause was):
> Stage B's 300-token `reasoning.max_tokens` cap (ADR-052) was sized
> against `b-v4`'s shorter instructions, and the new alternatives
> paragraph gives the model more to reason through before writing JSON,
> consistently exceeding that fixed ceiling rather than occasionally
> tripping on it. Full record, including candidates for a leaner retry not
> pursued this session, kept in the prompt file itself (a-v4/a-v5's own
> convention — every version stays on disk, including ones that did not
> ship). **Smarthis's residual Stage B gap stays open**, now with one
> documented dead end.

> **The hypothesis above was wrong, and the real cause was found,
> 2026-08-22.** Reproducing in isolation — the step that note said was owed
> — disproved it immediately: **production's own `b-v4` prompt failed
> identically**, 0 of 8 usable, once routing landed on the `Sail Research`
> provider. The two calibration runs had routed to different providers, so
> the prompt was never the variable that changed. That is a separate and
> larger problem, recorded as **B11** and fixed by ADR-056.
>
> With that provider excluded, the true cause of the Smarthis `not_met`
> surfaced, and it is neither prompt nor provider: the PR-005/ADR-049
> applicability guard. Checked deterministically, no model involved —
> `isKnownProfileEvidence` passes for the Node.js and TypeScript quotes
> (they are real profile lines) while `isEvidenceApplicableToRequirement`
> returns **false**, because it requires the competency name or an alias to
> appear literally in the requirement, and the requirement reads
> "...como .NET, Python, PHP, Java, C#, VBA, VBScript, **entre outras**"
> without ever naming Node or TypeScript. `StageBMatcher` then coerces the
> model's correct `met` to `not_met` with `evidence: null` — exactly the
> stored row. At the call level the model answered `met` on **13 of 13**
> usable calls; every one was discarded by the guard.
>
> **Fixed by ADR-057**, a per-track generic-skill-category vocabulary beside
> the existing `FIXED_TAG_TERMS` table. After it the same deterministic
> check returns `applicable=true`, and replicating the full pipeline
> decision call-by-call resolves `met` 5 times in 6 — the sixth correctly
> rejected, the model having quoted the academic-enrollment line, which the
> guard is right to refuse.
>
> **Confirmed end to end, same session, once B12 was understood.** The
> reason a cold run seemed impossible was a second cache (`partial_matches`,
> read before `matches`) replaying stored answers — see B12. Clearing both
> via the new `npm run score:one -- <fp> --cold`: **13 real model calls, 10
> providers, 24.5 s, $0.0026**, and the requirement moved `not_met` →
> `met`, taking Smarthis from **43.83 `discard` to 50.00 `review`**
> (mandatoryCoverage 50% → 75%).
>
> **B9 stays open, on a much narrower basis than before.** 50.00 is still
> short of the hand label's 100. Both remaining causes were then run down —
> see the two notes below.

> **The work-availability half was a hard bug, not "model quality"
> — 2026-08-22 (ADR-058).** The `workAvailability` note above concluded the
> model simply was not using available evidence, "not a defect in this
> change". Wrong. `evidence-catalog.ts` renders that field under a
> `[Work availability]` tag, and `FIXED_TAG_TERMS` — the table
> `isEvidenceApplicableToRequirement` resolves declared-field tags against —
> **never got a matching entry**. The lookup fell through to a competency
> search, found no competency by that name, and returned `false`. Measured
> deterministically, no model involved: the line is `real=true
applicable=false`, and was so for _every_ requirement that could ever
> exist. The model's correct `met` was being coerced to `not_met` every
> time; the field was structurally dead from the day it was added.
>
> Fixed by giving the tag its own work-mode vocabulary (not `Availability`'s
> hours vocabulary — the two must not answer for each other). Verified with
> a cold end-to-end run: the requirement moved `not_met` → `met` and
> **`mandatoryCoverage` 75% → 100%**.

> **The `trackAlignment` half is now precisely located, and is what still
> caps this posting.** With coverage at 100%, Smarthis would score **79.4**
> — but `unknownTrackCapScore` caps it to **50.00**, because
> `classifyTrack` reads the **title only** and "Programa de Estágio
> Smarthis | 2026" names no technology.
>
> The obvious fix — also classify on the description — was measured against
> the real corpus and **rejected**: it would newly classify 438 postings,
> almost all off-track ("Operador(a) de Caixa" as `dev`, "Assistente de
> vendas" as `security`), because descriptions are full of HR boilerplate.
> With `rejectUnknownTrack` on, each is a wasted Stage A/B call.
>
> **The signal that does work, measured on this posting:** classify on
> Stage A's _extracted requirements_, which are boilerplate-free by
> construction. `classifyTrack` over Smarthis's extracted requirement text
> returns `["dev", "automation"]` where the title returns `[]` — giving
> `trackAlignment` 1.0, no cap, and **88.4 → `apply`**, against a hand label
> of 100.
>
> **Implemented, 2026-08-22 (ADR-059).** `resolveScoringTracks` falls back
> to the extracted requirements only when the title classifies nothing, so a
> posting that already classified is left completely alone — the pre-filter's
> title-based spend gate is untouched. Calibrated as its own variable
> (`trackAlignment` is not in any cache key, so a cached run measures it
> exactly, at zero cost): **correlation 0.468 → 0.621, `apply` recall
> 25% → 38%**, with `apply` precision holding at 100%. `discard` recall fell
> 86% → 71% as the mirror image, while `discard` precision rose — the trade
> `docs/04` explicitly asks for.
>
> Verified end to end on the worked example with a cold run (14 real calls,
> $0.00117): **50.00 `review` → 88.33 `apply`**, against a hand label of 100.

> **Status of B9 as of 2026-08-22.** Of the six original misses, five now
> have a named cause and a measured fix — period gate (ADR-053),
> CS-fundamentals evidence (profile data), extraction shape (ADR-055),
> category-named evidence (ADR-057), work availability (ADR-058) — plus the
> track signal above (ADR-059). The one genuinely still open is
> **ELDORADO**, and it is not a defect: Angular and Java/Spring Boot are
> honestly absent from the profile, confirmed with the profile owner.
>
> This entry's headline number (`apply` recall 13-17%) has since moved to
> **38%** on a worksheet re-measured twice. **B9 stays open only as the
> tracking entry for `apply` recall itself**, which is still short of where
> the M7 protocol wants it and needs the worksheet closer to 50 postings
> before the next correction is worth trusting against noise.

> **`workAvailability` profile field added, 2026-08-19.** Closes the
> Smarthis work-mode gap above: `profile.ts` gained a fourth declared
> field alongside `englishLevel`/`minimumStipend`/`maxWeeklyHours`,
> rendered by `evidence-catalog.ts` as a `[Work availability]` quotable
> line the same way the other three are. `config/profile.yaml` now states
> "Disponível para trabalho presencial ou híbrido no Rio de Janeiro,
> Niterói ou São Gonçalo, e para trabalho remoto em qualquer lugar do
> mundo." Verified the plumbing directly against the real corpus
> (`loadProfile` + `buildEvidenceCatalog`): the new line is generated and
> present in what Stage B is allowed to quote. **Re-scoring the real
> Smarthis posting with a live call, the model still answered `not_met`
> for "modelo híbrido ou remoto" despite the evidence being available** —
> the field is correctly wired, but one real call not using available
> evidence is exactly the calibration-measured ~0.4 correlation ceiling
> already known about this model/prompt pairing, not a defect in this
> change. The evidence now exists for every future scoring attempt
> regardless; whether the model reliably uses it is a separate,
> already-tracked question.

> **CS-fundamentals gap closed, 2026-08-19 — the profile owner supplied
> real evidence.** Three competencies added to `config/profile.yaml`
> (gitignored, not in this repo): "Lógica de programação", "Estruturas de
> dados" and "Algoritmos de busca e ordenação", each evidenced by the
> completed "Programação de Computadores" course at Universidade La Salle
>
> - RJ — confirmed by the profile owner to have actually covered pilha,
>   fila, árvores and busca/ordenação, not assumed from the course title
>   alone. Verified with a live re-score of the real Bemobi Wave posting:
>   **score 0 → 88.3, verdict `review` → `apply`**, `mandatoryCoverage`
>   0% → 67%, matching the hand label of 100 for the first time. No code
>   changed — this was purely a profile-data gap, and closing it took a
>   real fact, not a workaround.

---

## B10 — `dev` track keywords missed degree-name and database-only phrasing

**Status:** fixed · **Found:** 2026-08-22, an audit comparing the pre-filter's
real decisions against a manual read of the same corpus

Queried the production `posting_events` table on Atlas directly (read-only,
`docker exec argos-career node ...better-sqlite3...`, same method as B6/C1's
verifications). Of 2,976 postings with a recorded pre-filter decision,
**2,756 (92.6%) were rejected `track_unknown`** — overwhelmingly correct
(CIEE alone supplies 91% of the corpus, and it is a general internship board,
not a tech one), but the sheer volume made it the one rejection reason worth
reading by hand rather than trusting by proportion. `title_missing_required_term`,
`location_not_allowed` and `title_blocked` were sampled too (98 / 33 / 7
postings) and all held up as correct on inspection — a McDonald's "Atendente
de Restaurante" and an out-of-region São Paulo posting are not this project's
misses.

Grepping the 2,756 `track_unknown` titles for tech-adjacent words (`dados`,
`sql`, `sistemas`, `banco de dados`, `ciência da computação`, ...) surfaced
two **genuinely on-track, real, currently-open postings** the pre-filter
was discarding before any LLM call:

- **Confitec — "Estagiário em Banco de Dados SQL Server - Exclusiva Rio de
  Janeiro."** A real backend/database internship; `config/profile.yaml`
  already evidences PostgreSQL and "SQL and NoSQL databases." None of
  `dev`'s keywords (backend, node, typescript, javascript, api,
  desenvolvimento, software, programação, informática) match "banco de
  dados" or "SQL Server" — the whole posting is exactly the shape of tech
  vocabulary the list had never needed to cover, because most Gupy/CIEE dev
  postings say "desenvolvimento" or "backend" somewhere in the title.
- **CEPEL (Programa de Estágio) — "Estágio | Redes de Computadores, Sistemas
  de Informação, Ciência da Computação e afins."** CEPEL's own catch-all
  phrasing for "any CS-adjacent degree" — the formal course names a Brazilian
  transcript uses, not the framework/language vocabulary the keyword list was
  built around.

Measured before touching the config, the same discipline every entry in
`criteria.yaml`'s own comments already follows: each of the five candidate
phrases (`banco de dados`, `sql server`, `sistemas de informação`, `ciência
da computação`, `redes de computadores`) returns **exactly 1 match** against
the full 3,067-posting corpus, both real matches on-track, zero false
positives. Deliberately **not** added: a bare `dados` keyword, probed
separately at 7 matches with only 2 genuinely on-track (the same two above,
already covered by the whole-phrase entries) and the other 5 accounting/HR/
academic-support noise — exactly the false-positive shape ADR-011's
whole-phrase discipline exists to avoid, so postings like "Estágio em
Contabilidade: Dados e Inteligência Artificial" and "Pessoa Estagiária de
Dados" correctly stay `unknown` rather than being swept in by a generic word.
A data-engineering/data-analytics track is not part of this project's
declared search profile (CLAUDE.md §1: dev, security, automation only) — that
stays a deliberate scope boundary, not something this fix tried to widen.

> **Resolution, 2026-08-22.** Both phrase groups added to `tracks.dev` in
> `config/criteria.yaml`. Verified directly against `classifyTrack` with the
> real production titles: the CEPEL posting now classifies `["dev"]`, the
> Confitec posting now classifies `["dev"]`, and both previously-excluded
> "dados" postings still classify `[]` — the fix is additive, not a
> behavior change for anything that was already being classified correctly.
> Two regression tests added
> (`test/prefilter/domain/classify-track.test.ts`, "degree-name and
> database phrasing (B10)"). Full suite (1,127 tests) and typecheck stay
> green. **Not yet observed against a live `deliver` run** — both postings
> will reach Stage A/B on the next scheduled cycle; whether they actually
> score `apply` depends on real Stage A/B matching quality, a separate,
> already-tracked question (B9's four open `mandatoryCoverage` cases).
>
> **The broader pattern stays open, same shape as B8's closing note:** a
> fixed keyword list can only ever cover phrasing already observed. Any
> future posting that describes a dev/security/automation role in wording
> none of today's keywords anticipate will be missed exactly the way these
> two were, until it is found and added. This entry closes the two
> instances found in this audit, not the class of risk.

> **Deployed and verified live, 2026-08-22.** Rebuilt and restarted the
> Atlas container (`docker compose build && up -d`) with the merged fix.
> `classifyTrack`, executed inside the running production container against
> the real CEPEL and Confitec titles, returned `["dev"]` for both — the fix
> is not just merged, it is the code actually running. A manual `argos
deliver` (run `01M0KZY93MBME3TQBW138QV9F3`) confirms the structural
> effect on the real corpus: **neither posting stops at `track_unknown`
> anymore.** Confitec passed the pre-filter and reached Stage A/B, scoring
> `discard` (a real, separate `mandatoryCoverage` outcome — the LLM found
> thin evidence overlap, not a classification failure; the same open
> question as B9's four cases). CEPEL was rejected `too_old` this run — a
> different, also-correct deterministic rule, unrelated to track
> classification. Two independent confirmations that this entry fixed
> exactly the layer it targeted (pre-filter track classification) and
> nothing past it — what a posting does _after_ correctly reaching the LLM
> is governed by other, already-tracked concerns.
>
> Deploying surfaced two unrelated production issues, fixed the same
> session because they blocked bringing the container back up, not because
> either is in scope for B10: Atlas's Tailscale identity had re-keyed since
> the container's last start, leaving `.env`'s `ATLAS_TAILSCALE_IP` stale
> and the port bind failing (`.env` corrected to the current address); and
> `config/profile.yaml` on Atlas — a real, gitignored, hand-maintained file,
> distinct from the repo's `profile.example.yaml` — had never received the
> `workAvailability` field added by an earlier commit (`c174e40`), so
> `loadProfile` threw on startup until the value already recorded in this
> page's Smarthis note (above) was added to the real file.
>
> **Negative sweep, 2026-08-22 — no further keyword gap found.** Asked
> explicitly to look for more collector/classifier misses beyond the two
> above. Re-pulled the full 3,067-posting active corpus from Atlas and ran
> the real `classifyTrack` (with the fix already applied) locally against
> a much wider candidate lexicon than the original audit: language/platform
> terms (python, java, cloud, aws, azure, mobile, android, ios, linux),
> degree/field names (engenharia da computação, ciência de dados, análise e
> desenvolvimento de sistemas, estatística, matemática aplicada,
> telecomunicações), IT-operations phrasing (T.I. with periods, analista de
> suporte, administrador de redes, sistemas embarcados, automação
> industrial), and design/security-adjacent terms (UX, red team, blue team,
> forense, LGPD). **2,948 of 3,067 postings still classify `unknown`,
> essentially unchanged from before the fix (2,976 before, on the smaller
> pre-fix candidate set) — the two titles this entry already fixed are
> gone from the unknown set and nothing new qualified to replace them.**
> Every apparent hit resolved to noise on inspection:
>
> - "UX User Experience" (1 match, Trabalho Remoto) — design/frontend, not
>   part of this project's declared search profile (CLAUDE.md §1: dev,
>   security, automation only, no design/UX track).
> - "Auxiliar de..." (mecânico, açougue, estoque, manutenção — several
>   matches) — a false positive in the _probe script_, not the corpus:
>   "auxiliar" contains "ux" as a substring, which this sweep's own probe
>   matched loosely; `classifyTrack`'s real whole-word matching was never
>   exposed to this bug and does not have it.
> - "TECNICO DE ENFERMAGEM - U.T.I." — hospital ICU (Unidade de Terapia
>   Intensiva), not information technology; a punctuation collision on the
>   same abbreviation, same shape as ADR-011's original `IV`-inside-`nível`
>   false positive.
> - "Estágio em Telecomunicações" (1 match) — posted by "SERVENTIA
>   EXTRAJUDICIAL DE BURITICUPU," a notary's office in Buriticupu/MA. CIEE's
>   field-of-study tag names the student's degree, not the job content, and
>   this one is also outside the target region regardless — would fail
>   `location_not_allowed` even if track-classified.
> - "Estágio em Estatística" (1 match) — Statistics, not part of the
>   declared search profile.
>
> No `criteria.yaml` change made from this sweep — nothing found cleared
> the bar the two resolved cases did (a real, on-track, unambiguous,
> currently-open posting an actual keyword gap was hiding). Recorded so a
> future session does not re-run the same broad sweep expecting to find
> more: as of this date, the `track_unknown` population left in the corpus
> has been read for tech vocabulary twice, by two different keyword sets,
> and both times resolved to either correctly-off-track postings or
> probe-script noise, not classifier gaps.

---

## B11 — OpenRouter routes the pinned model to 30 different providers, one of which returns garbage

**Status:** fixed for the observed provider (ADR-056); the class of risk
stays open · **Found:** 2026-08-22, reproducing B9's `b-v5` "regression"

ADR-013 pinned the model. It did not pin what serves it. OpenRouter's own
`/models/{id}/endpoints` API lists **30 provider endpoints** for
`deepseek/deepseek-v4-flash-0731`, and it picks one per request — so "same
model, same prompt" can be two materially different systems from one run to
the next, invisibly.

This was found while investigating what looked like a Stage B prompt
regression (B9's `b-v5`: parse-failure 0% → 72%). Isolated single calls
showed the prompt was innocent — **production's own `b-v4` failed
identically**, 0 of 8 usable, once routing landed on `Sail Research`, which:

- returns `finish_reason: "stop"` with **completely empty content**, or
- blows the 768-token completion budget with 2,400–3,700 characters of
  chain-of-thought against an explicit `reasoning.max_tokens: 300`.

The two calibration runs whose difference triggered the whole investigation
had simply routed to different providers (`Relace` vs `Sail Research`). An
uncontrolled variable silently invalidated a comparison the M7 protocol
treats as controlled — the failure mode `docs/04`'s "change one variable at
a time" rule exists to prevent.

`provider.require_parameters: true`, the documented control that should
cover exactly this, **does not work here** and was measured, not assumed:
`Sail Research` advertises both `max_tokens` and `reasoning` support in the
endpoints API, so it passes the filter and is still selected. 0/8 usable
with the flag set, identical to without it.

> **Resolution, 2026-08-22 (ADR-056).** `criteria.scoring.ignoredProviders`
> (defaulted `[]`) is threaded through `buildScorer` into
> `OpenRouterClient` and sent as `provider.ignore`; an empty list omits the
> field entirely, so the default request body is unchanged. `criteria.yaml`
> ships one entry, `sail-research`, with the measurement justifying it
> inline. Verified: 4/4 usable immediately after, and later probes land
> consistently on Baidu with valid JSON. A `criteria-file` test pins the
> exclusion so dropping it cannot happen silently.
>
> **The class of risk stays open, and it is the important part.** Nothing
> detects a bad provider automatically — this exclusion is reactive by
> construction, and the detection path is still "a human notices a bad
> digest and investigates for an afternoon." The data to do better already
> exists and is already persisted: `runs.llm_provider_counts` and
> `llm_error_type_counts` (ADR-052) were recording this the whole time and
> nothing read them. A per-provider failure-rate signal over those columns
> is the real fix and is not built here.
>
> **Also unresolved:** excluding a bad provider does not make a run
> reproducible — two runs can still use two different good providers, so
> calibration comparisons stay noisier than the M7 protocol implies. A
> `--provider` pin for `run-calibration.ts` specifically is the honest
> follow-up.

---

## B12 — Stage B has two caches, and clearing the obvious one is not a cold run

**Status:** fixed (diagnosis corrected, tooling added) · **Found:**
2026-08-22, trying to verify ADR-057 end to end

Attempting to confirm ADR-057 on the real Smarthis posting, its cached
`matches` row was deleted and the posting re-scored. Every attempt produced
the same impossible-looking trio: `Model calls: 0`, `stageBCacheHit: false`,
and a **freshly written `matches` row** still containing the old
`not_met` / `evidence: null`.

> **This entry originally blamed the calibration harness — that was wrong,
> and the correction is the whole point of keeping it.** It speculated that
> usage reporting was lying (a B7-style drift) or that a tripped circuit
> breaker was short-circuiting the calls. Neither. The reporting was
> accurate: **no model calls were being made.**
>
> **Real cause:** Stage B has _two_ caches, and the non-obvious one is read
> first.
>
> | table             | scope                                  | read by                           |
> | ----------------- | -------------------------------------- | --------------------------------- |
> | `matches`         | whole posting (ADR-007)                | `StageBMatcher.match`             |
> | `partial_matches` | one requirement (ADR-049 resumability) | `StageBMatcher.askOne`, **first** |
>
> `askOne` consults `partial_matches` before anything else, and a saved
> answer whose `evidence` is `null` is returned **with no revalidation at
> all** — the `saved.evidence === null ||` short-circuit. So every stored
> `not_met` was replayed verbatim, the whole-posting row was reassembled
> from those replays and rewritten with a fresh timestamp, and
> `stageBCacheHit: false` was still _technically true_ because the
> `matches` row really had been deleted. Three true signals composing into
> a completely misleading picture.
>
> **Consequence worth naming separately:** because that short-circuit skips
> the applicability guard entirely, a _guard_ change (ADR-057) can never
> retroactively affect an already-stored `not_met`. The guard's behaviour is
> not part of the cache key (ADR-042's composite identity covers prompt
> version, profile hash, requirements hash and model — not this), so
> invalidation after such a change has to be manual. Not a defect in ADR-042,
> but a real edge it does not cover, and the reason the "correlation
> unchanged at 0.468" readings in this session were cache replays rather
> than measurements.

> **Resolution, 2026-08-22.** `scripts/score-one.ts` (`npm run score:one --
<fingerprint> [--cold]`) scores a single posting through the real
> production path and prints every layer's decision per requirement.
> `--cold` clears **both** tables, and the script prints an explicit warning
> when a `--cold` run still makes zero model calls — the exact silent
> failure that produced this entry. Stage A's extraction is deliberately
> left cached so a cold Stage B run changes one variable, not two.
>
> Verified with it immediately: a genuinely cold Smarthis run made **13 real
> model calls across 10 providers in 24.5s for $0.0026**, and the
> requirement ADR-057 targets moved `not_met` → `met`, taking the posting
> from **43.83 `discard` to 50.00 `review`** (mandatoryCoverage 50% → 75%).
> That is the end-to-end confirmation ADR-057 shipped without.

---

## B13 — The Indeed collector never once ran on schedule

**Status:** fixed (both causes) · **Found:** 2026-08-22, auditing collector
freshness after the profile owner noticed the corpus was missing postings
visible on Indeed's own portal

Two independent failures, stacked. Either alone would have been enough.

**1. The systemd timer could never fire.** `argos-indeed-collect.service`
declared `Requires=docker.service` / `After=docker.service`. It is a **user**
unit; `docker.service` is a **system** unit, invisible from the user
manager's namespace. Systemd does not treat that as a missing ordering hint
— it cannot queue the job at all:

```
argos-indeed-collect.timer: Failed to queue unit startup job: Unit docker.service not found.
argos-indeed-collect.timer: Failed with result 'resources'.
```

The timer sat in `failed` while `systemctl --user list-unit-files` still
reported it `enabled`, which is what made this survive casual inspection.
The decisive evidence was `journalctl --user -u argos-indeed-collect.service`
returning **"-- No entries --"**: the service had never executed once in its
life. Every Indeed posting in the corpus came from the single manual
`docker run` the README prescribes as a pre-scheduling smoke test.

**2. Once it could run, it could not deliver.** With the timer repaired, the
scrape worked and the ingest POST died:

```
ConnectTimeout: HTTPConnectionPool(host='100.112.68.45', port=3000)
```

`collectors/indeed/.env`'s `ARGOS_API_URL` pointed at a **stale Tailscale
address**. This is the _same_ re-key that had broken the container's own port
bind earlier the same day (`ATLAS_TAILSCALE_IP` in the app `.env`). One
identity change silently broke two unrelated configs, and neither had any
detection.

> **Resolution, 2026-08-22.** The `docker.service` dependency is removed —
> **in the repo's unit templates, not only on Atlas** (`collectors/indeed/`
> and `collectors/catho/` shipped the identical bug, so a fresh install would
> have reproduced it exactly), with a comment explaining why the obvious
> declaration is wrong. `ARGOS_API_URL` updated to the current address.
>
> Verified end to end: `jobspy: 50 rows returned` → `ingest: HTTP 201` →
> `{"collected":50,"normalized":44,"isNew":41}`. Indeed went **43 → 87
> active postings**, and the timer now reports a real `NEXT` (02:00 UTC)
> instead of `-`.

**What this says beyond Indeed, and the reason it is filed as a defect
rather than a fixed config:** `runs.attempted_sources` cannot see this.
Push-based external collectors (ADR-027) never appear in a `collect` run's
attempted list, so every health signal this project has — the run rows,
`evaluateCollectionHealth`, the missed-run alert — reported green for six
days while a source contributed nothing. The corpus looked healthy because
CIEE and Gupy _were_ healthy. A source that stopped pushing was
indistinguishable from a source with nothing to push.

> **Detection built, 2026-08-22.** `evaluateSourceFreshness`
> (`scheduling/domain/alerts.ts`) reads the **corpus** rather than `runs` —
> via `PostingsRepository.findLastSeenAtBySource()` — because a posting's
> `lastSeenAt` is true regardless of how it arrived, which is exactly the
> property every run-log-based check lacks. Wired into the collection
> cycle's existing alert sweep and configured per source in
> `criteria.alerts.sourceFreshnessHours` (gupy/ciee/solides 72h, indeed
> 36h), each window set from that source's real cadence with slack for one
> missed run. A source with no configured window is not checked, so a
> dormant collector cannot alert about a decision nobody has made yet.
>
> Verified against this incident's own recorded numbers: fed the observed
> pre-fix state it emits `Source "indeed" has delivered nothing for 150h
(expected at least every 36h)`; fed the post-fix state it is silent. A
> source that has _never_ delivered gets different wording from one that
> went stale — "never" is a deployment problem (B14), "stale" an operational
> one, and sending an operator to the wrong one wastes the trip.

**Also unfixed:** 6 of the 50 rows came back `unnormalizable`. Not
investigated — noted so the number is not mistaken for noise later.

> **Follow-up, 2026-08-23 — the timer was firing but the pre-filter never
> passed anything it found.** With scheduling fixed, the real pre-filter
> was run against Indeed's actual candidates: **0 of 74 passed**, almost
> all `track_unknown` — the bare `SEARCH_TERM=estagio` default returns
> generic internships, the same shape ADR-011's own Gupy query comments
> already measured and rejected for that source.
>
> Probed real Indeed results before changing anything, the same discipline
> `criteria.yaml`'s query comments use: `"estagio"` alone matched 6 of 50
> titles to this project's tracks; `"estagio ti"` matched **30 of 50**,
> including exact-track hits ("Estagiário Full-Stack", "Estágio em
> Desenvolvimento de Software (Back-end / Full Stack)", "Estagiário
> DevOps", "TBG - ESTÁGIO - CIÊNCIA DA COMPUTAÇÃO") and real employers
> (a Nubank internship programme). Narrower terms were tried and rejected
> on the same near-zero-volume grounds ADR-018 already established:
> `"estagio backend"` returned 0 rows, `"estagio devops"` only 3.
>
> `collect.py`'s `DEFAULT_SEARCH_TERM` changed from `"estagio"` to
> `"estagio ti"`, with the measurement recorded in the script itself and in
> `.env.example`. Atlas's real `.env` carries no `SEARCH_TERM` override, so
> the fix is the new default, not a config edit that could drift from a
> future fresh install. Verified end to end on Atlas: `jobspy: searching
Indeed for 'estagio ti'` → `50 rows returned` → the real pre-filter run
> against the fresh candidates passed **7 of 110** (`dev`/`security`/
> `automation`, real employers — AFYA, OSKLEN, a Metrô do Rio programme),
> against **0 of 74** the session before.
>
> **A second, unrelated drift surfaced while verifying this and was fixed
> the same session.** `collectors/indeed/argos-indeed-collect.service` on
> Atlas still forwarded `-e ARGOS_API_KEY` and `.env` still defined that
> name — both stale since commit `15ae4c2` renamed the variable to
> `ARGOS_INGEST_API_KEY` in the repo (part of ADR-047's per-caller
> credential scoping). The deployed unit was installed once, by hand, and
> never re-synced after that rename; the repo's own template file had
> already been correct the whole time. Fixed by copying the repo's unit
> file over Atlas's live one (it already carries the B13 `docker.service`
> fix too) and renaming the value in `.env` to match.
>
> **This exposes a real gap, not fully closed here:** no
> `INGEST_INDEED_API_KEY` is configured in `argos-career`'s own `.env` on
> Atlas at all, so the "Indeed-only ingest credential" `ARGOS_INGEST_API_KEY`
> is supposed to be is, in practice, the shared **admin** key — able to
> trigger scoring, delivery, anything. ADR-047 built the capability-scoped
> credential mechanism; nothing has ever actually configured Indeed's scoped
> key on the server side. Fixing that means generating and wiring a real
> `INGEST_INDEED_API_KEY`, a deliberate act with its own value to manage —
> flagged here rather than done silently mid-session.

> **Two more track keywords, 2026-08-23 — real Indeed candidates still
> stuck at `track_unknown` after the `SEARCH_TERM` fix.** Read the fresh
> corpus by hand rather than assume the search-term fix alone closed the
> gap: 100 of 124 active Indeed postings (81%) still classified `unknown`
> by title, and two were genuinely on-track — "IT Support Intern" (HMH) and
> "Estagiário(a) em Dados e IA" (V3A). Measured before adding anything, same
> discipline as B10: `"ia"`/`"inteligência artificial"` — 1 + 2 matches
> across the full corpus, all on-track, no substring bleed into
> "Fisioterapia" or similar; `"it"` — 1 match, on-track. Both added
> (`dev` for AI/data, `automation` alongside the existing `"ti"` — English
> "IT" is spelled with different letters, so it never matched that entry).
>
> **Deliberately not added: bare `"tecnologia"`.** Measured 8 matches, but 6
> already classified via the existing `"tecnologia da informação"` phrase.
> The one genuine gain ("FGV - ESTÁGIO - TECNOLOGIA") came with one real
> false positive — "ESTAGIÁRIO NA ÁREA DE ENGENHARIA ELÉTRICA... (CET
> Brazil Equipamentos de Energia Elétrica e Tecnologia)", where the word
> lives only in the company's own name, the exact shape B8 already fixed
> once. Not a clean addition, so not made.
>
> Verified against the real corpus: pre-filter passes for Indeed went
> **7 → 9** (of 115 unclaimed candidates), total corpus-wide **10**.

---

## B14 — The Catho collector was never deployed at all

**Status:** parked (ADR-032 Amendment 1) — re-tested 2026-08-23, still
blocked, and the arithmetic does not justify it even unblocked ·
**Found:** 2026-08-22, the same collector audit

Catho has **zero postings in the corpus, ever**. Unlike B13 this is not a
broken deployment — there is no deployment: no systemd unit installed
(`systemctl --user list-unit-files | grep catho` → nothing), no timer, and no
`argos-catho-collector` image built on Atlas.

What does exist is the code and a substantial amount of design behind it: a
headless-browser collector (ADR-032), a checkpoint state machine (ADR-033),
an exact-origin allowlist with redirect interception (ADR-044), and
checkpoint durability with quarantine replay (ADR-045). Four ADRs and a
normalizer registered in `normalizer-registry.ts`, for a source that has
never contributed a single posting.

**Deliberately not deployed as part of this audit.** Catho is the one
collector that drives a real browser, it is the heaviest thing this project
would run on Atlas, and standing it up is a deployment decision with a
resource cost — not a bug fix to slip into a session about calibration.

> **Asked to deploy it, 2026-08-23 — re-tested first, and the answer is
> still no.** The 2026-08-17 audit's block was re-verified rather than
> trusted: the image was rebuilt on Atlas and the same default
> `chromium.launch()` `collect.ts` uses was pointed at real vaga URLs.
> **403, 2 of 2, zero `ld+json`.** A plain `curl` with the honest User-Agent
> gets **403** too, so this is not a headless-browser fingerprint problem
> as the audit assumed — Catho blocks _every_ non-interactive client on
> vaga pages. The probe image (3.48 GB) and its directory were removed from
> Atlas afterwards.

> **Two alternative collection strategies were measured, not theorised, and
> both fail — 2026-08-23.**
>
> **1. Google Jobs via `python-jobspy`.** The obvious reuse: CLAUDE.md §6
> already sanctions "Google Jobs / Indeed via an ephemeral Python
> container", the container already exists and works (B13), and Catho
> publishes `JobPosting` structured data that Google indexes. Ran it three
> ways (`google_search_term` phrased for Google Jobs, a plain Portuguese
> query, and bare `search_term`): **0 rows every time.** Indeed through the
> same image returns 50. The Google path is simply not producing results
> from this host.
>
> **2. Sitemap-only, no page fetch.** Catho's sitemaps are _not_ blocked
> (HTTP 200, honest UA, plain HTTP), and slugs carry the job title, so
> title filtering needs no browser at all. Measured across one real
> sitemap file and extrapolated over all 5:
>
> |                                     | count             |
> | ----------------------------------- | ----------------- |
> | vaga URLs                           | ~250,000          |
> | internship-titled                   | ~8,000            |
> | RJ-identifiable **from the slug**   | **~180**          |
> | of those, on-track for this profile | **single digits** |
>
> Location encoding is the killer: only 171 of ~50,000 slugs carry a `-rj`
> suffix, and the rest express location as a neighbourhood
> (`recreio-dos-bandeirantes`, `barra-da-tijuca`) or omit it. Worse, the
> slug carries **no description**, so nothing that arrived this way could
> reach Stage A at all — it would be an unscoreable title in the digest.

**Recommendation: park it, like Jooble (B4).** Not because the code is bad —
`state.ts`'s checkpointing is correct and tested — but because the
arithmetic never justified it, block or no block. ADR-032's premise was that
it is worth opening every title-matched posting once to learn its real city;
that is ~8,000 page loads to find single-digit relevant postings, a ratio
this project would reject from any other source. The block merely makes an
already-bad trade impossible.

Beating the block would mean stealth plugins or fingerprint spoofing, which
is precisely the evasion CLAUDE.md §6 forbids ("never forged to imitate a
browser") — so the arms-race option is closed by project rule, not just by
preference. The effort is better spent on sources with an API.

---

## B16 — `normalizeIndeedJob` silently discards ~15% of rows with `company: null`

**Status:** open, not fixed · **Found:** 2026-08-23, measuring candidate
search terms for ADR-060

`normalizeIndeedJob` (`src/posting/infrastructure/indeed-normalizer.ts`)
returns `null` — the standard "this item does not become a `Posting`"
contract (principle 1) — whenever `job.company` is falsy:

```ts
if (!job.company) return null;
```

Probing seven candidate `SEARCH_TERMS` values against real Indeed results
(`collect.py --dry-run`, 2026-08-23, 289 raw rows across the seven terms):
**44 rows (15.2%) carried `company: null`.** Some of those titles are
unambiguously on-track — "Estagiário DevOps", "Visagio Talentos - Estágio:
Desenvolvedor(a) Automação / Low-Code RJ" — and are discarded before the
pre-filter or track classifier ever sees them, indistinguishable in any
log line from a row that never existed. `company` is a required, non-empty
field on `Posting` (`src/posting/domain/posting.ts`), so this is not a
`createPosting` bug — `Posting.company` genuinely cannot be blank — but the
normalizer has no fallback for a source that states the field
inconsistently (the same real posting, scraped under two different search
terms in the same probe session, had `company` set once and `null` once).

Not fixed here — out of scope for ADR-060, which only needed to confirm
this does not bias _which_ search terms clear the bar (it doesn't: the
terms ADR-060 accepted cleared it with room, and the two it rejected had
their zero counts explained by other rows, not null-company ones).

**What fixing it would need:** a real fact to fall back on, per CLAUDE.md
§15 — not a guess. Candidates worth checking before writing code: does
`jobspy`'s DataFrame carry a differently-cased or differently-shaped company
field on those rows (e.g. `company_url` present with `company` empty) that
this schema currently drops via `.passthrough()`; does the title itself
reliably embed the employer name for these specific listings (several
observed do — "Visagio Talentos - Estágio: ..." — but this cannot be
assumed structurally true without checking a larger sample); or is this
simply how `jobspy` represents a subset of syndicated/aggregated listings,
in which case the honest fix may be "cannot recover a company name for
these, keep discarding them" rather than a code change at all.

---

## B15 — LinkedIn's real n8n ingest was silently discarded, 100%, since it started

**Status:** fixed, pending confirmation against the next real delivery ·
**Found:** 2026-08-23, investigating why the corpus has zero LinkedIn
postings despite ADR-029 shipping weeks earlier

The user reported ingest calls to `/runs/collect/external` succeeding
(`HTTP 201`) for LinkedIn, which contradicted `postings` having zero
`source = 'linkedin'` rows. Queried Atlas's real `runs` table directly
(read-only `docker exec`): three real ingest runs —
`01M09D05CN26CX5BGAD2XDSSVC` (2026-08-18, 4 items),
`01M0H46C3745K15XBH8GMXTGK0` (2026-08-21, 13 items),
`01M0P2Z81F2VRSYGMDSBBCXJA8` (2026-08-23, 16 items) — every one
`outcome: success`, and every one with `normalized: 0`. All 33 items across
the three runs hit `normalization_rejected`, with `posting_events`'
`source_id` column recording `null` for every one of them, not a real id.

`LinkedinAlertJobSchema` (`linkedin-alert-schema.ts`) required lowercase
`title`/`company` keys. It was fitted, per its own doc comment and
`test/fixtures/linkedin-jobs.md`'s provenance note, from a **screenshot**
of the n8n extraction table (2026-08-16) — never a captured real request,
exactly the gap CLAUDE.md §15 warns costs something eventually. That same
provenance file already named `Subject`/`ReceivedAt`/`ExtractedAt` as real
observed columns, Title Case, alongside the schema's own lowercase
`title`/`company` guess — an inconsistency nobody had reason to notice
until a real row surfaced.

The operator pasted a real n8n row 2026-08-23:

```
[Estagiariamente 2.2026- Núclea] - Programa de Estágio | Dados, Produtos & IA
Núclea    São Paulo, SP (Híbrido)    https://www.linkedin.com/jobs/view/4451703964/
Fwd: "estagio software vagas anunciadas…": vaga de Estágio em Desenvolvimento
Backend na empresa Bemobi Wave anunciada em 15/8/26    2026-08-16T18:36:00.019Z
```

Both "Núclea" and "Bemobi Wave" are the exact same companies
`linkedin-jobs.md`'s original 2026-08-16 provenance note already named as
appearing in the real screenshot — strong corroboration this is genuinely
representative of the real table, not a one-off. The Subject text names a
_different_ posting (Bemobi Wave) than the row's own Title/Company
(Núclea) — confirming one email digest bundles several postings under one
Subject, consistent with `Subject` being correctly treated as unused,
passthrough-only metadata.

**Two independent, stacked defects, not one:**

1. **Field casing.** The real row's structure is best explained by Title
   Case keys (`Title`, `Company`, `Location`, `Link`) rather than the
   lowercase names the schema required — matching the already-documented
   `Subject`/`ReceivedAt`/`ExtractedAt`. **Not a confirmed raw-JSON
   capture** — the pasted evidence is a rendered table row, not the HTTP
   Request node's literal body — so this is the best-supported hypothesis,
   flagged as such in the code, not asserted as verified fact.
2. **Missing `sourceId`.** Directly confirmed, not hypothesized:
   `posting_events.source_id` was `null` for every one of the 33 rejected
   items across all three runs. Whatever n8n sends, the envelope's
   `sourceId` field is not populated — contradicting the normalizer's own
   prior doc comment, which assumed "the caller (n8n) extracts the numeric
   id from the link's `/jobs/view/<id>/` path before POSTing."

> **Fixed, 2026-08-23.** `LinkedinAlertJobSchema` now lower-cases every
> payload key before validation (`z.preprocess`), so both the Title-Case
> shape the real row is best explained by and the original lowercase
> shape (this fixture's own, any hand-built caller) validate identically —
> tolerant of either, per CLAUDE.md §15's "write tolerant code" guidance
> for a boundary that still isn't fully confirmed.
>
> `normalizeLinkedinAlertJob` now falls back to deriving `sourceId` from
> `job.link`'s `/jobs/view/<digits>/` suffix whenever the envelope's
> `sourceId` is empty — reading a fact already present in a field this
> schema already validates, not inventing one. The envelope is still
> preferred when a caller does supply it.
>
> `executeIngestExternal` (`src/cli/main.ts`) now records content-free
> structural metadata (`payloadKeys`, `hasSourceId` — field names only,
> never values, matching `docs/08`'s boundary) on every
> `normalization_rejected` event. This is what should have made B15
> diagnosable straight from `posting_events` instead of requiring a pasted
> real payload to explain it after the fact.
>
> `alerts.sourceFreshnessHours.linkedin: 96` added — `linkedin` was
> entirely absent from the freshness check before this, the same blind
> spot B13 already named for Indeed and B14 for Catho, now closed for the
> third source running through this mechanism.
>
> **Not yet confirmed against a real delivery.** Every fix here is
> covered by unit tests reproducing the exact real-row shape (Title-Case
> keys, empty envelope `sourceId`, `/jobs/view/<digits>/` link), but the
> genuinely conclusive check — a real n8n run landing `normalized > 0` and
> a `source = 'linkedin'` row actually appearing in Atlas's `postings`
> table — has not happened yet. If it still fails, `payloadKeys` on the
> next `normalization_rejected` event will say exactly why, closing the
> loop this entry's own investigation had to do by hand.

---

## B17 — Sólides measured at zero real yield after two weeks; queries parked

**Status:** parked (ADR-031 Amendment 1) · **Found:** 2026-08-23, deciding
what to do about the source PR5's `report:supply` output made visible for
the first time

`npm run report:supply` against Atlas's live corpus showed what no earlier
measurement had: two full weeks of Sólides collection, 10 postings total
across both weeks, **0 on-track in either week** — the worst yield of any
active source, well below even CIEE's low-but-nonzero rate.

Measured further before deciding, the same discipline B14 already applied
to Catho: probed five tech-specific terms (`estágio ti`, `estágio
tecnologia`, `estágio desenvolvimento`, `estágio dados`, `estágio suporte`)
against Sólides's live API with `city: Rio de Janeiro`, matching the
production queries' own shape. Four returned nothing at all. The fifth
(`estágio tecnologia`) returned exactly one real, on-track, Rio-area
posting — "Estagiário de Banco de Dados | DBA | SQL Server | Híbrido |
Barra Olímpica" — and its `createdAt` is **2026-01-13**, eight months
before this measurement. Decisively too old under `maxAgeDays: 7` on any
reading of that date, not a borderline case.

A separate, broader probe with no city filter (`estágio ti`, nationwide)
returned 20 real, on-track-titled postings (`tracks: ["automation"]` or
similar) — proving Sólides's inventory itself is not empty of real tech
roles — but every one was outside the Rio metro area (Itajaí, Salvador,
Fortaleza, São Paulo, and 16 others), and 14 of 20 were independently
`too_old` regardless of location. Confirms the earlier finding is not an
artifact of one query: this source's Rio-area, fresh, on-track supply is
genuinely at or near zero, not merely unmeasured before now.

> **Parked, 2026-08-23 (ADR-031 Amendment 1).** The nine Sólides queries
> in `config/criteria.yaml` (estágio/estagiário/estagiária ×
> Rio/Niterói/São Gonçalo) are removed — not commented out — and
> `alerts.sourceFreshnessHours.solides` removed alongside them, the same
> "an unlisted source is simply not checked" reasoning `catho` already
> uses. `SolidesCollector`, its schema, normalizer and both registry
> entries are untouched: this is a query-budget decision, not a code
> retirement, and re-adding the nine queries is the entire reversal cost.
> Full measurement in ADR-031 Amendment 1.

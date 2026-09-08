# ADR-009 — Confine scoring and delivery to a single nightly window, deliver daily

## Status

Accepted

## Date

2026-08-14

## Context

M0 decided a twice-weekly digest — collection daily, delivery Tuesday and
Friday — reasoned in `docs/02-architecture.md` as reducing blocking risk and
shortening the discovery window relative to twice-weekly collection.

That reasoning solved a problem this project no longer has the same way. The
product vision has since grown (the realignment that produced ADR-008 and the
ADR-007 amendment), and with it a clearer picture of Atlas's constraints:
`atlas-manager`, Nginx and cloudflared serve real traffic on that box during the
day, and the scorer is a GPU-less 4B model whose inference is the single most
resource-intensive thing this project does. Running that inference at
unspecified times risks contending with services that are not this project's to
degrade.

Separately, a twice-weekly digest means a posting appearing right after Friday's
send is not delivered until the following Tuesday — up to four days of latency
on the exact case the pipeline exists to catch quickly.

## Considered options

### Keep collection daily, digest twice weekly (status quo)

Rejected. It no longer serves the reason it was chosen for: the discovery-window
argument that justified decoupling collection from delivery becomes moot once
delivery is daily. What remains is unmanaged risk — nothing constrains when the
LLM batch runs relative to Atlas's daytime load.

### One nightly cron for the whole pipeline

Considered seriously. Collect → Normalize → Dedup → Pre-filter → Score →
Deliver, triggered once nightly. Simplest possible scheduling: one cron, one
`runId` per night.

Rejected in favor of the option below because collection, normalization, dedup
and pre-filtering need no LLM and cost nothing worth protecting — folding them
into the nightly window buys simplicity at the cost of `firstSeenAt` accuracy
(ADR-007 amendment) and same-day visibility into what the corpus contains,
for no corresponding benefit.

### Frequent low-cost collection, single nightly scoring-and-delivery window

Accepted. Two independent cron schedules:

- **Collection** runs every few hours: collect, normalize, dedup, pre-filter.
  No model, no meaningful resource cost, no reason to defer it.
- **Scoring and delivery** run once nightly, in a configured off-peak window
  (default `03:00 America/Sao_Paulo`). This is the only window in which the LLM
  runs and the only time the digest is delivered.

## Decision

Two schedules, both configuration (`docs/09-configuration.md`):

1. `schedule.collection` — an interval, default every 4 hours. Runs Collect
   through Pre-filter. Cheap, frequent, no LLM.
2. `schedule.scoreAndDeliver` — a daily time and timezone, default
   `03:00 America/Sao_Paulo`. Runs Score through Deliver, once per night. The
   only point where `OLLAMA_KEEP_ALIVE=0` matters, because it is the only point
   where the model loads.

The digest is delivered **daily**, replacing the Tuesday/Friday cadence.

Principle 2 is unaffected: each stage remains independently invocable
regardless of which cron triggers it by default.

## Consequences

- **Worst-case discovery-to-delivery latency drops** from up to four days
  (posting right after Friday's send) to under 24 hours (posting right after one
  night's run, caught by the next). This is the headline improvement, not a
  side effect of the resource change.
- **The LLM runs in one bounded, predictable window per day**, isolated from
  Atlas's daytime load. `OLLAMA_KEEP_ALIVE=0` now has one clear load/unload
  cycle per day to reason about instead of an arbitrary number.
- **`firstSeenAt` accuracy improves** from "within a day" to "within the
  collection interval" — a few hours — which directly benefits the market
  time-series work planned for M10.
- **Reading the digest becomes a daily habit rather than a twice-weekly one.**
  The primary goal is a _weekly_ triage budget under 10 minutes; a smaller daily
  digest should cost less per read, but this is a claim to verify once M6 makes
  it observable, not to assume.
- **Two schedules instead of one** is more moving parts to configure and
  monitor. `08-observability.md`'s missing-run alert now needs to distinguish
  a missed collection cycle from a missed nightly batch — a collection miss is
  low-severity and self-heals next cycle; a missed nightly batch means no
  digest that day.
- **A quiet collection cycle is normal; a quiet nightly batch is not.**
  Existing alerting language ("consecutive empty runs") already covers this
  distinction, but the two schedules now need separately reasonable thresholds
  — a collection cycle finding nothing is unremarkable at a 4-hour cadence, and
  should not trip the same alert that would fire for two nights of an empty
  digest.
- Reversing this is cheap: both schedules are cron expressions in configuration,
  changeable without a code change or another ADR.

## Amendment 1 — twice-daily `scoreAndDeliver`, 2026-09-08

### Context

The original decision confined `scoreAndDeliver` to a single nightly window
for one concrete reason: it was the only point where the local, GPU-less
model ran, and running that inference at an unpredictable time risked
contending with `atlas-manager`, Nginx and cloudflared's daytime traffic. That
reason no longer holds — `OllamaScorer` was retired in ADR-016, and `ApiScorer`
calls a hosted model over HTTP, so a `scoreAndDeliver` run no longer touches
Atlas's own CPU/GPU budget in a way that matters.

Separately, real measured cost per run is cents, not dollars (`docs/10`:
recent nights ranged $0.0007–$0.012), so running it twice a day does not
introduce a cost concern the once-nightly decision was ever protecting
against either.

The concrete trigger: diagnosing and fixing the LinkedIn n8n Gmail credential
(`[[linkedin-ingest-blocked-on-link]]` in the operator's own notes) on
2026-09-08 left 43 new postings collected mid-evening, hours after that day's
one nightly run had already passed — they would otherwise have waited until
the next night to reach the digest at all.

### Decision

`schedule.scoreAndDeliver` changes from a single `time: string` to
`times: string[]` (one shared `timezone`), minimum one entry, deduplicated
and sorted at validation time (`CriteriaSchema`). Configured value moves from
`["03:00"]` to `["05:00", "17:00"]` — two windows, not an arbitrary higher
frequency, matching what one clear request actually asked for.

`SchedulerService` registers one independent `CronJob` per entry
(`scoreAndDeliver:0`, `scoreAndDeliver:1`, …), all sharing the same handler
and the same `RunLock` key ("scoreAndDeliver") the manual `POST /runs/deliver`
path already uses — two windows landing back-to-back is exactly the case that
lock already exists to serialize, so no new coordination was needed.

`evaluateMissedRuns` (`docs/08-observability.md`) changes from "did a
successful run land today" to "did a successful run land since the most
recent window that has already passed today" — the single-window version
would have gone blind to a second window failing on a day the first one
succeeded.

### Consequences

- **Worst-case discovery-to-delivery latency roughly halves again**, the same
  kind of improvement the original ADR-009 decision was made for — a posting
  collected just after the 05:00 run now waits at most until 17:00, not until
  the next day's 05:00.
- **Twice the LLM spend per day.** At current measured cost (cents per run)
  this is not a real budget concern, but it is not free, and would need
  revisiting if per-run cost ever grows (a bigger model, a pricier provider).
- **Two `scoreAndDeliver` Telegram digests a day** instead of one changes the
  reading habit ADR-009 named as a consequence to verify — worth checking
  whether two smaller digests still fit the "digest as a daily habit" framing
  approvingly, or start to feel like noise.
- **The missed-run alert got strictly more correct**, not just adapted: it
  now catches a later window failing independently of an earlier one
  succeeding, a gap the single-window version could not have had (only one
  window existed to check).
- Adding a third window, or changing either time, remains a configuration
  edit — no code change, no further ADR — same as the original decision's
  own closing consequence.

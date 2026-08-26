# ADR-067 — Say what failed, and hold an alert the channel could not carry

## Status

Accepted

## Date

2026-08-26

## Context

`docs/11-known-issues.md` B20 fixed the 2026-08-25 delivery failure itself
(ADR-065) and left two things open, both of which are about _finding out_
that something broke rather than about the break.

**1. A failed run would not say what failed.** The 2026-08-25
`scoreAndDeliver` row read `outcome: failed, failure_reason: null`. The logs
around it were full of unrelated OpenRouter timeouts, so the incident was
read as an LLM problem for a day; the actual cause — a Telegram transport
failure — was only found by reading `delivery_chunks` directly.

The reason was never unavailable. Five separate paths mark a run `failed`
while holding the explanation in a local variable and dropping it:

| Path                            | Reason in hand                                             |
| ------------------------------- | ---------------------------------------------------------- |
| `executeDeliver`, notify failed | `notifyResult.error.message` — also returned to the caller |
| `executeDeliver`, batch-fatal   | `batchFatalReason`                                         |
| `executeDeliver`, caught throw  | `cause`                                                    |
| `executeDedup`, caught throw ×2 | `cause`                                                    |

`executeCollect` and `executeIngestExternal` have always passed
`failureReason`. These five simply never did.

**2. A delivery alert travels over the channel that just failed.** Alerting
shares the digest's Telegram notifier, and `docs/08-observability.md` states
why: "A separate alerting channel for a personal project would be
infrastructure nobody maintains." That reasoning still holds — a second
channel means a second set of credentials, a second thing to renew, and a
second thing that fails silently.

But it leaves a hole with a specific shape: when Telegram is what broke, the
alert _about_ Telegram breaking is sent over Telegram. `sendAlerts` logs a
`logger.error` and moves on, and journald on a personal server is not a place
anybody looks casually — `docs/08`'s own "no personal data in logs" section
says as much about how logs get read. On 2026-08-25 the digest did not
arrive and nothing said so.

## Considered options

### Add a second alerting channel (email, ntfy, a webhook)

Rejected, and this ADR does not reopen it. `docs/08` already weighed it, and
the argument has not changed: it is infrastructure nobody maintains, and an
alerting path that is never exercised is one that will itself be broken on
the day it matters.

### Alert to journald more loudly and rely on log review

Rejected as already-the-status-quo-and-insufficient. This is exactly what
happens today; it is what failed to surface B20.

### Fail the health endpoint when an alert could not be sent

Rejected. `/health` is polled by nothing on this deployment — there is no
uptime monitor pointed at it — so it would move the signal somewhere even
quieter than journald.

### Queue the undeliverable alert and redeliver it when the channel returns (chosen)

Keeps the single-channel decision intact and closes the gap by moving the
alert in **time** rather than in space. The alert arrives late instead of
never, and "late" is a large improvement over "never" for every condition
alerted here — all of which describe states that persist until fixed.

## Decision

**Every path that marks a run `failed` writes `failure_reason`.** No path
that already had the reason discards it. The `batchFatalReason` case is
written only on the `failed` branch: a cancelled or successful run has no
failure to name, and populating the column there would make it ambiguous
rather than informative.

**An alert whose send fails is queued in `pending_alerts` and redelivered on
the next cycle whose send succeeds.** Details that are decisions, not
incidentals:

- **`text` is unique**, and that is the dedup mechanism. The alerting
  conditions are level-triggered (docs/08) — "source X has delivered
  nothing" is re-derived and re-raised every cycle — so a day-long outage
  would otherwise queue the same sentence six times and then spam it back on
  recovery. One row with an `occurrences` count instead.
- **`firstQueuedAt` is written once**, never moved, so the redelivered
  message can say how long the condition went unreported.
- **Redelivery is oldest-first, capped at 5 per cycle.** Oldest-first because
  the longest-waiting alert is also the most likely to describe something
  still broken. Capped because Telegram rate-limits per chat (docs/11 B3) and
  a long outage must not turn the first successful cycle into a flood.
- **Redelivery stops at the first failure.** If a send failed, the channel is
  still down and the remaining attempts would fail identically while holding
  up the cycle.
- **The redelivered text is prefixed** with when the alert was first raised
  and how many times the condition recurred. An alert that reads as current
  while describing something from hours ago is its own kind of wrong.
- **Draining runs on every collection cycle, including cycles with no new
  alerts** — a quiet cycle is precisely when a backlog is most likely to be
  waiting.

## Consequences

The everyday failure — a transient network blip during the nightly alert —
now self-heals within one collection cycle (4 hours) instead of vanishing
into journald. `runs.failure_reason` becomes trustworthy enough to diagnose
from, which is the property its absence cost a full day of investigation.

**This does not make alerting reliable, and should not be read as doing so.**
If Telegram is down at 03:00 and still down at every subsequent cycle, the
alert still never arrives; the queue only helps when the channel comes back.
A genuinely independent path remains unbuilt, deliberately, for the reason
`docs/08` gives. What changes is that the common case — a blip — stops
costing a lost signal.

The queue is unbounded in rows. Dedup on `text` is what makes that safe in
practice: the number of _distinct_ alert sentences the system can emit is
small and fixed by the conditions in `docs/08`'s table, so the queue's real
ceiling is that set, not the outage's length. If a future alert ever embeds
something high-cardinality in its text — a posting id, a timestamp — that
property breaks, and the queue would need a cap. Worth knowing before writing
such an alert.

One honest limitation of the tests: they drive `sendAlerts` against a faked
notifier through the real DI graph, so they prove the queue/redeliver/prefix
behaviour and the stop-at-first-failure rule, but no test exercises a real
Telegram outage end to end. The `failure_reason` half is stronger — its test
was verified to fail against the previous implementation, reproducing B20's
exact `expected null to be 'Telegram unreachable'`.

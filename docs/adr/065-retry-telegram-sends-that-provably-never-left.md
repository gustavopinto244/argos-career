# ADR-065 — Retry a Telegram send that provably never left

## Status

Accepted

## Date

2026-08-26

## Context

On 2026-08-25 the nightly `scoreAndDeliver` run was recorded `failed` and no
digest arrived. The logs pointed at OpenRouter — seven timeouts, two
invalid outputs, one `matching_failed` — and all of that was real, but none
of it was the cause. Reading Atlas's `delivery_chunks` directly:

```
status = 'uncertain', attempts = 1, last_error = 'Telegram request failed'
delivery_operations.status = 'failed'
```

The digest was composed in full — 1265 bytes, carrying a posting scored
**100%, verdict `apply`**. It failed at the transport, on the first attempt,
and was never retried. The posting reached Telegram 24 hours later, when the
next night's run composed a fresh digest.

Two parts of the design worked exactly as intended and are why this was a
delay rather than a loss. `notified_at` is written only on confirmation
(ADR-007), so nothing was marked delivered that was not. And the
`matching_failed` posting went to the review section with a manual-review
notice, precisely as ADR-006 requires.

The defect is narrower, and it is in how a transport failure is classified.
`sendMessageDetailed`'s `catch` treated **every** thrown `fetch` failure as
`uncertain: true`. `uncertain` is a deliberate and correct concept: it means
"the request may have been received, so re-sending could post the digest
twice," and `sendDurable` refuses to re-send an operation holding such a
chunk, demanding an explicit reconcile.

But that catch block covers two genuinely different situations:

- **The connection never opened** — DNS did not resolve, the connection was
  refused, the network was unreachable. No request byte reached Telegram, so
  the message provably was not delivered. Re-sending cannot duplicate it.
- **The connection existed and then broke, or timed out** — the request may
  have been fully sent and processed while the response was still in flight.
  Genuinely uncertain.

Collapsing the first into the second converts the most common and most
transient class of network failure into a halt requiring manual
intervention — intervention that, at 03:00, on a personal system with one
operator, does not happen. `attempts = 1` is the whole story: the client
gave up after one try at something it could have retried in half a second.

## Considered options

### Retry every transport failure

Rejected. It is what makes the incident go away and it reintroduces exactly
the risk `uncertain` was built to prevent: a timeout whose request did
arrive would post the digest a second time. A duplicate nightly digest is a
worse product than a late one.

### Keep the classification, add an automatic reconcile step

Rejected. Reconciliation means deciding whether a message that may exist
does exist. Telegram's API offers no lookup by content, so an automatic
reconcile would have to guess — and a wrong guess either duplicates the
digest or silently drops it. The manual path stays for the genuinely
uncertain case, where a human can just look at the chat.

### Narrow `uncertain` to failures that are actually uncertain (chosen)

Distinguish the two situations by the error the runtime already reports.
`fetch` surfaces connection failures as `TypeError: fetch failed` with the
real `code` on a nested `cause`, so `isCertainlyUndelivered` walks the cause
chain looking for a code that means the connection never opened.

## Decision

`ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH` and
`ENETDOWN` are treated as **certainly undelivered**: retried in place with
exponential backoff (`transportRetryBaseMs`, default 500 ms, bounded by the
existing `maxRetries`), and if retries are exhausted the chunk is marked
`failed` rather than `uncertain`, so the next run re-sends it instead of
halting on a chunk no human will clear.

Everything else keeps today's behaviour, deliberately. An `AbortError` or
`TimeoutError` — this client's own timeout — returns `uncertain` without
retrying. `ECONNRESET`, `EPIPE` and `ETIMEDOUT` are **specifically excluded**
from the safe list: the connection existed, so the request may have been
delivered before the socket died.

The list is an allowlist, not a denylist. An unrecognised error code stays
`uncertain`, which is the safe default.

## Consequences

The 2026-08-25 incident, re-run against this code, delivers: the connection
error is retried, and if it persists the chunk is left retryable so the next
scheduled run sends the same digest rather than composing a new one a day
later. A test reproduces exactly that sequence, and three of the new tests
fail against the previous implementation — verified by reverting the
predicate and re-running.

The cost is a real one: the safe list is a claim about what these error
codes mean, and it is only as good as that claim. If a future Node or undici
version reports a post-send failure under one of these codes, this change
would retry something that was delivered, and the digest would be posted
twice. The list is deliberately short and errs toward `uncertain` for
exactly this reason, and the exclusions are documented next to it so the
next person to add a code has to argue against a stated boundary rather than
an empty set.

This also means a delivery outage now consumes retries and wall-clock time
inside the run, holding the `RunLock` slightly longer. Bounded by
`maxRetries` and a 500 ms base, the worst case is a few seconds — far below
`DEFAULT_TIMEOUT_MS` for a single request, so it does not change the shape of
the run's worst case.

**Not addressed here, and still open:** the run recorded `outcome: failed`
with `failure_reason: null`, which is why the logs were misread as an LLM
problem in the first place. And alerting for a delivery failure still travels
over Telegram — the channel that had just failed — so nothing reported this
at the time. Both are real; both are separate from the classification bug
this ADR fixes.

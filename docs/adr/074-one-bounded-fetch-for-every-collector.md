# ADR-074 — One bounded fetch for every collector: the deadline covers the body

## Status

Accepted

## Date

2026-08-30

## Context

All five HTTP collectors (`gupy`, `ciee`, `nerdin`, `infojobs`, `solides`)
carried a byte-identical `fetchWithBackoff`, differing only in the source
name inside one error message. Five copies of the same code carried five
copies of the same two defects.

**The deadline ended at the response headers.** Each copy cleared its
`AbortController` timer in a `finally` that runs the moment `fetch` resolves,
then returned a `Response` whose body the caller read afterwards:

```ts
} finally {
  clearTimeout(timer);          // fires when the HEADERS arrive
}
…
const response = await this.fetchWithBackoff(url);
body = await response.json();   // no deadline at all
```

A source that sends headers and then stalls its body therefore ignored the
configured bound entirely — 10 s for Gupy/NerdIn/InfoJobs/Sólides, 20 s for
CIEE — and fell back to undici's default 300 s `bodyTimeout`, per request and
per retry. NerdIn and InfoJobs fetch one detail page per card, so a stalled
source could consume the entire 4-hour collection window and leave the
`RunLock` held behind it, blocking every later scheduled run. That is
principle 1 (`docs/02-architecture.md`) failing in the one direction it is
supposed to prevent: a broken source taking the pipeline with it.

Not observed in production — no collect run has hung — which is why this is
a review finding rather than an incident. The bound was simply never the one
the code claimed.

**There was no size bound at all.** `TelegramNotifier` has `readBoundedBody`
with an explicit `DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES`; the collectors had
nothing, so `.text()` on a broken or hostile upstream was unbounded memory on
a box shared with `atlas-manager`, Nginx, cloudflared and two other
containers (CLAUDE.md §5).

A third, smaller consequence: because the body read happened in the caller, a
body that failed mid-read was **not** retried — it fell outside the retry
loop and lost the whole page.

## Considered options

### Option A — Keep the per-collector copies, fix each in place

Five near-identical patches.

### Option B — Extract one `fetchWithDeadline` returning the body text

The shared function fetches _and_ reads under one deadline, with a size cap,
and returns `{ ok, status, statusText, body }`. Collectors parse the text
themselves (`JSON.parse`, or an HTML pass).

### Option C — Extract it but keep returning `Response`, handing the caller the timer

Preserves the existing call sites exactly.

## Decision

**Option B.**

Option A leaves the duplication that produced the problem: the next defect
found here would again need five patches, and the next collector added would
again copy whichever version its author happened to look at.

Option C cannot actually work. If the caller owns the timer, the caller can
forget to clear it — and the deadline's whole job is to be unforgettable.
Returning the body is what makes it structurally impossible to read outside
the deadline, which is the property this ADR is buying.

**`DEFAULT_MAX_RESPONSE_BYTES` is 8 MB, measured rather than guessed**
(CLAUDE.md §15). The largest real bodies observed, 2026-08-30, with the
project's own honest `User-Agent`:

| Request                              | Bytes   |
| ------------------------------------ | ------- |
| Gupy `limit=10` (the real page size) | 28,873  |
| Gupy `limit=100` (worst plausible)   | 301,932 |
| NerdIn listing HTML                  | 220,934 |

8 MB is ~26× the worst real case — generous enough that no legitimate
response is at risk, small enough to bound the failure. `ResponseTooLargeError`
is deliberately **not** retried: the size is a property of the response, so a
second attempt produces the same one.

Retry semantics are otherwise unchanged and now stated in one place: a thrown
`fetch` failure and a 5xx are retried on the caller's backoff schedule; any
status below 500 is returned as-is, because the request itself is wrong and
repeating it wastes the source's time for no different outcome (CLAUDE.md §6's
collector etiquette). A 5xx body is not read at all — it is not the payload,
and draining it would spend the deadline on something no caller looks at.

## Consequences

**One behaviour genuinely changes:** a body that fails mid-read is now
retried, where before it aborted the page. That is the correct reading — it
is a transport failure like any other — but it is a change, not a pure
refactor, and it is what the "retries a body that fails mid-read" test pins.

**Net −62 lines** across the five collectors, and the next collector added
gets the bounded behaviour by construction rather than by remembering to
copy it.

**`FetchedBody` carries `statusText`** only because four collectors already
print it alongside the status in their `CollectionResult.error.message`.
Dropping it would have been a silent regression in operator-facing text.

**Reversible**, though not trivially: restoring the per-collector copies means
five files. The shared module can be swapped out behind `fetchPage` in each
collector without touching any call site.

**Verified by reverting.** Restoring the old shape inside `fetchWithDeadline`
— clear the timer on headers, `await response.text()` — makes three tests
fail, two of them by **timing out at vitest's 5 s limit**, which is the
defect demonstrated rather than described: unbounded, they would have sat
there for undici's 300 s.

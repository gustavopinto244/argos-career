# ADR-079 — Filter InfoJobs by its own age facet before fetching detail pages

## Status

Accepted

## Date

2026-09-01

## Context

`InfoJobsCollector` (ADR-063) costs two HTTP requests per posting: the
listing states only a card id and a detail-page link, so everything that
decides a posting's fate — description, location, and crucially
`datePosted` — lives one request away.

`executeCollect` then drops anything published before the recency cutoff
(`recencyDays: 1`). The two facts compose badly: **age is only knowable
after the request that age would have avoided.**

Measured in production on 2026-08-31, from `runs.source_query_stats` and
`posting_events`:

| query                    | received | schemaRejected | error | `too_old` | normalized |
| ------------------------ | -------- | -------------- | ----- | --------- | ---------- |
| `estagio ti` / Rio       | 6        | 0              | null  | **6**     | 0          |
| `estagiario ti` / Rio    | 19       | 0              | null  | **19**    | 0          |
| `estagio ti` / remote    | 5        | 0              | null  | **5**     | 0          |
| `estagiario ti` / remote | 12       | 0              | null  | **12**    | 0          |

Identical in every run for days. The collector is healthy — the same four
live requests return 6/19/5/12 cards today, zero schema rejections, no
network error. It reads InfoJobs correctly and then throws all of it away
on age: **2,027 detail fetches over eight days, for nine postings**, of
which two were ever notified.

This is not a yield problem to be fixed by widening the window. InfoJobs
states its own supply through the `Antiguedad` facet, and for all four
configured queries it reads **"Hoje (0)"** — the source genuinely
published nothing today. The defect is that the collector spends ~46
requests per run to discover a fact the listing page already gave away for
free.

### What the site actually offers

Read from the real facet links' `data-url` attributes and their labels, the
same discovery method ADR-063 used for the location suffix:

- `?Antiguedad=N` — an age facet, `1` "Hoje", `2` "Últimos 3 dias",
  `3` "Última semana", `4` "Últimos 15 dias", `5` "Último mês".
- `?campo=griddate&orden=desc` — sort by date, verified to reorder.

**The buckets are disjoint, not cumulative.** This was measured rather
than inferred, because the labels read cumulative and the naive reading
loses postings silently. Against a live 20-card listing: bucket 2 returned
the 3 newest ids, bucket 3 returned 20 _older_ ids, and every pair of
buckets intersected in exactly zero ids. Covering "the last N days"
therefore means fetching buckets `1..k` and taking their union.

One measurement came free with that: the union of all five buckets is
**61 ids against 20 for the unfiltered listing**. ADR-063 accepted
single-page-only collection because no pagination parameter worked; the
age facet turns out to be a way past that limit for the age ranges asked
for.

## Considered options

### A. Widen `recencyDays` for InfoJobs

Rejected. It treats a cost problem as a policy problem, and would import
weeks of stale postings into scoring to avoid a wasted request. The
`too_old` verdicts are correct; the requests spent reaching them are not.

### B. Sort by date and stop early

Considered. `?campo=griddate&orden=desc` works, so the collector could walk
the sorted listing and stop at the first card older than the window. But
the listing still states no date — stopping early requires fetching each
detail page to learn when to stop, which is the cost being removed. It
would help only in combination with the facet, and adds nothing on top of
it.

### C. Park the source, as Sólides was (ADR-031 Am. 1)

Considered seriously, on the numbers: nine postings in eight days, two
notified, and at least one of them (FUNDAÇÃO MUDES, "Estágio em
Tecnologia") arrived independently via Indeed and was absorbed by the
fingerprint dedup. Not chosen, because unlike Sólides the source is not
broken and its filters are honoured — it is a low-flow source being
queried expensively. Fixing the cost is cheaper and more reversible than
removing and later restoring the queries.

### D. Query the `Antiguedad` buckets that cover the window (chosen)

One listing request per bucket, union of their cards, detail pages fetched
only for what survives. When no bucket covers the window, the collector
falls back to the ADR-063 behaviour unchanged.

## Decision

`InfoJobsCollector` accepts an optional `maxAgeDays` criterion. When set,
it requests buckets `1..k` — the shortest prefix whose oldest bucket covers
`maxAgeDays` — and unions the cards, deduplicated by id. When absent, or
when the window exceeds the oldest bucket (30 days), it makes the single
unfiltered listing request it always made.

A bucket that fails is a partial loss, not a collection failure: the other
buckets' cards persist and the run still reports the error, the same
reasoning AC-004 applies to a paging collector's later-page failure. Only a
call that recovered no listing at all returns empty-with-error.

`config/criteria.yaml` sets `maxAgeDays: 7` on all four InfoJobs queries.

## Consequences

**Cost.** Measured by running the real collector against the live site on
2026-09-01, counting its own requests across all four configured queries:

| configuration       | listing | detail | total  | postings returned |
| ------------------- | ------- | ------ | ------ | ----------------- |
| before (unfiltered) | 4       | 42     | **46** | 42, all `too_old` |
| `maxAgeDays: 7`     | 12      | 7      | **19** | 7                 |
| `maxAgeDays: 1`     | 4       | 0      | **4**  | 0                 |

A 59% reduction as configured, and the shape is what matters: on the
dominant day no detail page is fetched for a posting the cutoff would
reject. The `maxAgeDays: 1` row is what the dynamic window would cost, and
is the argument for the follow-up below.

**Coverage improves slightly**, which was not the goal: the bucket union
reaches postings the single unfiltered page truncated away.

**7, not 1, and that is a real cost.** `maxAgeDays` must cover
`recency.backfillDays: 7`, or the first run after an outage would silently
ignore the widened window it was given. So on an ordinary day the collector
still fetches detail pages for postings 2–7 days old that the 1-day cutoff
will reject — 19 requests where 4 would do, per the table above.

**What this does not do.** The collector is told a _configured constant_,
not the window `executeCollect` actually computed. Aligning the two —
passing the real per-source window into the criteria — is the change that
would make the tight value safe, and it touches how every collector is
called, so it is deliberately not bundled here.

**Reversal cost:** delete four `maxAgeDays` lines from `config/criteria.yaml`.
The collector's unfiltered path is unchanged and still tested.

**Unverified:** the bucket→days mapping is read from InfoJobs's own labels
and confirmed against ids on one live listing. If InfoJobs redefines a
bucket, the collector would quietly narrow its window — the failure shape
would be "fewer postings", not an error. Re-check with the disjointness
probe if InfoJobs's search behaviour changes.

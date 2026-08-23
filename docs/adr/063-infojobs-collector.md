# ADR-063 — Add InfoJobs as a source, via listing scrape + detail JSON-LD

## Status

Accepted

## Date

2026-08-23

## Context

A discovery sweep of the discovery pipeline (2026-08-23) found InfoJobs
(`infojobs.com.br`) as a real candidate: `robots.txt` allows every path a
collector would need, listing pages return real, server-rendered results
for "estagio ti" + Rio de Janeiro without a browser, and — unlike the
initially-guessed `?palabra=&provincia=` query-string form, which silently
returns the unfiltered nationwide set — a friendly-URL location suffix,
found by reading the real facet links' own `data-url` attributes, reliably
filters to the target metro.

No JSON API exists for this source, unlike every other source this project
has added. Two different pages carry two different shapes:

- The **listing** page is server-rendered HTML with no embedded JSON at
  all. Everything this project needs from it — a stable id, the detail-page
  link — sits on one `<div>` per result card.
- The **detail** page, by contrast, carries a clean
  `application/ld+json` `schema.org/JobPosting` block: title, a real prose
  description (with literal `<br>` line breaks), `datePosted`, a
  structured `hiringOrganization.name`, a structured `jobLocation.address`
  (city/state, not a slug to parse), `baseSalary`, `validThrough`. A real
  JSON parse, not scraped.

This asymmetry decided the collector's whole shape: scrape the listing only
for _which_ postings exist, fetch each one's detail page for everything
else.

## Considered options

### A. Listing-only, no detail fetch

Rejected. The listing carries no description at all — a posting collected
this way would trip `lowConfidence` and cap at `review` forever, the exact
permanent limitation ADR-029 accepts for LinkedIn because LinkedIn's alert
email genuinely states no description anywhere. InfoJobs is different: the
description exists, one HTTP request away, on a source with no reason
(unlike LinkedIn's inbox-only constraint) to avoid fetching it.

### B. A general HTML parser for the listing (e.g. `node-html-parser`)

Considered, not chosen. Every other collector in this project talks to a
JSON API; adding an HTML-parsing library would be a new dependency for a
need that turned out to be narrow — two attributes (`data-id`, `data-href`)
on a fairly regular card component. A block-scoped regex
(`infojobs-listing-parser.ts`, splitting the page on each
`<div id="vacancyNNNN"` boundary before extracting attributes per block)
covers it without the new supply-chain surface. Accepted trade-off, stated
plainly: this is more fragile to a markup change than a real parser would
be — a card missing either attribute is skipped, not a collection failure
(principle 1), which bounds the damage of that fragility to "fewer results
this cycle," not a crash.

### C. Listing scrape + detail JSON-LD fetch (chosen)

One HTTP request per listing query, one more per result card. Both real
requests, both honoring the same politeness interval (CLAUDE.md §6). The
detail page needs no HTML parser at all — `JSON.parse` on the one
`<script type="application/ld+json">` block already gives a clean,
structured object.

## Decision

`InfoJobsCollector` fetches the listing (friendly-URL, `?type=` equivalent
not needed — the search term itself already narrows to internships when
phrased right, see the query measurement below), parses cards with
`parseInfoJobsListing`, then fetches each card's detail page in sequence
(paced by `requestIntervalMs`), extracting and validating the JSON-LD block
against `InfoJobsJobSchema`. `id` and `jobUrl` are not part of the real
JSON-LD — this collector adds both itself from the listing card before
validation, and the schema's own doc comment says so explicitly, so a
future reader does not mistake them for InfoJobs's own fields.

**Single-page only.** No working pagination parameter was found — `Pagina`,
`pagina`, `page`, `Page`, all guessed and tried live, every one returned
page 1's own content again. Accepted as a documented gap, matching this
project's own precedent for an incomplete-but-honest first cut (Indeed
shipped with one query for weeks before B13's follow-up added more): a
single query returns ~20 real cards today, bounded by `maxResults`, and
nothing about the collector's shape prevents adding real pagination later
if a working parameter is ever found.

**`workMode` is `"remote"` only when InfoJobs's own home-office facet
returned the posting, `"unknown"` otherwise.** InfoJobs's JSON-LD states
only a physical address, never a structured remote/hybrid/onsite field —
a title or description mentioning "Home Office" is not read as evidence of
anything structural (CLAUDE.md §15). What _is_ read is which listing facet
the collector queried: a posting returned from `-trabalho-home-office` is
InfoJobs asserting the role is home-office, and the collector records that
as `isRemoteQuery` on the merged payload (the same kind of collector-added
field `id`/`jobUrl` already are).

**This was originally `"unknown"` unconditionally, and that was a real bug
— see `docs/11-known-issues.md` B18.** The pre-filter then judged remote
postings on the employer's physical address, so both remote queries in
`config/criteria.yaml` were structurally incapable of ever delivering a
posting: measured live, 2 of 5 real postings rejected purely on location,
0 passing. After the fix, 0 rejected on location and 2 real on-track
remote internships pass. Caught in a post-merge audit of this ADR, not in
production.

**Queries, measured before shipping**, the same discipline every prior
source's query list in `criteria.yaml` uses. Bare tech words with no
"estagio"/"estagiario" prefix (`ti`, `dados`, `tecnologia`,
`desenvolvimento`, `programador`) returned ordinary, non-internship job
postings — InfoJobs's search does not implicitly restrict to internships.
Prefixed multi-word terms fared little better: `estagio desenvolvimento`,
`estagio dados` and `estagio seguranca da informacao` all returned the
same generic, mostly off-track set as a bare `estagio` search. Only `ti`
reliably narrowed results — `estagio ti` and `estagiario ti`, both listed
(InfoJobs matches close to literally, and the two returned different,
only partly overlapping sets — the same reason Gupy's own query list
carries every gender/inflection). `estagiaria ti` was also tried and
returned the exact same set `estagio ti` already covers — not added,
redundant. Four queries ship: `estagio ti`/`estagiario ti` × Rio de
Janeiro/remote. Niterói and São Gonçalo are not yet measured — a cheap,
deferred follow-up (a city-slug change only), matching Gupy's own "the
remaining cities... measured deliberately, not an oversight" precedent for
the same gap.

**Cross-source dedup is deferred, not built speculatively.** InfoJobs is a
job board, the same unmeasured-but-plausible-overlap category
`docs/02-architecture.md`'s source-topology table already places Catho in
— not a Gupy/CIEE-style ATS/agency pair with a measured-zero overlap. The
existing exact-fingerprint dedup already catches an identical cross-posted
listing for free, for every source pair; a fuzzy, cross-source layer-2
check is real, unbuilt work. Not attempted here: no real InfoJobs corpus
exists yet to measure real overlap against, and B4 (Jooble) is the
project's own standing warning against building a dedup layer before there
is data to verify it works against.

**A real bug was found and fixed while writing this collector's own
tests, not in production.** The first implementation wrapped the entire
per-card detail-fetch loop in one `try`/`catch` — a single card's detail
page exhausting its own retry budget (a persistent 5xx, a timeout) threw,
and the outer `catch` turned that into a whole-collection error, silently
discarding every other card already fetched or still pending. Caught by a
test asserting that one failing detail page should not cost every other
card in the same listing (`infojobs-collector.test.ts`), before this ever
ran against the real site. Fixed by scoping the `try`/`catch` to each
card's own fetch/parse — a per-item failure now increments
`schemaRejectedCount` and the loop continues, matching every other
collector's principle-1 contract and this collector's own doc comment,
which already claimed that behavior before the code actually delivered it.

## Consequences

**Easy:** a sixth `CollectorPort` implementation, same registries, same
`CollectionQuerySchema` (`isRemoteWork` reused directly rather than adding
a synonymous `remote` field — a lesson taken from ADR-062's own
`CollectionQuerySchema` gap the same session), same fixture-script
convention, same contract-test shape as every prior collector.

**Harder than every prior source:** two real HTTP requests per posting
instead of one, so a query's real cost scales with its result count in a
way Gupy/CIEE/Sólides's single-envelope-per-page requests do not. Bounded
by `maxResults` (default 20) for exactly this reason.

**Left honestly open, not solved:**

- No working pagination — this project's collection stays bounded to each
  query's first ~20 results until a real pagination mechanism is found.
- Niterói/São Gonçalo queries, and a remote-specific term set beyond
  `ti` — both cheap, both deferred pending measurement.
- Cross-source fuzzy dedup against Gupy/CIEE — deferred pending a real
  corpus to measure overlap against.

**Reversal cost:** low — delete the four source files, two registry
lines, and the `criteria.yaml` block; nothing elsewhere depends on
InfoJobs existing.

**Amendment 1 — 2026-08-23, post-merge audit.** Two defects in this ADR's
own merged code, both found by auditing it rather than by running it in
production, both recorded in `docs/11-known-issues.md` B18: the remote
`workMode` bug described above (fixed, verified live), and
`extractJobPostingJsonLd` taking the first `application/ld+json` block
without checking `@type` (hardened — latent, since every real page
sampled carries exactly one block and it is the `JobPosting`, but the
failure mode would have been every posting silently rejected with the
source looking empty rather than broken).

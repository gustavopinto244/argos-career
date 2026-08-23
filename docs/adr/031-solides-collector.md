# ADR-031 — Add Sólides Vagas as a source, via its own undocumented public API

## Status

Accepted

## Date

2026-08-17

## Context

The user asked to consider two more Brazilian job boards, Catho and Sólides,
as candidate sources beyond Gupy/CIEE/Indeed/LinkedIn. Neither is named in
`CLAUDE.md` §6's source table — this ADR is the discovery-and-decision record
for both, since the right architecture turned out to depend entirely on facts
that had to be found first, not assumed.

Investigating both live, before writing any collector code:

**Catho** (`www.catho.com.br`): `robots.txt` is mostly open but explicitly
disallows `/buscar/vagas/` — the search/listing path — for the general `*`
agent. Worse, individual posting pages actively block by User-Agent: an
honest, self-identifying UA gets `403 Forbidden` (plain nginx, no Cloudflare
markers); a real browser UA gets `200`. No public JSON API was found. A fresh
sitemap of individual postings does exist and is not disallowed
(`sitemap_vagas_*.xml`), so a path exists — a headless browser with its own
genuine UA (not "forged," per CLAUDE.md §6's actual rule, since a real
browser's default UA is an honest statement of what it is), walking the
sitemap and self-filtering since the search endpoint is off-limits. Real
complexity, closer to Indeed's ADR-028 shape than to Gupy's. **Not built in
this ADR** — parked as a distinct future decision with its own cost/benefit
call, not folded into this one.

**Sólides Vagas** (`vagas.solides.com.br`): `robots.txt` is fully open
(`Allow: /`). The page itself is a Next.js SPA with no job data in its HTML
or its own `_next/data/*.json` payload — opening it in a real browser and
reading the network request it makes turned up a public, unauthenticated
JSON API (`apigw.solides.com.br/jobs/v3/portal-vacancies-new`) that a plain
`curl` with an honest User-Agent and no cookies reaches directly. Same shape
as Gupy's `employability-portal.gupy.io` (M3): undocumented, public, JSON,
no anti-bot fight. Full discovery detail, including the `take`-must-be-10
gotcha, in `docs/02-architecture.md`'s new "Verified: the Sólides response
shape" section.

Given that asymmetry, this ADR builds Sólides only, following the M3
pattern exactly — schema, normalizer, collector, fixture script, curated
fixture with provenance, contract tests, registry wiring, criteria.yaml
queries. Catho is deferred to its own future ADR.

## Considered options

### Catho, via a headless browser walking the sitemap

Technically permitted (ADR-020 lifted the memory budget specifically to allow
a headless browser; a real Chromium UA is not a forgery). Deferred, not
rejected: real complexity for a source whose actual internship-relevant
volume is unmeasured, and the search endpoint being off-limits means every
posting would need its own page load to discover title/location before even
knowing whether it is worth scoring — a materially different cost shape than
every other source this project has built. Worth its own ADR once someone
decides it is worth measuring.

### Sólides, ignored because a login/company-picker felt implied

The corporate marketing site (`solides.com.br`, distinct from
`vagas.solides.com.br`) returns 403 on `robots.txt` itself and looked, at
first glance, like a per-company ATS requiring a known company slug per
query — the same shape that would have made this project's search profile
undiscoverable without a company list, the way Gupy would be if it had no
aggregate endpoint. Rejected once actually checked: `vagas.solides.com.br` is
a separate, working aggregator across every Sólides customer — a `curl` with
no auth returned real results before this assumption was tested any further.
The lesson generalizes: CLAUDE.md §15's "do not invent a fact that can be
checked" cuts both ways — the pessimistic guess needed checking as much as an
optimistic one would have.

### Sólides via the public API, matching Gupy's shape (chosen)

`SolidesCollector` implements `CollectorPort` exactly like `GupyCollector`:
in-process HTTP client, `~1.5s` interval, exponential backoff, explicit
timeout, honest User-Agent, never throws. The one real structural difference
from Gupy — Sólides's `locations` parameter wants `"Cidade - UF"`, not a bare
city name — is absorbed inside `SolidesCollector.buildUrl`, not leaked into
`config/criteria.yaml`'s `CollectionQuerySchema`, which stays the
source-agnostic shape it already was.

## Decision

Sólides is registered as a fifth source (`collector-registry.ts`,
`normalizer-registry.ts`), with nine queries in `config/criteria.yaml` — the
same three literal terms (`estágio`/`estagiário`/`estagiária`) across the
same three RJ-metro cities (`Rio de Janeiro`/`Niterói`/`São Gonçalo`) Gupy
already queries, deliberately not trusting the one-sample finding that a bare
`estagio` might already cover all three (see `docs/02`'s new section) without
measuring it the way ADR-018 measured Gupy's term list. No remote query is
added: `title=estagio` with no `locations` filter returned 3,638 nationwide
results during discovery (728 pages at the fixed `take=10`) — walking that to
find the `homeOffice: true` subset is the same low-signal-volume trade
ADR-018 already rejected for Gupy.

`homeOffice` (boolean) is the signal `SolidesJob`'s normalizer trusts for
`WorkMode`, not `jobType` (an open string, only `"presencial"` ever
observed) — documented in the schema and normalizer as an honest gap, not a
guessed enum mapping.

Catho is not built. Parked with the reasoning above, for a future ADR to pick
up if the volume turns out to justify a headless-browser collector.

## Consequences

**Easy:** a fifth `CollectorPort` implementation that cost one endpoint
discovery session and no new architecture — same registries, same
`CollectionQuerySchema`, same test shape as Gupy's four test files, same
fixture-script convention. Reversal is deleting the three new source files,
two registry lines, and the criteria.yaml block; nothing elsewhere depends on
Sólides existing.

**Hard:** this is an **undocumented** third-party endpoint, found by reading
one browser's network tab, not a published API with a stability guarantee.
It can change shape or disappear without notice — the same risk Gupy's own
schema comment already names, and the same tolerant-schema mitigation
(`.passthrough()`, only `id`/`title` required) is the whole defense.

**Left honestly open, not solved:** the Gupy/Sólides company-overlap
assumption (both ATSs, expected low overlap, same reasoning as the measured
Gupy/CIEE result) is recorded as an expectation in `docs/02`, not a
measurement — no real Sólides corpus has been collected yet to check company
names against. Re-measure once it has. Catho stays unbuilt; its own decision,
not deferred silently.

**Reversal cost:** low, per Easy above. Not yet run against the real live
scheduler — wired and unit-tested against a curated fixture, matching the
honest status this project already uses for a just-landed source before its
first real collection cycle.

## Amendment 1 — 2026-08-23: queries parked, measured at zero real yield

The "not yet run against the real live scheduler" caveat this ADR closed
with has since been answered, and the answer is worse than the "Hard"
section's real-endpoint-can-change risk: Sólides ran for two full weeks in
production and delivered nothing usable. `npm run report:supply`
(docs/08-observability.md) — built specifically to answer "is this source
worth it" for every collector, not only Sólides — showed 10 postings
collected across both weeks and **zero** on-track in either one, the worst
yield of any active source.

**Measured further before parking anything**, the same discipline B14
applied to Catho before parking that source: probed five tech-specific
terms (`estágio ti`, `estágio tecnologia`, `estágio desenvolvimento`,
`estágio dados`, `estágio suporte`) against the live API with `city: Rio
de Janeiro`, the same shape the nine production queries already use. Four
returned nothing. The fifth returned exactly one real, on-track, Rio-area
posting — a database/SQL Server internship — whose `createdAt` is
2026-01-13, eight months before the measurement. Decisively too old under
`maxAgeDays: 7`, not a borderline case.

A second probe, `estágio ti` with no city filter, confirmed this is not an
artifact of the Rio constraint specifically: it returned 20 real,
on-track-titled postings nationwide, proving Sólides's inventory genuinely
contains tech roles — but every one was outside the Rio metro area, and 14
of 20 were independently too old regardless of location. Two independent
axes (geography, freshness) both cut the same near-zero result; this is a
property of what Sólides actually has to offer this profile today, not a
gap in how it was queried.

### Decision

The nine queries in `config/criteria.yaml`'s `collection.queries` are
**removed**, not commented out, and `alerts.sourceFreshnessHours.solides`
is removed alongside them — the same "an unlisted source is simply not
checked" reasoning `catho` already uses, since an active freshness alert
for a source with no active queries would alert about a decision already
made.

`SolidesCollector`, `solides-schema.ts`, `solides-normalizer.ts`, and both
registry entries (`collector-registry.ts`, `normalizer-registry.ts`) are
**untouched**. This is a query-budget decision — the collector still runs
correctly, the endpoint still works, nothing here says the discovery
session that found it was wasted — not a code retirement. Re-adding the
nine queries (or new ones, measured first) is the entire reversal cost.

### Consequences

**Easy:** one config edit; every test that exercises `SolidesCollector`
directly (fixture-based, no live network call — `docs/07`) is unaffected,
since the collector itself did not change.

**What this closes:** the original ADR's own "Left honestly open" item —
the Gupy/Sólides company-overlap question — is now moot rather than
answered; there is no ongoing Sólides collection left to check overlap
against.

**Revisit trigger, recorded rather than left vague:** Sólides publishes a
`homeOffice`/remote axis this ADR's original queries never used (deferred,
not forgotten, in the removed comment block) and its own inventory clearly
contains real tech postings nationwide — if a future measurement of the
remote axis, or a expansion of the target metro area, shows real on-track
supply, re-adding queries is cheap. Until then, the measured cost (nine
requests' worth of politeness delay every collection cycle, ADR-009) buys
nothing.

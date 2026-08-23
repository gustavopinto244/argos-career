# ADR-032 — Add Catho as a source, via a real headless browser

## Status

**Parked, 2026-08-23** — accepted and built, never deployed, and now
superseded in practice by measurement. See
[Amendment 1](#amendment-1--2026-08-23-parked-on-measurement-not-on-the-block).

## Date

2026-08-17

## Context

ADR-031 investigated Catho and Sólides together and built Sólides only,
deferring Catho as "worth its own ADR once someone decides it's worth
measuring." The user asked for it directly. This ADR is that measurement and
the resulting build.

**`robots.txt`** (`www.catho.com.br`) disallows `/buscar/vagas/` — the
search/listing path — for the general `*` agent, but does **not** disallow
individual posting pages (`/vagas/<slug>/<id>/`). Those pages return a plain
`403 Forbidden` (nginx, no Cloudflare markers) to a non-browser User-Agent
and `200` to a real one — a UA-sniffing block, not a `robots.txt` rule.
ADR-020 already settled the honesty question this raises: a real headless
browser's default User-Agent is a true statement of what it is, not a
forgery, the same way `python-jobspy`'s hardcoded mobile-app impersonation
(ADR-028) is a forgery and this is not. **This collector therefore breaks no
CLAUDE.md §6 rule** — a materially different situation from Indeed's
ADR-028 exception, even though both need a headless-browser-shaped tool.

**No server-side search reaches this project.** With `/buscar/vagas/`
off-limits, there is no way to ask Catho for "internships in Rio de
Janeiro" the way Gupy's `city` parameter or Sólides's `locations` parameter
allow. The only available filter is Catho's own sitemap, which carries a
title-derived URL slug and nothing else — no city, no date that means
anything (see below).

**Measured sitemap volume, 2026-08-17:** `sitemap-index.xml` lists 5 fresh,
daily-regenerated `sitemap_vagas_N.xml` files (`sitemap2/`) totaling
**205,362 URLs nationwide**, plus a legacy `sitemap_vagas_emprego.xml`
(dated 2011, company-profile URLs, not postings — ignored) and a
`busca-vagas/sitemapN.xml.gz` set (gzipped, unfetched, content unconfirmed
— not relied on). Filtering the first fresh sitemap file's 50,000 URLs by
title keyword (`estagio`/`estagiario`/`estagiaria`, case/accent-insensitive
substring on the slug) matched 1,673 — extrapolated, **roughly 6,800
title-matched postings nationwide**. Every `<lastmod>` in that same file
was identical (`2026-08-16`) — the sitemap's generation date, not a
per-posting signal, the same "undated backlog" shape already documented for
CIEE (`docs/11-known-issues.md` B1). No date-based narrowing is possible
either.

**A real, structured extraction target exists, once a page is open.**
Individual posting pages carry standard `application/ld+json`
`schema.org/JobPosting` markup (Google for Jobs' required format, which
explains why Catho invests in it despite blocking plain HTTP clients) —
`title`, `description`, `datePosted`, `hiringOrganization.name`,
`jobLocation[].address`, `baseSalary`. **One field is not trustworthy,
found on 2 real samples fetched with a real browser:**
`jobLocation[].address.addressLocality` read `"São Paulo"` on postings
actually located in Paulínia and Santos — contradicted by each posting's
own correct postal code, and by three independent page surfaces
(`<title>`, `og:title`, meta description) that all agreed with each other
and with the real city. The page `<title>` — format
`"Vaga de Emprego de {title}, {city} /"` — is what `catho-normalizer.ts`
actually parses the city from.

## Considered options

### Do nothing further (leave Catho deferred, as ADR-031 left it)

Rejected — explicitly requested by the user, and the measurement above is
exactly what ADR-031 said this decision was waiting on.

### One long-running crawl until the nationwide backlog is exhausted

Simpler code, but ~6,800 page loads at a polite ~1.5s interval plus
Chromium page-load time is several hours in a single process — no crash
resilience, no incremental progress, and it would either block or badly
overrun this project's other scheduled work if run in-process. Rejected in
favor of bounding per run.

### Bounded per-run crawl with a persisted seen-ID state file (chosen)

`collectors/catho/collect.ts` fetches the sitemaps (plain HTTP, not
blocked), filters by title keyword, and opens up to `MAX_PAGES_PER_RUN`
(default 300) not-yet-seen postings per run with a real Chromium browser
(Playwright). A JSON state file, bind-mounted so it survives between
`--rm` runs, records every posting ID already resolved — collected or
confirmed-expired — so repeated runs drain the backlog incrementally
instead of re-walking it, and a run after the backlog is drained only sees
each day's genuinely new postings. IDs that fail transiently (timeout,
network blip) are deliberately **not** marked seen, so they retry on the
next run rather than being silently dropped.

Scheduled every 30 minutes (`argos-catho-collect.timer`) — frequent,
because unlike Indeed's twice-daily cadence (ADR-028's deliberate
conservatism for a rule-breaking exception), this collector breaks no
politeness rule and each run is cheap and bounded on its own.

### Location filtering: parse the page `<title>`, not `jobLocation.addressLocality`

Chosen, for the reason in Context: the structured field disagreed with
reality on both real samples checked, while the title-derived city agreed
with two other independent surfaces and the real postal code. A regex
(`catho-normalizer.ts`'s `TITLE_CITY_PATTERN`) parses it; anything that
doesn't match returns `unknown` rather than a guess.

## Decision

Same receiving-side shape as Indeed (ADR-027): `catho-schema.ts` (tolerant
Zod schema for the JSON-LD, plus the envelope `collect.ts` actually POSTs —
`{ id, url, pageTitle, jobPosting }`, since the normalizer needs the raw
page title alongside the JSON-LD), `catho-normalizer.ts`, registered in
`normalizer-registry.ts` only — no `CollectorPort` entry, since ingestion is
always external, the same shape as Indeed and LinkedIn.

`collectors/catho/` holds the external, host-side Playwright script,
Dockerfile (based on `mcr.microsoft.com/playwright:v1.62.1-jammy`, which
ships Chromium and its system dependencies pre-built), systemd
service+timer, and a README — directly mirroring `collectors/indeed/`'s
established structure, run the same way (`docker run --rm`, never inside
`argos-career`'s own container, POSTing to `/runs/collect/external`).

`workMode` maps `jobLocationType: "TELECOMMUTE"` (schema.org's own field for
remote postings) to `"remote"` — checked for tolerantly even though never
observed in either real sample, same discipline as every other normalizer
in this project: map what has been confirmed, `unknown` for the rest.

## Consequences

**Easy:** the receiving side costs nothing new architecturally — same
registries, same envelope-over-`/runs/collect/external` shape, same
tolerant-schema and never-throw contracts as every other source. Reversal
is deleting `catho-schema.ts`/`catho-normalizer.ts`, one registry line, and
`collectors/catho/`; nothing elsewhere depends on Catho existing.

**Hard, stated plainly:** this is the most expensive collector in the
project by a wide margin — ~6,800 real page loads for the first backlog
drain, each one a full Chromium navigation, none of it avoidable because
Catho's own search is off-limits. Most of what gets opened will not be
Rio-de-Janeiro-metro and gets discarded only after the page load already
happened — the pre-filter's location rule runs the same way it does for
every other source, just after a much more expensive fetch than Gupy or
Sólides ever pay per candidate.

**A real, unverified-until-deployed gap:** `collect.ts` has not been run
for real — no Docker or a real browser was available in this session to
exercise it end to end. What **is** verified: the TypeScript typechecks
clean against the real `playwright` package (`npx tsc` against its actual
type declarations, not assumed), and the JSON-LD shape, the redirect
behavior for an expired posting, and the title-parsing regex were each
confirmed against real Catho pages via manual browser inspection before
being encoded. The README's "first-time setup on Atlas" section, run with a
small `MAX_PAGES_PER_RUN` first, is the actual validation step — same
honest status this project already gives a just-landed source before its
first real run (`docs/10-milestones.md`'s pattern for Sólides).

**What would justify revisiting the per-run bound or the cadence:** real
numbers from the first backlog drain — how long a 300-page run actually
takes end to end (Chromium launch + navigation + extraction, not just the
1.5s pacing), and what fraction of opened pages turn out to be
Rio-de-Janeiro-metro. Both are estimates here, not measurements.

**Reversal cost:** low for the receiving side (see Easy). Higher in
practice for the deployed collector itself, only because undoing a
partially-drained backlog (the seen-IDs state file) means either keeping
stale progress or discarding it and re-walking — a cost `collectors/catho/README.md`'s
"Resetting the backlog" section names explicitly rather than leaving
implicit.

## Amendment 1 — 2026-08-23: parked on measurement, not on the block

Asked to deploy this collector, the block was re-tested rather than trusted:
still **403, 2 of 2**, and a plain `curl` with the honest User-Agent gets 403
too — so this is not the headless-fingerprint problem the pre-deploy audit
diagnosed. Catho blocks every non-interactive client on vaga pages.

Two alternatives were then measured (details and numbers in
`docs/11-known-issues.md` B14): **Google Jobs via `python-jobspy`** returned
0 rows across three query shapes while Indeed through the same image
returned 50; and a **sitemap-only** strategy — Catho's sitemaps are not
blocked — yields roughly **180 RJ-identifiable internships out of ~250,000
URLs**, single digits of them on-track, and **no description at all**, so
nothing arriving that way could reach Stage A.

**The important correction is to this ADR's own premise, and it does not
depend on the block.** This ADR accepted that Catho "has no server-side
search this project can reach, so every title-matched posting has to be
opened once to learn its real city" — and treated that as a cost worth
paying. Measured, that cost is ~8,000 page loads to surface single-digit
relevant postings. This project rejects far better ratios elsewhere:
ADR-018 dropped query terms that returned volume with zero on-track
results, and ADR-011's own city-query gap was accepted on exactly this
kind of arithmetic. The trade was never justified; the block only made an
already-bad one impossible.

Beating the block would require stealth plugins or fingerprint spoofing —
the evasion CLAUDE.md §6 forbids by name — so that option is closed by rule,
not preference.

**Parked, on the Jooble precedent (`docs/11` B4):** the code, the
checkpoint state machine (ADR-033/045) and the SSRF allowlist (ADR-044)
stay on disk, correct and tested, costing nothing while dormant. What stops
is pretending this is a source that might arrive soon. Revisit only if
Catho publishes a usable API, or if a measurement shows the RJ internship
volume there is materially larger than ~180 and reachable without evasion.

# 02 — Architecture

## Pipeline

```
Scheduler
   │
   ├─► Collect        adapters per source, never throw
   │      ▼
   │   Normalize      one shape, regardless of source
   │      ▼
   │   Dedup          fingerprint, then similarity
   │      ▼
   │   Pre-filter     deterministic, cuts 84-97% (measured, city-dependent)
   │      ▼
   │   Score          stage A + B (LLM), stage C (code)
   │      ▼
   └─► Deliver        Telegram digest
          ▼
       Feedback       Phase 2, not v1
```

Each box is a stage with a persisted boundary on either side. That is what makes
principle 2 below achievable rather than aspirational.

## The four principles

These are tie-breakers. When a design question has no obvious answer, the
principle that applies decides it, and the reasoning goes in an ADR.

### 1. A broken source does not bring down the pipeline

A collector **never** propagates an exception. It returns:

```ts
type CollectionResult = {
  source: string;
  postings: RawPosting[]; // empty on failure
  error?: CollectionError; // set on failure
  collectedAt: Date;
};
```

Gupy changing a field name must degrade that night's digest, not cancel it. The
consequence to accept: a silently empty source looks identical to a source with
no matching postings, so M8 adds an alert on a source returning zero results
across consecutive runs. Without that alert this principle hides failures instead
of surviving them.

### 2. Every stage is independently re-runnable

Running scoring over already-collected postings, without re-collecting, is a
requirement. Prompt iteration during M7 is impossible otherwise: 50 postings
re-collected on every prompt tweak is both slow and rude to the source.

This forces every stage boundary to be persisted, not held in memory, and forces
stages to be idempotent — re-running one must not duplicate rows or re-notify.

### 3. Profile and criteria are data, not code

Changing search strategy — a new blocked title, a different city, a new
competency — must not require touching the application. Profile lives in
`config/profile.yaml`, filter rules in configuration, both validated with Zod at
load time.

The consequence to accept: configuration errors become runtime errors rather than
compile errors, which is why validation must fail loudly at startup rather than
producing an empty filter that silently passes everything.

### 4. The LLM engine is a replaceable detail

Swapping which model or provider scores a posting is a configuration change
(`LLM_MODEL`), not a refactor — the reason `ScorerPort` exists at all, and why
stage C contains no LLM call. A local-model adapter (`OllamaScorer`) proved the
port's swappability during M7/M8, then was retired (ADR-016): it never
finished a real calibration pass, and `ApiScorer`'s real measured cost and
memory footprint left no case for the operational complexity of running a
model on Atlas.

## Ports

Three, all defined in the domain layer, all implemented in infrastructure:

| Port            | Contract                                                       | Adapters                                                                                                                         |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CollectorPort` | `collect(criteria): Promise<CollectionResult>` — never rejects | `GupyCollector` (M3), `JobSpyCollector` (post-M6), `LinkedInCollector` (post-M6), `N8nCollector` for long-tail sources (ADR-008) |
| `ScorerPort`    | `score(posting, profile): Promise<ScoreResult>`                | `StubScorer` (M1), `ApiScorer` (M7)                                                                                              |
| `NotifierPort`  | `notify(digest): Promise<void>`                                | `TelegramNotifier` (M6)                                                                                                          |

NestJS's DI container is what makes this cheap: a port is an injection token, an
adapter is a provider, and swapping them is a module change. That is the reason
for choosing Nest over plain Express (ADR-001).

Layering follows `atlas-manager`: `domain/` holds entities and ports with no
framework imports, `application/` holds use cases, `infrastructure/` holds
adapters, `composition/` wires them.

## Scheduling and cadence

Two independent schedules, deliberately different in frequency and in cost
(ADR-009):

**Collection runs frequently — every few hours, low volume, no LLM.** It
collects, normalizes, deduplicates and pre-filters. None of that needs a model,
so none of it is confined to a time window.

**Scoring and delivery run once nightly**, in a configured off-peak window
(default `03:00 America/Sao_Paulo`). This is the only window in which the LLM
runs and the only time the digest is delivered — **daily**, not twice a week.

Reasoning:

- Frequent, low-volume collection still looks like a person checking a job
  board rather than a burst, which is what rate limiting is designed to catch.
  Running it every few hours instead of once a day only improves this.
- A posting appearing at 9am is now discovered within a few hours and delivered
  that same night — worst case, once nightly. Under the old twice-weekly
  digest, a posting appearing right after Friday's send waited until the
  following Tuesday. **This is a strict latency improvement, not only a
  resource optimization.**
- Confining the LLM to one nightly window means the model loads once, runs one
  bounded batch, and unloads — instead of contending with `atlas-manager`,
  Nginx and the other Atlas services during hours when they are actually
  serving traffic.
- `firstSeenAt` (ADR-007 amendment) is now accurate to within the collection
  interval rather than to within a day, which matters once M10's market
  analysis reads it.

Implemented with `@nestjs/schedule`, as two independent cron jobs. Both
intervals — collection frequency and the nightly window's time and timezone —
are configuration (`docs/09-configuration.md`).

## Deduplication

Two layers, because one is not enough.

**Layer 1 — deterministic fingerprint.**

```
fingerprint = sha256(normalize(company) + normalize(title) + normalize(city))

normalize(s) = s
  |> lowercase
  |> strip accents (NFD, drop combining marks)
  |> strip punctuation
  |> collapse whitespace
```

Catches the common case: the same posting re-collected on consecutive days.
It would also catch the same posting appearing on two sources — but see
**Source topology** below for why that turns out to be rare, and when it
will stop being.

**Layer 2 — textual similarity** between postings from the same company,
within the same time window, **whose locations do not contradict each other**
(ADR-010 Amendment 1). Catches what layer 1 cannot: "Estágio em Back-end" and
"Estagiário Backend (Rio de Janeiro)" from the same company are the same job
with different fingerprints.

The location check is not decoration. Without it, a company hiring the same
role in two cities had one of the two silently discarded — 267 of 406 flagged
duplicates, measured, including a "Pessoa Desenvolvedora Backend Python" in
Rio flagged against a canonical posting that stated no city at all.

**Layer 2 runs in shadow mode (ADR-010 Amendment 3): it never excludes.**
Two more real false positives at the same threshold, found without new data
after Amendment 1's repair, showed the threshold has no calibration behind
it. A match is logged — `posting_events`, `stage: "dedup-similarity"` — for
a human to review; both postings stay active. Layer 1 (the fingerprint) is
the only dedup mechanism that excludes anything automatically. `argos
restore-duplicate <fingerprint>` reverses a flag a pre-shadow-mode run left
behind; `argos dedup --reset` clears every legacy flag at once.

A posting already seen is **never reprocessed and never re-notified** — this is
both a cost control (stage A and B are the expensive stages) and a usability
requirement (criterion 2 in `01-vision-and-scope.md`). That still holds for
layer 1 (exact fingerprint match). Layer 2 candidates are logged, not
excluded, so a genuine repost may surface a second digest entry until the
threshold is calibrated — an accepted, bounded cost, not a bug.

Reasoning and thresholds: ADR-010 and its amendments.

### Source topology — how much overlap to expect, and why

**How much two sources duplicate each other is predictable from what kind of
business they are.** Worth reasoning about before building cross-source dedup
for a pair that will never need it.

| Kind                            | How a posting gets there                                                                                                 | Overlap with other kinds                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATS** (Gupy, Sólides)         | The employer publishes on its own careers page, which the ATS powers                                                     | Low — the posting lives at the employer                                                                                                                                                                       |
| **Agency** (CIEE)               | The employer delegates hiring; candidates apply _through_ the agency                                                     | Low — a vacancy takes one route or the other, not both                                                                                                                                                        |
| **Aggregator** (Jooble, Adzuna) | Scraped or fed from other boards, including the two above                                                                | **High by construction** — its whole product is republishing                                                                                                                                                  |
| **Job board** (Catho, InfoJobs) | The employer posts directly to the board's own audience, not syndicated from elsewhere and not the employer's own domain | **Unmeasured, plausibly non-zero** — a company might run its own Gupy/Sólides careers page and separately pay to cross-post the same role on a job board for more reach, unlike the ATS-vs-agency split above |

Measured on the real corpus, 2026-08-16, with 386 distinct Gupy employers and
1,552 distinct CIEE employers: **zero** companies in common. The only name
appearing on both was `Confidencial`, which is a placeholder rather than an
employer.

**Gupy vs. Sólides is the same reasoning, not yet the same measurement.** Both
are ATSs — an employer picks one platform to power its own careers page, not
both at once — so the expectation is the same low overlap just measured for
Gupy vs. CIEE. Recorded as an expectation, not a fact: added 2026-08-17
(ADR-031), no real corpus has been collected from Sólides yet to check
company names against. Re-measure the way the Gupy/CIEE table above was, once
Sólides has run for real.

That is the expected result, not a surprise — an ATS and an agency divide the
market rather than competing for the same advert. It is recorded here because
the opposite was assumed for a while, and because it decides real work:

- **Gupy + CIEE:** cross-source dedup solves a problem that does not exist.
  Not deferred — dropped.
- **Any aggregator:** cross-source dedup becomes necessary the moment one is
  added, because republishing is what an aggregator _is_. Build it then, with
  real pairs to verify against.
- **InfoJobs (added 2026-08-23, ADR-063):** a job board, same unmeasured-but-
  plausible-overlap category as Catho — not built as a Gupy/CIEE-style
  ATS/agency pair, so the "solves a problem that does not exist" conclusion
  above does not automatically carry over. The **exact**-fingerprint dedup
  (`sha256(company + title + city)`) already catches an identical posting
  cross-posted verbatim, for every source pair, with no new code — what
  would still need building is the **fuzzy** (layer 2, Dice-similarity)
  check running cross-source rather than only within one source's own
  company group. Deferred, not built speculatively: no real InfoJobs corpus
  exists yet to measure real overlap against, and the Jooble precedent (B4)
  is the concrete warning against building a dedup layer before there is
  data to verify it works. Re-measure the way the Gupy/CIEE table above was,
  once InfoJobs has run for real.

**A warning for whoever measures this next.** The first attempt at matching
company names across sources produced 88 "similar" pairs, every one of them
false — `FARM` (the fashion brand, on Gupy) matching `FARMACIA`, `FARMACO`,
`ABEFARMA` and `BOXIFARMA` on CIEE. Substring matching on short tokens, the
same failure ADR-011 Amendments 1 and 2 document for the title rules and the
track classifier. Match company names on whole words, and exclude placeholders
before counting anything.

## Pre-filter

Deterministic rules, run **before** any LLM call and **after** dedup — dedup is
cheaper than filtering and shrinks the input to every later stage.

| Rule                      | Behavior                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Title blocklist           | `sênior`, `senior`, `pleno`, `especialista`, `coordenador`, `gerente`, `tech lead`, `III`, `IV` |
| Title requirement         | Must match `estágio` / `estagiário` / `intern` / `trainee`                                      |
| Blocked companies         | Configurable list                                                                               |
| Expired                   | Closed or past application deadline                                                             |
| Location                  | Rio de Janeiro metro, or remote — either axis `unknown` passes (ADR-011)                        |
| Minimum keyword adherence | Must hit a floor of profile keywords in the title before spending LLM budget                    |

All rules are configuration (principle 3). Rule order, the unknown-axis
leniency, and the keyword-adherence scope decision are reasoned through in
ADR-011.

### The cut is measured, not estimated — and collection strategy matters more than the filter

`npm run measure:prefilter` (`scripts/measure-prefilter-cut.ts`) runs the real
pre-filter over whatever is actually in the database. Run twice, against two
different real collection strategies, both against the live API:

| Date       | Collection strategy                      | Scanned | Cut       | Dominant rejection                       |
| ---------- | ---------------------------------------- | ------- | --------- | ---------------------------------------- |
| 2026-08-14 | `jobName=estágio`, nationwide            | 171     | **97.1%** | `location_not_allowed` (117/166)         |
| 2026-08-14 | `jobName=estágio`, `city=Rio de Janeiro` | 76      | **84.2%** | `insufficient_keyword_adherence` (49/64) |
| 2026-08-15 | 14 targeted Gupy queries (ADR-018)       | 491     | **74.5%** | `title_missing_required_term` (199/366)  |
| 2026-08-16 | Gupy + CIEE, after the dedup repair      | 2,637   | **88.2%** | `location_not_allowed` (1,971/2,327)     |

**The number is not a quality score, and chasing it down is not the goal.**
It rose again on 2026-08-16 because CIEE is swept nationwide on purpose
(ADR-021): its API honours no filter, so geography is left to the pre-filter,
and the corpus deliberately carries a national picture for M10's market
analysis. A higher cut over a much larger and better-aimed intake is a better
outcome than a lower cut over a thin one — which is why this table records the
strategy beside the percentage, and why a bare percentage from one row should
never be quoted on its own.

The first two rows are real and both replace the ~70% guess this section carried
through M0–M4 — the guess was low either way, and the gap between the two real
numbers is itself the finding worth acting on: **most of the "cut" the
pre-filter performs is location, and location can be filtered server-side
instead.** Gupy's `city` query parameter (this document's "Verified: the Gupy
response shape" section) does this for free, before a single unwanted posting
is even downloaded.

**Consequence for collection strategy (M8):** query Gupy with `city` (and
`isRemoteWork`) narrowed at the source rather than fetching nationwide and
discarding 97% of it after the fact. The pre-filter still exists and still
matters — even city-narrowed, 84% of what comes back is not tech-track — but
it should not be doing geography's job when the source can do that for free
and every discarded fetch is still a request Gupy answered for nothing.

## Scoring

Summarized here; the reasoning lives in `04-scoring-model.md` and ADR-005.

| Stage          | Runs on  | Cacheable by            | Output                                       |
| -------------- | -------- | ----------------------- | -------------------------------------------- |
| A — Extraction | LLM      | posting                 | `{text, category, weight}[]`                 |
| B — Matching   | LLM      | (posting, profile hash) | `met \| partial \| not_met` + evidence quote |
| C — Score      | **code** | —                       | number, verdict, gaps                        |

Stage C is a pure function: no I/O, no LLM, deterministic, unit-tested. The LLM
never emits the number.

## Academic period derivation

Derived at runtime from the course start date in `config/profile.yaml`. **Never
hardcoded** — a fixed period is correct for at most six months and then becomes a
silent lie that produces wrong filtering.

Count **academic semester boundaries**, not elapsed months. In the Brazilian
calendar the first semester begins around March and the second around August, so
naive month arithmetic gets March→August (5 months) wrong: it yields period 1
when it is already period 2.

```
absoluteIndex(year, month) = year * 2 + (month >= 7 ? 1 : 0)
period = absoluteIndex(today) - absoluteIndex(courseStart) + 1
```

**`month` is 1-indexed in that formula. `Date.getMonth()` is 0-indexed**, so
written against it the boundary must be `>= 6`. Getting this wrong is off by a
full semester, in the direction that makes postings look reachable when they are
not.

Worked example, using the real course start of March 2026:

| Date                | `absoluteIndex`     | Period |
| ------------------- | ------------------- | ------ |
| March 2026 (start)  | `2026×2 + 0` = 4052 | 1      |
| August 2026         | `2026×2 + 1` = 4053 | **2**  |
| March 2027 (2027.1) | `2027×2 + 0` = 4054 | **3**  |

Clamp the result to `[1, 8]` and handle dates before the start date explicitly.

Implemented in M2 with unit tests pinning both boundary cases above, since those
are exactly the values the off-by-one error would break.

**Product consequence:** postings blocked only by minimum period go into a
separate digest section — "opens for you in 2027.1" — instead of being discarded.

## Delivery

A **direct, dumb Telegram client.** No framework, no agent, no dependency on
anything else running. The digest is the product; if it does not arrive, nothing
else in this document matters.

Digest text is pt-BR (ADR-003). Sections:

1. Recommended (`apply`)
2. Worth reviewing (`review`)
3. Opens for you in `<term>` — period-blocked
4. Run summary: collected, deduped, filtered, scored, and any source that failed

Section 4 is what makes principle 1 honest: a source that failed is visible in
the digest rather than silently absent.

### Per-posting message

Each entry carries enough to decide **without opening the posting** — that is the
whole point of the under-10-minutes goal:

```
Empresa: Empresa X
Cargo: Estágio em Desenvolvimento Backend
Compatibilidade: 84% · candidatar
Local: Rio de Janeiro · Remoto
Fonte: Gupy
Requisitos: Node.js, TypeScript, PostgreSQL, Docker

Pontos fortes: TypeScript, APIs REST e PostgreSQL têm evidência no perfil.
Lacunas: Docker aparece como requisito e está pouco representado.
Currículo recomendado: Backend
Sugestão: destacar o Atlas Manager e experiências com APIs e infraestrutura.

→ <link para a vaga original>
```

Every line is derived, not written by a model:

| Line                  | Comes from                                               |
| --------------------- | -------------------------------------------------------- |
| Compatibilidade       | Stage C score and verdict                                |
| Pontos fortes         | Matches with status `met`, and their evidence            |
| Lacunas               | `criticalGaps` and `missingTerms`                        |
| Currículo recomendado | Variant overlap — a pure function (`05-domain-model.md`) |
| Sugestão              | Emphasis rules over evidence already in the profile      |

**Nothing here is generated prose.** Producing resume text, cover letters or
recruiter messages is Phase 3 and out of v1 (`01-vision-and-scope.md`). The
digest selects and ranks what already exists.

The original posting link is mandatory on every entry. A digest that cannot be
acted on immediately is a digest that gets postponed.

## Hermes boundary

ArgosCareer exposes a stable HTTP API, and later an MCP server (M9). Hermes Agent
is a **consumer, never the critical path.**

The pipeline is not implemented as a Hermes skill. That would be faster and would
destroy the project: the core would become configuration of a third-party tool,
leaving no reviewable code of its own, coupled to a v0.x project that ships every
two weeks. See `CLAUDE.md` §10.

The nightly digest works with Hermes down. That is the test of whether the
boundary is real.

## Deployment and resource budget

Atlas: mini PC, Ubuntu Server, 7.1 GB RAM, no GPU. Measured at rest: 1.0 GB used,
6.1 GB available, 4 GB swap untouched. Already running `atlas-manager`, Nginx,
cloudflared and two Docker containers.

**Budget: ~150 MB at rest, ~250 MB at peak.**

**Measured for real on Atlas, 2026-08-15 (M8):** the deployed container idles
at **29.3 MiB** — a real `docker stats` reading, not an estimate — well under
budget. A real `collect` (50 postings, run inside the deployed container, not
locally) and a real `deliver` cycle against the live corpus (`SCORER_ADAPTER=api`)
both left memory unchanged at 29.3 MiB: `ApiScorer` makes HTTP calls to
OpenRouter and holds nothing large in the process itself, so it does not carry
the load-and-unload memory swing a local model would. That deliver cycle found
0 postings past the pre-filter — a real result of the 84–97% cut, not a gap in
the measurement — so it did not exercise Stage A/B under real model traffic;
the number to revisit is peak memory on a night the corpus actually has
postings to score, once the nightly cron has run for real rather than been
triggered by hand.

| Constraint                       | Requirement                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Local model (retired)            | `OllamaScorer` and `OLLAMA_KEEP_ALIVE` are gone (ADR-016) — `ApiScorer` never loads a model into this budget at all |
| Swap is an OOM net, not headroom | Paging during inference destroys latency; a plan that relies on swap is not a plan                                  |
| P1 sources                       | Ephemeral Python container (`--rm`), prints JSON and exits — zero RAM at rest                                       |
| n8n, if adopted (ADR-008)        | **Unmeasured footprint, still** — no `N8nCollector` exists in code yet, so there is nothing to deploy or measure    |

**Docker Compose, done (M8).** `Dockerfile` (multi-stage — `better-sqlite3`
compiles its native binding from source, so the build stage needs a C++
toolchain the runtime stage does not carry) and `compose.production.yaml`
(no exposed ports — a headless batch service, nothing to reach over HTTP
until M9). `config/profile.yaml` is bind-mounted read-only, never baked into
an image layer (ADR-004); `.env` is `env_file`, not `COPY`'d.

The n8n line is the one to watch, still unmeasured — there is nothing to
measure until a source actually adopts it (ADR-008), tracked in
`docs/10-milestones.md`'s post-M6 backlog, not blocking here.

## Collector etiquette

Required of every adapter, without exception:

- `robots.txt` respected
- ~1.5 s between requests
- An **honest `User-Agent`** identifying what the client is — never forged to
  imitate a browser
- Exponential backoff on failure
- Explicit timeout on every request

A discreet collector is a collector that keeps working. A forged User-Agent is
also the thing that turns "personal automation" into "misrepresentation" if it is
ever examined.

**Non-negotiable:** no collector is ever authenticated with a personal LinkedIn
session or cookies. See `CLAUDE.md` §3.

## Verified: the Gupy response shape (M3)

Was listed below as unverified through M0–M2. `npm run fixture:gupy` captured
the real response from `https://employability-portal.gupy.io/api/v1/jobs`
on 2026-08-14 — public, JSON, no auth, exactly as hoped, confirmed rather than
assumed.

```
GET https://employability-portal.gupy.io/api/v1/jobs
  ?jobName=<free text>&city=<text>&type=<vacancy_type_*>
  &isRemoteWork=<bool>&limit=<n>&offset=<n>

200 { data: JobItem[], pagination: { total, limit, offset } }
```

`jobName`, `city`, `type` and `isRemoteWork` all filter server-side — verified
against the live endpoint, not guessed from the shape of the URL. This
matters: it means the pre-filter in M5 does not have to fetch everything and
discard most of it, because the search itself can be narrowed at the source.

`JobItem` carries `id`, `name`, `companyId`, `careerPageName` (the employer's
display name), `city`/`state`/`country`, `workplaceType`
(`remote`/`hybrid`/`on-site`), `isRemoteWork`, `type` (an open string — four
distinct values turned up in a small sample, evidence there are more, not a
closed set), `publishedDate`, `applicationDeadline`, and an optional `badges`
object present on some items and entirely absent — not null — on others.
`skills` was an empty array on every item observed; no non-empty example
exists anywhere in this project's fixtures because none has been seen.

Full schema: `src/posting/infrastructure/gupy-schema.ts`. Provenance for the
curated, committed sample: `test/fixtures/gupy-jobs.md`.

**`robots.txt` checked on both `employability-portal.gupy.io` and `gupy.io`
— neither exists (404).** Nothing to respect because nothing is declared;
recorded here rather than left as a silent gap in the polite-collector
checklist.

## Verified: the Sólides response shape (ADR-031)

Undocumented and unlisted anywhere — found by opening
`vagas.solides.com.br`'s own job-search page in a real browser and reading
the network request it makes. The page is a Next.js SPA whose HTML and
`_next/data/*.json` payload both carry no job data; `npm run fixture:solides`
captured the real response from the API underneath it on 2026-08-17.

```
GET https://apigw.solides.com.br/jobs/v3/portal-vacancies-new
  ?title=<free text>&locations=<"Cidade - UF">&take=10&page=<n>

200 { success: bool, errors: [], data: { data: JobItem[], count, totalPages, currentPage } }
```

`title` and `locations` both filter server-side — verified against the live
endpoint. `title` does **not** appear to match literally the way Gupy's
`jobName` does: `title=estagio` (no accent, no gender suffix) returned both
"Estágio" and "ESTAGIÁRIO(A)" titles in the same result set during discovery,
one sample, not measured with `npm run probe:terms` the way Gupy's term list
was (ADR-018) — `config/criteria.yaml` still lists all three literal terms
per city rather than trusting this un-measured finding.

**`take` is not configurable in practice.** Any value other than `10` was
verified to silently return `{ data: { count: 0, data: [] } }` — no error,
no clamp, no page-size hint anywhere in the response. `SolidesCollector`
hardcodes it.

`JobItem` carries `id`, `title`, `companyName`, `description` (raw HTML, seen
ranging from under 100 to several thousand characters — and, once, polluted
with what looked like an accidentally-pasted ChatGPT conversation page, a
real data-quality fact about this source, not a fixture concern),
`city`/`state` (nested objects, not bare strings), `homeOffice` (boolean),
`jobType` (an open string — only `"presencial"` observed across every sample
pulled during discovery, city-scoped and ~80 nationwide), `createdAt` (a bare
date, no time), and `redirectLink` (the real application URL).

Full schema: `src/posting/infrastructure/solides-schema.ts`. Provenance for
the curated, committed sample: `test/fixtures/solides-jobs.md`.

**`robots.txt` checked on `apigw.solides.com.br` — returns 403
`{"message":"Forbidden"}`, the generic AWS API Gateway response for an
undefined route, not a robots-specific block: this host serves only the one
JSON endpoint above, nothing to crawl and nothing declared.** Separately,
`vagas.solides.com.br` (the page the API sits behind, never queried by this
collector) has an open `robots.txt` (`Allow: /`).

## Verified: the Catho posting shape (ADR-032)

No public API — `catho.com.br`'s `robots.txt` disallows only its search
path (`/buscar/vagas/`); individual posting pages
(`/vagas/<slug>/<id>/`) are not disallowed but return a plain `403` to a
non-browser `User-Agent`, `200` to a real one. `collectors/catho/collect.ts`
opens each candidate with a real headless Chromium (Playwright) — an honest
User-Agent, not a forgery, since it genuinely is what it claims to be
(ADR-020, ADR-032).

Candidate discovery is sitemap-only: `sitemap-index.xml` lists 5 fresh
`sitemap2/sitemap_vagas_N.xml` files, **205,362 URLs nationwide** measured
2026-08-17, filtered by a title-keyword regex on the URL slug (no
server-side search reaches this project — that endpoint is exactly what
`robots.txt` disallows). Extrapolated from one sitemap file's real count:
**~6,800 title-matched candidates nationwide.** Every `<lastmod>` in a given
sitemap file was identical — the file's generation date, not a per-posting
signal, so no date-based narrowing is possible either (same shape as
CIEE's undated backlog, `docs/11` B1).

Once a page is open, extraction reads its `application/ld+json`
`schema.org/JobPosting` markup — `title`, `description`, `datePosted`,
`hiringOrganization.name`, `jobLocation`, `baseSalary`. **One field is
wrong, confirmed on 2 real samples:**
`jobLocation[].address.addressLocality` read `"São Paulo"` for postings
actually in Paulínia and Santos — contradicted by each posting's own
correct postal code and by three independent page surfaces (`<title>`,
`og:title`, meta description) that agreed with each other and with the
real city. `catho-normalizer.ts` parses the city from the page `<title>`
instead (`"Vaga de Emprego de {title}, {city} /"`), never from
`addressLocality`.

Full schema: `src/posting/infrastructure/catho-schema.ts`. No curated
fixture exists for Catho, unlike every other source — the payload is
captured live per run by a real browser, not a static API response a
`fixture:*` script can snapshot; the schema and normalizer were instead
fitted directly against real pages inspected manually during discovery
(2 samples), recorded in ADR-032.

## Verified: the InfoJobs response shape (ADR-063)

No JSON API found — `infojobs.com.br`'s listing pages are server-rendered
HTML with no embedded JSON at all. The **detail** page for each posting is
different: it carries a clean `application/ld+json` `schema.org/JobPosting`
block, a real JSON parse rather than a scrape, captured with
`npm run fixture:infojobs` on 2026-08-23.

```
GET https://www.infojobs.com.br/vagas-de-emprego-{termo}-{local}.aspx
  -> server-rendered HTML, one <div id="vacancyNNNN" data-id="NNNN"
     data-href="/vaga-de-...__NNNN.aspx"> per result, no description,
     no structured location -- id and the detail link only.

GET https://www.infojobs.com.br{detail-href}
  -> <script type="application/ld+json">{ JobPosting }</script>, carrying
     title, description (real prose with literal <br> line breaks),
     datePosted, hiringOrganization.name, jobLocation.address
     (addressLocality/addressRegion, structured), baseSalary, validThrough.
     No `id` field in this block at all -- the listing card's own
     `data-id` is what this project uses as sourceId.
```

**The location filter is a friendly-URL suffix, not a query parameter** —
`vagas-de-emprego-{termo}-{cidade-slug}.aspx`, or `-trabalho-home-
office.aspx` for remote. Found by reading the real facet links' own
`data-url` attributes, not guessed: the legacy `?palabra=&provincia=`-style
query-string form was tried first and verified to silently return the
unfiltered nationwide set regardless of the `provincia` value given.

**No working pagination was found.** Every guessed parameter (`Pagina`,
`pagina`, `page`, `Page`, both cased and querystring-appended) returned the
listing's own first-page content again, not a second page — accepted as a
documented gap (ADR-063), not solved by guessing further; `InfoJobsCollector`
is single-page-per-query as a result.

**`workMode` has no structural signal.** InfoJobs's `JobPosting` states
only a physical address, never a remote/hybrid/onsite field the way Gupy's
`workplaceType` or Indeed's `is_remote` do — a posting mentioning "Home
Office" in its own title or free-text description is not read as evidence
of anything structural (CLAUDE.md §15); `InfoJobsNormalizer` maps every
posting to `workMode: "unknown"`.

Full schema: `src/posting/infrastructure/infojobs-schema.ts`. Provenance for
the curated, committed sample: `test/fixtures/infojobs-jobs.md`.

**`robots.txt` checked on `infojobs.com.br` — allows every path this
collector queries.** Only account-area and legacy static-asset paths are
disallowed (`/static/Avisolegal.aspx` and similar); both the listing
(`/vagas-de-emprego-*.aspx`) and detail (`/vaga-de-*.aspx`) URL shapes this
collector uses are unrestricted.

## Unverified assumptions

Recorded so they are not mistaken for facts.

| Assumption                                             | Status                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| A 4B local model is accurate enough for stages A and B | **Unverified.** Decided by the M7 benchmark, not in advance |
| ~150 MB at rest fits alongside current Atlas load      | **Estimate.** Verified in M8 under real load                |

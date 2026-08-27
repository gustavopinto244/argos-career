# ADR-071 — Add NerdIn as a source; reject RemotIn and Programathor

## Status

Accepted

## Date

2026-08-27

## Context

ADR-070 closed the "add more queries to existing sources" avenue with a
measurement repeated across three sources: Sólides, InfoJobs and Gupy were
each probed against their own remote facets, and all three said the same
thing — the generic terms already exhaust a source's remote inventory. The
only real gap was Indeed, which had never searched remotely at all; that is
now shipped and delivers 3 postings the location passes could not reach.

So growing supply now requires a **new source**. Three were investigated
against the acceptance criteria ADR-063 established. Every check below is a
real request, made 2026-08-26/27 with an honest User-Agent and politeness
delays.

### RemotIn — rejected at criterion 1, nothing else measured

`www.remotin.com.br/robots.txt` disallows precisely the paths a collector
would need:

```
# TEMPORÁRIO (AdSense): desindexar páginas de vagas (conteúdo dinâmico / thin)
Disallow: /vagas$    Disallow: /vagas.php    Disallow: /vagas-
Disallow: /vaga/     Disallow: /vaga.php     Disallow: /vaga?
```

CLAUDE.md §6 requires respecting `robots.txt`, and ADR-028's Indeed
exception is scoped to that one library's path and explicitly licenses
nothing else. **The source dies here** — no volume or structure measurement
was attempted, because none of it could change the answer. Worth
re-evaluating only if that self-described "temporary" block is lifted.

### Programathor — technically sound, rejected on dead stock

It passes the structural criteria: `robots.txt` allows `/jobs`, pages are
server-rendered, the `?contract_type=Estágio` filter is genuinely honoured
(`/jobs` → 20 postings, `/jobs-city/remoto` → 15), and detail pages carry
JSON-LD with `employmentType: INTERN` and `jobLocationType: TELECOMMUTE`.

The content is the problem. Sampling 8 of the 20 internship postings:

| Published  | Valid through | Posting                             |
| ---------- | ------------- | ----------------------------------- |
| 2020-12-03 | 2021-03-03    | programador-a-php                   |
| 2024-11-05 | 2025-02-05    | desenvolvedor-a-php-e-ts            |
| 2025-01-31 | 2025-05-02    | estagio-desenvolvimento-web         |
| 2025-04-17 | 2025-07-17    | desenvolvedor-a-front-end-e-suporte |

**Every one expired** — the newest 13 months ago, the oldest five years. The
site never retires internships from the filter. `validThrough` in the past
means the pre-filter rejects on `expired` before `too_old` is even
consulted: the yield is structurally zero, not merely low. Programathor is
active for **senior** roles (ids 33xxx, recent, remote) — all of which the
`titleBlocklist` rejects. It is a board for experienced developers, and
internships there are an archive.

### NerdIn — accepted

An IT-only Brazilian board. Against the criteria:

1. **robots.txt** — `Allow: /`, disallowing only admin and candidature paths
   (`/nadm*`, `/config/`, `/vaga_candidatura.php`, `/empresa_vagas.php`,
   `/vagas_candidato.php`). Everything the collector touches is permitted,
   and by construction it cannot reach the rest (see below).
2. **Server-rendered**, no browser. Listing HTML + detail JSON-LD, the same
   shape as InfoJobs.
3. **Filters genuinely honoured**, verified by the page's own result count
   rather than assumed: `vagas-home-office.php` states "1053 vagas
   disponíveis", and with `?busca_vaga=estagi&busca=1` it states "4". The
   location field was checked the same way — `busca_vaga=analista` gives
   194, plus `busca_local=Rio de Janeiro` gives 8, plus a nonexistent city
   gives **0**, which is what proves it is applied rather than ignored.
4. **On-track > 0** — 9 live internships, published August 2026, with
   `validThrough` in September.
5. **Not an aggregator** — employers post directly, so it lands in the same
   `docs/02` job-board category as InfoJobs and does not require the
   cross-source dedup layer that stopped Jooble (B4).

And the check that rejected the three ADR-070 candidates: **overlap.** None
of the six employers behind those postings (Odonto Group, MLabs, IT Share,
CITS, Martins Business, SystemHaus) appears anywhere in the 3,811-posting
corpus.

## Considered options

### Reuse InfoJobs's collector shape (chosen)

Structurally the same source: server-rendered listing carrying ids and
links, detail page carrying a real `JobPosting`. Reusing that shape means
reusing its contract tests, its cost model and its failure modes rather than
inventing new ones.

### A browser-driven collector

Not needed and therefore not built, per ADR-020's "reach for HTTP first".

### Use the `vagas-estagio-junior.php` facet (602 postings)

Rejected on measurement. Sampled: 2 of 20 are internships, the rest junior
roles that are out of scope (CLAUDE.md §2) and rejected by `titleRequired`
anyway. Since NerdIn costs **one request per posting** at the detail step,
that facet would spend ~602 requests to discard nearly all of them.

## Decision

A sixth in-process `CollectorPort`, mirroring InfoJobs:
`nerdin-{listing-parser,schema,normalizer,collector}.ts`, registered in both
registries, with `fixture:nerdin` for discovery capture.

**One query: `busca_vaga=estagi`, `maxResults: 20`.** `estagi` is the prefix
that unions `estagio` (6) and `estagiario` (3) into 9 — and reaches one
posting `estagio` alone misses. The home-office variant is **not** added: it
returns 4 and yields the same 2 postings the site-wide query already
contains, which is the redundancy test ADR-070 used to reject three other
candidate queries. Rio de Janeiro is genuinely empty on this source, which
is a fact about the board and not a filter mistake.

**Design decisions worth naming, each forced by something measured:**

- **Pagination is `?pagina=`**, and `?page=`/`?p=` silently return page one.
  Worse, `pagina` _itself_ returns page one when the page number overruns
  the real result count — observed directly, since a 9-result search returns
  those same 9 for `pagina=2`. The collector therefore stops when a page
  contributes no unseen ids. Without that guard, a `maxResults` above one
  page's worth would re-fetch and re-detail the same postings up to the page
  cap, multiplying request volume against the source for nothing.
- **The listing path comes from a fixed allowlist**, never interpolated from
  config. That is what structurally guarantees this collector cannot
  construct a `Disallow`ed path even from a mistyped query — the robots.txt
  compliance argument is a property of the code, not of the config being
  correct.
- **`busca=1` is always sent.** It is the submit flag; without it NerdIn
  ignores the search terms entirely.
- **`sourceId` comes from the listing href's trailing id**, never from the
  JSON-LD `identifier`. The two matched on all four samples, but `identifier`
  may be a `PropertyValue` object, and `sourceId` feeds dedup — moving what
  it means later would re-collect the whole corpus as new (ADR-007).
- **`workMode` reads `jobLocationType: TELECOMMUTE`**, with the
  home-office-facet annotation kept as a fallback. Keeping both is
  deliberate: a posting served by the remote facet but missing the field
  would otherwise be judged on the employer's physical address and rejected
  on location, which is docs/11 B18 exactly. Absence maps to `unknown`, not
  `onsite` — verified asymmetric, since the three onsite samples omit the
  field entirely.
- **`addressLocality: "Home Office"` is not a city.** It maps to
  `location: unknown`, the same treatment `linkedin-alert-normalizer.ts`
  gives `"Brasil"`. A literal city there would both poison the fingerprint
  (which includes the city) and get a valid remote posting rejected on
  location.
- **`receivedCount` counts what was fetched, not what was seen.** This
  diverges from `InfoJobsCollector`, which reports every card while fetching
  only `maxResults` of them and thereby breaks AC-012's reconciliation
  identity by the truncated remainder. `CieeCollector` gets this right; this
  follows CIEE.
- **The JSON-LD extraction regex is wider than InfoJobs's**, which requires
  the tag to be exactly `<script type="application/ld+json">`. One extra
  attribute would make that match nothing — and a source returning zero
  _looks empty rather than broken_, the failure shape B13 took six days to
  notice. A parse failure also gets one retry with C0 control characters
  stripped, because a sibling board (Programathor) emits them.

## Consequences

NerdIn contributes a small, non-overlapping stream: 9 internships live,
2 passing the full pre-filter today, all national. That is the same order of
magnitude as InfoJobs, which was accepted at that size and currently
delivers 2–5. **It will not transform the digest on its own** — supply
remains the binding constraint (ADR-066: 51 on-track postings in a
3,811-posting corpus).

The cost is one request per posting at the detail step, bounded by
`maxResults: 20`. At the observed volume that is ~10 requests per cycle.

`alerts.sourceFreshnessHours` deliberately gets **no `nerdin` entry yet**.
An unlisted source is simply not checked, and with 9 postings in live stock
the real publication cadence is unknown; a window guessed now would alert on
a source behaving normally. Add it after a week of real runs.

**Not yet run in production.** Everything here is verified against real
captures and a real probe, but no scheduled cycle has collected from NerdIn
yet — the same honest status this project records for every source before
its first live run. `report:supply` is what settles whether it earns its
place; if it measures `onTrackInRegion: 0` over two weeks, the query is
parked with the measurement recorded, exactly as Sólides was.

Cross-source dedup stays deferred. NerdIn is a job board, the same category
as InfoJobs and Catho in `docs/02`'s topology table, where exact-fingerprint
dedup already catches a verbatim cross-post and the fuzzy layer is deferred
until there is a real corpus to measure overlap against. B4 is the standing
warning against building that layer speculatively.

Reversal is cheap: delete four source files, two registry lines, one query
block and one `sourceDefaultCountry` entry.

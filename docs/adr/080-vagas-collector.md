# ADR-080 — Add Vagas.com as a source, learning ADR-079's lesson up front

## Status

Accepted

## Date

2026-09-01

## Context

A source-expansion sweep on 2026-09-01, prompted by ADR-079's InfoJobs
finding (a collector that reads its source correctly and still delivers
nothing, because age is only knowable after the cost of learning it), asked
a different question of every candidate this time: does the _listing_ state
a date, or does age require a detail-page fetch to discover?

Several candidates were investigated and rejected before this one — see
[[argos-source-verdicts]] for the full table. The two structural failures
worth naming here: GitHub job boards (`backend-br/vagas`,
`frontendbr/vagas`, and siblings) have an excellent API and structurally
zero internship supply — 2 matches in 400 issues over 14 months, one a
false positive — and InHire, a real Brazilian ATS with 900+ tech companies,
whose public API returns `Missing Authentication Token` on every job
endpoint with no aggregated board to collect from instead.

Vagas.com passed every ADR-063 criterion and one this project had not
needed before:

- `robots.txt`: `User-agent: * → Allow: /`, disallowing only `/api/`,
  `/v1/`, `/auth/` — HTML only, matching every other source here.
- Server-rendered, no browser needed.
- A filter genuinely narrows: a nonsense city slug returns 0 cards, Rio de
  Janeiro 5–13 depending on facets, national 21–40.
- The detail page carries a full `application/ld+json` `JobPosting` block,
  including a stable `identifier`.
- **The listing states each card's own publication date badge** —
  "Hoje"/"Ontem"/"Há N dias"/an absolute date — verified against the real
  `datePosted` on 8 of 8 sampled postings. This is the fact ADR-079 had to
  work around for InfoJobs by querying a separate age facet; here it comes
  free on the same page already being fetched for the card's id and link.

**Free-text search on this source is unreliable for narrowing to a
technical track.** `vagas-de-estagio-desenvolvimento` returned "Estágio
Nutrição" and "Estagiário de Educação Física" in a live capture — the
search matches "estágio" and mostly ignores the rest of the term. Adding a
text term on top of the area facet did not fix it either
(`estagio-backend` returned 0; `estagio-seguranca-da-informacao` returned
unrelated titles). What actually narrows is the listing's own facets, read
from the real filter links: `a[]=24` ("Informática/T.I.") and `h[]=28`
("Estágio"). With both applied: 21 national postings, 13 in Rio, 1 fully
remote, newest "Ontem" at capture time.

**A second, genuine structural improvement over InfoJobs:** the detail page
states `jobLocationType: "TELECOMMUTE"` directly — schema.org's own value
for remote work — on a real "100% Home Office" posting, and is absent on
every on-site posting sampled. `workMode` is read from a fact the source
states about the posting itself, not inferred from which listing facet this
project's own collector queried, the workaround ADR-063 needed for
InfoJobs. (NerdIn's collector already reads this same field, ADR-071 — this
is not new to the codebase, only new to this source.)

**Overlap against the corpus was checked before writing any code**, not
merely at query-selection time the way every other source above was
checked: of 16 companies sampled from a live national listing (Bahia Asset,
BDO, SulAmérica, Kasznar Leonardos, Grupo Fleury, Embelleze, Huawei, Zydus,
HStern, S3 CACEIS, Atex do Brasil, Grupo Águas do Brasil, B3, Universidade
Veiga de Almeida, SGR, Concremat), only two already appear in the corpus
(Grupo Fleury, B3), and both for unrelated roles (psychology, sports
internships, not IT). Real net-new supply.

## Considered options

### A. Free-text search terms, mirroring InfoJobs's query shape

Rejected. Measured directly: the text term does not reliably narrow by
track on this source, and stacking it with the area facet added nothing a
plain area-facet-only query did not already return.

### B. Fetch the listing only, skip the detail page (mirroring LinkedIn's alert-email limitation, ADR-029)

Rejected. Unlike LinkedIn's inbox-only constraint, nothing here prevents
fetching the detail page — the listing carries no description at all, so
skipping it would trip `lowConfidence` permanently for a source that could
easily support real scoring.

### C. Apply the age filter as a follow-up ADR, the way InfoJobs's was

Rejected as unnecessary delay. ADR-079 exists specifically because
InfoJobs's collector shipped without knowing to ask "can I filter before
paying for the detail page" and had to be corrected after production
measurement. Vagas.com's listing states the date up front — there is no
reason to ship the expensive version first and fix it later when the cheap
version costs the same to build.

### D. Listing scrape + detail JSON-LD fetch, age-filtered from the badge on the same listing page (chosen)

Same two-request-per-posting shape ADR-063 chose for InfoJobs, with the
age filter folded in from the start rather than retrofitted.

## Decision

`VagasCollector` fetches the listing (`vagas-de-estagio{-cidade}`, area and
level facets always applied, a remote facet when `isRemoteWork` is set),
parses cards with `parseVagasListing` — which extracts `id`, the detail
link, and the card's own publication-date badge — then, for each card
whose badge resolves to within `maxAgeDays` (or whose badge is unparseable,
per the standing "absence of a date is not evidence of an old posting"
leniency), fetches the detail page and validates its `JobPosting` block
against `VagasJobSchema`.

A card excluded by the age filter is counted in
`CollectionResult.businessRejectedCount` — a valid, known record
intentionally excluded by this collector's own recency policy, the same
category CIEE's education-level filter already uses — while
`receivedCount` still reflects every card the listing actually returned,
before any filtering.

Registered in `collector-registry.ts` and `normalizer-registry.ts` as
`vagas`. `config/criteria.yaml` runs two queries, matching this project's
Rio-metro-or-remote scope (CLAUDE.md §1): Rio de Janeiro and 100% Home
Office, both `maxAgeDays: 7`.

## Consequences

**A source added without a documented cost defect to fix later.** Measured
against the live site on 2026-09-01: the Rio query costs 1 listing + 1
detail request with `maxAgeDays: 7` applied (12 of 13 cards excluded by
age, on that day), versus 1 + 13 unfiltered. No later ADR should be needed
for the reason ADR-079 was.

**`workMode` is honestly known more often than InfoJobs's.** Read directly
from `jobLocationType`, not inferred from which query facet was used —
already the same pattern NerdIn's normalizer uses (ADR-071).

**Yield is real but modest.** 13 postings in Rio, ~1 remote, at time of
writing — not a change of scale on its own. Track relevance (dev/security/
automation vs. unrelated areas within "Informática/T.I.") is left entirely
to the pre-filter's existing keyword classifier, the same as every other
source; no query-level track narrowing was attempted here because the
measurement above showed it does not work on this source's search.

**What this does not do.** No pagination beyond `maxResults` cards scanned
(same cap every paginated collector in this project uses) — unlike
InfoJobs, this source's pagination genuinely works (`?pagina=N`, verified
against a live 56-result query), so raising `maxResults` is a real lever if
more volume is ever wanted, not a dead end. Niterói/São Gonçalo city slugs
were spot-checked (1 and 0 postings respectively at capture time) but not
added as separate queries — the same "measured, deferred, not an oversight"
posture NerdIn's own Rio-only query took at launch.

**Reversal cost:** remove the two `vagas` entries from `config/criteria.yaml`
and the `vagas` line from `sourceDefaultCountry`. The collector, schema,
normalizer and both registry entries can stay in place untouched, the same
parked-not-deleted posture Sólides uses.

**Unverified:** `a[]=24`/`h[]=28`/`m[]=100%25+Home+Office` are read from
the site's real filter links on 2026-09-01 and confirmed to change the
result count; if Vagas.com renumbers its facets, this collector would
silently narrow to the wrong area rather than error — the same class of
risk ADR-079 already flags for InfoJobs's `Antiguedad` buckets.

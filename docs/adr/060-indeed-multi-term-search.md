# ADR-060 — Multiple search terms per Indeed collection run

## Status

Accepted

## Date

2026-08-23

## Context

`collectors/indeed/collect.py` issues exactly one `jobspy` search per
scheduled run — one `SEARCH_TERM`, one `LOCATION`. `README.md`'s own
"Discovery coverage gap" section (docs/audit AC-023) already named the
consequence: `trainee`/`estagiário`/`estagiária` variants, a remote-only
search, and query rotation the way Gupy/Sólides run several queries per
cycle (`criteria.yaml`) were all structurally unreachable through Indeed.

Measuring the real corpus on Atlas (2026-08-23, read-only `docker exec`
query against `argos.db`) showed Indeed is not a marginal source: with a
single term and one day of life it already supplies **18 on-track,
in-region postings** — more than Gupy's 13 despite Gupy running 14 queries
per cycle. It is currently the best yield-per-effort source in the
pipeline. A second term is the cheapest lever available to grow discovery
without adding a new source (docs/10's "one per pull request" queue).

The obvious naive approach — just add more terms — is exactly what
`docs/11-known-issues.md` B13's follow-up and ADR-018 already warn
against: a term with volume and zero on-track yield spends request budget
(and, if ingested, later Stage A/B budget) to be discarded. Every term
added here had to be measured against the *real* pre-filter/track/location
rules first, not guessed from the term's Portuguese wording.

## Considered options

### A. A second scheduled timer with a different `.env`

A second systemd unit pair, identical to the existing one except for
`SEARCH_TERM`/`LOCATION`. Rejected: `collect.py` has no internal
multi-query concept, so this would mean N units for N terms, N `docker run`
invocations, N ingest POSTs, and no dedup between terms sharing the same
underlying posting — the exact operational sprawl the README's coverage-gap
note already flagged as not worth building for a "one more source, cheaply"
collector (ADR-027/028).

### B. `SEARCH_TERMS`, one container run per cycle, one merged POST (chosen)

`collect.py` scrapes each term in `SEARCH_TERMS` (comma-separated)
sequentially within the same run, sleeping `TERM_INTERVAL_SECONDS` between
them, deduplicates rows by jobspy's own `id` across terms, and sends one
`POST /runs/collect/external` for the merged, deduplicated set. One
container, one timer, one ingest call — no new moving part on the
scheduling side.

### C. Measure candidate terms by hand against the live site before deciding

Rejected as the *only* discipline, kept as the *first* step. A manual
one-off probe cannot be re-run later when a term's real-world yield drifts
(a company's hiring season ends, a phrasing goes out of fashion) — the same
reason `npm run probe:terms` exists as a script and not a one-time
investigation for Gupy.

## Decision

**`SEARCH_TERMS`**, comma-separated, replaces `SEARCH_TERM` as the primary
configuration surface; `SEARCH_TERM` (singular) is still read as a one-term
fallback, so an existing `.env` that sets it keeps behaving exactly as
before. `resolve_search_terms()`'s precedence: `SEARCH_TERMS` →
`SEARCH_TERM` → `DEFAULT_SEARCH_TERMS`.

**A `DRY_RUN=1` mode** was added to `collect.py` first, specifically to make
option B's measurement step repeatable rather than a one-off: it runs the
same `scrape_jobs` calls, skips the ingest `POST` entirely, and writes every
term's raw rows to a mounted file. **`scripts/probe-indeed-terms.ts`**
(`npm run probe:indeed`) reads that file and applies the real
`applyPreFilter`/`classifyTrack`/`isLocationAllowed` — the same functions
`executeCollect` calls in production, not a re-implementation — reporting
rows returned, pre-filter passes, on-track count, and on-track-**and**-
in-region count per term. This mirrors `probe-query-terms.ts`'s role for
Gupy, adapted to the fact that Indeed's fetch happens in a separate Python
process this repository does not call directly.

**Measured 2026-08-23**, 50 rows/term (32 for the one that ran dry),
Rio de Janeiro, against the real corpus's criteria and profile:

| term | rows | pre-filter passes | on-track | on-track, in-region |
| --- | ---: | ---: | ---: | ---: |
| estagio ti (existing default) | 50 | 9 | 9 | 9 |
| estagio desenvolvimento | 50 | 2 | 2 | 2 |
| estagio suporte | 50 | 3 | 3 | 3 |
| estagio seguranca da informacao | 50 | 2 | 2 | 2 |
| estagio infraestrutura | 32 | 4 | 4 | 4 |
| estagio dados | 50 | 0 | 0 | 0 |
| estagio programador | 7 | 0 | 0 | 0 |

The five terms with a nonzero net were added to `DEFAULT_SEARCH_TERMS`. The
last two were measured, not guessed, and deliberately excluded — but not
dismissed as off-topic: reading the individual rows (not just the count)
showed both surfaced real on-track-by-title postings that failed on a
*different* axis than relevance —

- `estagio dados`: "ESTAGIÁRIO DE TI | DESENVOLVIMENTO" classified
  `dev`+`automation` by title but failed `location_not_allowed`
  (Nova Friburgo, outside the metro list). A `data` track (if one is added
  later) would likely change this term's yield — it is worth re-probing
  then, not re-adding blind now.
- `estagio programador`: genuine dev-track hits (BairesDev's Node.js/Java/
  React trainee postings) all failed `too_old` — these listings were
  already stale by `date_posted` on the day they were probed, a fact about
  those specific postings, not evidence the term itself is unproductive.

Both are recorded in `collect.py`'s own comment next to
`DEFAULT_SEARCH_TERMS`, following the same "deliberately not added, revisit
if X" convention `criteria.yaml`'s Gupy/track comments already use.

**A separate defect surfaced while probing, not fixed here**: 15.2% of raw
jobspy rows across the seven candidate terms arrived with `company: null`,
which `normalizeIndeedJob`'s existing `if (!job.company) return null` check
discards entirely — including postings with clearly on-track titles
("Estagiário DevOps", "Visagio Talentos - Estágio: Desenvolvedor(a)
Automação / Low-Code RJ"). This silently undercounts every term's true
yield by a roughly constant fraction; it does not appear to bias which
terms clear the bar in this measurement (the terms accepted above cleared
it with room, and the two rejected terms' zero counts were explained by
other rows, not by null-company rows). Filed as
`docs/11-known-issues.md` B16, not fixed in this ADR — it is a Indeed-wide
normalization gap, orthogonal to term selection.

## Consequences

**Easy:** no new scheduled unit, one `.env` variable renamed with a
backward-compatible fallback, no change to the ingest endpoint or
`RunLock` behavior (`truncated` is now an OR across terms, same shape the
endpoint already accepts). `DRY_RUN`/`probe:indeed` make future term
additions repeatable instead of one-off investigations.

**Harder:** one scheduled run now makes up to 5 sequential requests to
`apis.indeed.com` (`TERM_INTERVAL_SECONDS = 3` between them) instead of 1 —
still within ADR-028's accepted exception (scoped to this library and this
host, not to request volume), but worth remembering if Indeed's own
rate-limiting ever tightens; nothing here measures that risk.

**Reversal cost:** low. Deleting `DEFAULT_SEARCH_TERMS` and
`resolve_search_terms`'s list branch returns to the original one-term
behavior; `SEARCH_TERM` alone still works throughout.

**What this does not do:** close the README's remaining coverage gap
(remote-only search, per-city `LOCATION` rotation) — see the README's
updated note. Also does not fix B16 (null-company rows silently discarded).

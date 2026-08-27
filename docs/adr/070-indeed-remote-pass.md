# ADR-070 — An opt-in remote pass for Indeed, after two measured dead ends

## Status

Accepted

## Date

2026-08-26

## Context

ADR-068 established that remote work is the way to grow supply — of 3,676
active postings only 51 are on-track and in-region, and remote postings
deliver at **21.4% against onsite's 1.4%**, roughly 15×. The question this
ADR answers is _where the extra remote postings come from_.

Four candidates were considered, in ascending order of cost. **Three were
measured and rejected**, and recording that is half the value of this ADR:
the next person to have these ideas should not have to re-run them.

### Rejected on measurement: Sólides remote queries

Sólides is parked (ADR-031 Amendment 1) after two production weeks of zero
yield — but with _city_ queries. Its collector, schema, normalizer and both
registry entries are intact, and `solides-normalizer.ts:8-14` maps
`homeOffice === true → "remote"`, so remote queries looked like a
config-only win. `criteria.yaml:180-193` even says re-adding queries "is the
entire reversal cost."

Measured with the generalized probe (ADR-069), three terms, `isRemoteWork`
set: **120 postings returned, 0 passed the pre-filter.** Inspecting the rows
gave a decisive second fact: **every one came back `workMode: onsite`.** The
source does not honour the remote parameter at all — the same failure mode
ADR-063 found on InfoJobs, where the obvious query form silently returned the
unfiltered set. The content was off-area regardless: marketing,
administrativo, direito, engenharia mecânica, "MENOR APRENDIZ".

Sólides stays parked. This is now the _second_ independent measurement
saying so.

### Rejected on measurement: more InfoJobs remote terms

InfoJobs already runs two remote queries (`estagio ti`, `estagiario ti`).
Three candidate terms were probed: `estagio desenvolvimento` (11 returned, 1
on-track), `estagio suporte` (11, 0), `estagio dados` (8, 1).

The two non-zero terms looked worth adding until the overlap was checked —
the exact check ADR-063 records for its own candidate terms. Both return
**zero postings the existing terms do not already return**: the single
posting each contributes is Lojas Quero-Quero's "Estagiário de Programação",
which `estagio ti` and `estagiario ti` both already bring in. Adding them
would spend two more queries — and InfoJobs costs **two HTTP requests per
posting** — for no discovery whatsoever.

Also worth recording, since it validates what already ships: `estagiario ti`
returns a strict superset of `estagio ti` (5 passing against 2). The two
existing terms are well chosen.

### Rejected on measurement: tech-specific remote terms on Gupy

The same question, asked of Gupy's remote facet: does a narrower term reach
remote postings the three generic ones (`estágio`, `estagiário`,
`estagiária`) miss? Measured the same day:

| term                              | pass | on-track | **new** |
| --------------------------------- | ---- | -------- | ------- |
| `estágio desenvolvimento`         | 2    | 2        | **0**   |
| `estágio dados`                   | 2    | 2        | **0**   |
| `estágio backend`                 | 0    | —        | 0       |
| `estágio segurança da informação` | 0    | —        | 0       |

The precision looks excellent — 2 of 2 on-track — and is worth nothing: both
postings already arrive through the generic terms, which together return 8
unique on-track remote postings.

**Three sources, one result.** A generic term already exhausts a source's
remote inventory, because remote listings are few enough that narrowing has
nothing left to narrow. The lesson generalizes: for a remote query, check
_overlap_, not yield. A term with perfect precision can still add nothing.

### The remaining candidate: Indeed has never searched remotely

`collectors/indeed/collect.py` pins `LOCATION = "Rio de Janeiro, Brazil"` and
passes no `is_remote` anywhere. jobspy supports the parameter, and
`indeed-normalizer.ts:5-14` already reads `is_remote === true → "remote"`.

So a remote internship advertised nationally has been **unreachable through
this source regardless of which term ran** — not filtered out, never asked
for. Unlike the two dead ends above, this is a real gap rather than a
hypothesis.

## Considered options

### Widen `LOCATION` to "Brazil"

Rejected. It would return nationwide _onsite_ postings, which
`isLocationAllowed` then rejects on city — paying for results the pre-filter
is guaranteed to discard. Remote is a facet, not a place, and asking for it
as one is what `is_remote` exists for.

### Filter for remote after scraping

Rejected. Indeed's remote facet is a server-side filter; reading rows and
keeping the remote ones means paying for the whole result set to use a
fraction of it, and `results_wanted` would be consumed mostly by postings
about to be dropped.

### A second pass using Indeed's own remote facet (chosen)

Asks the source what it declares, which is the same rule ADR-063 established
for InfoJobs: read the source's own statement, never infer it from prose.

## Decision

`INCLUDE_REMOTE=1` runs a **second pass over the same `SEARCH_TERMS`** with
`is_remote=True`. `COUNTRY_INDEED` stays `"Brazil"`, so the pass is national
and lands in ADR-068's uncapped bucket.

**Off by default.** The pass doubles a run's request count — `RESULTS_WANTED`
applies per pass rather than being split — and ADR-028's robots.txt exception
is deliberately narrow. Doubling traffic against that exception is a decision
to make explicitly, not a new default inherited by every deployment.

Passes are built as an explicit `(term, is_remote, label)` list rather than a
nested loop, so the politeness gap, the per-pass failure guard and the
cross-pass dedup all keep applying uniformly. A remote pass must not get
weaker guarantees than the location one.

`label` distinguishes scopes in `per_term_rows` and `failed_terms` —
`estagio ti` and `estagio ti [remote]` are separate entries. The same term in
two scopes is two queries with two yields, and collapsing them would make
`probe:indeed`'s output unreadable and hide which scope failed.

## Consequences

Indeed can now reach remote postings at all, which it never could. What that
is worth **has not been measured against real Indeed traffic** — the
verification below used a stubbed jobspy, because measuring for real means
running the container on Atlas against the live source. The flag defaults to
off precisely so that measurement is a deliberate step: enable it with
`DRY_RUN=1`, run `probe:indeed`, and decide from the per-term numbers, the
same bar every existing term cleared.

Verified with a stubbed jobspy, which is how ADR-060's multi-term behaviour
was proven too: without the flag, exactly the previous calls are made, all
`is_remote=False`. With it, four passes over two terms, two of them remote,
four unique rows, per-scope labels intact. With the remote pass of one term
raising, that pass is named in the warning and skipped while the other three
still ingest — principle 1 holding at the pass level. End to end through the
real normalizer, a remote row produces `workMode: "remote"`, `country: "BR"`
and `national: true`.

The cost, stated plainly: **enabling this doubles the requests made against a
source this project already collects from under a knowingly-granted
exception** (ADR-028). That exception was scoped to jobspy's Indeed path, not
to a traffic volume, but doubling it silently would stretch the spirit of it.
Hence opt-in, and hence the note in `.env.example` saying to measure first.

Two dead ends are recorded above rather than merely abandoned. If remote
supply still looks thin after this, the next step is a new source (the plan's
Phase 3), not another pass at Sólides or InfoJobs — both now have real
numbers saying no.

## Amendment 1 — measured against real Indeed traffic, and enabled

**2026-08-26**, the same day. The ADR above shipped saying the remote pass
"has not been measured against real Indeed traffic" and that the default-off
was what made measuring a deliberate step. That step was taken immediately:
the image was rebuilt on Atlas and run with `DRY_RUN=1 INCLUDE_REMOTE=1`
against the live source.

**The remote pass reached 15 postings across five terms**, where the location
passes reached 229:

| pass                                       | returned | on-track, in-region |
| ------------------------------------------ | -------- | ------------------- |
| `estagio ti [remote]`                      | 5        | 3                   |
| `estagio desenvolvimento [remote]`         | 5        | 1                   |
| `estagio seguranca da informacao [remote]` | 4        | 1                   |
| `estagio suporte [remote]`                 | 1        | 0                   |
| `estagio infraestrutura [remote]`          | 0        | 0                   |

The number that decides it is the overlap check the three rejected candidates
failed. Of the on-track postings, the location passes yield 17 and the remote
passes 3 — and **all 3 are postings the location passes do not return**:

- `Node.js Trainee Developer - Remote` (BairesDev)
- `Desenvolvedor React Trainee - Trabalho Remoto` (BairesDev)
- `Estágio de TI (Desenvolvimento)` (Applus+ Brasil)

All three carry `country: "BR"`, so they land in ADR-068's uncapped national
bucket, and the first two are squarely the profile's `dev` track.

This is the first of the four candidates to survive its own overlap check.
`INCLUDE_REMOTE=1` is therefore enabled in Atlas's
`collectors/indeed/.env`. It stays off by default in the repository: the
measurement justifies it for _this_ deployment against _these_ terms, not as
a property of the collector.

One correction to the ADR body while it is fresh: `probe:indeed` iterated
`dump.terms` rather than `perTerm`'s keys, so it reported only the location
passes and showed none of the above. Fixed in the same change — a measurement
tool that silently omits the thing being measured is worse than no tool.

Worth noting against `collect.py`'s own term comments, which recorded
BairesDev's trainee postings as real dev-track hits that "all failed
too_old": under the remote facet they pass. Either the listings are fresher
here or ADR-066's still-listed rescue is carrying them — not disambiguated,
and not load-bearing for this decision.

## Amendment 2 — the flag was inert until the systemd unit forwarded it

**2026-08-26**, minutes after Amendment 1. Enabling `INCLUDE_REMOTE=1` in
Atlas's `.env` and starting the service produced
`179 unique rows across 5 pass(es) over 5 term(s)` — five passes, not ten,
and no remote pass at all.

`argos-indeed-collect.service` forwards environment into the container by
listing each name explicitly (`-e SEARCH_TERMS`, `-e LOCATION`, …). A bare
`-e NAME` forwards that variable from `EnvironmentFile`; **a name absent from
the list is silently dropped regardless of what `.env` contains.**
`INCLUDE_REMOTE` was added to `collect.py` and `.env.example` and not to the
unit, so the flag was inert.

This is the same shape as ADR-063's `CollectionQuerySchema` gap — a config
key that looks set, is accepted without complaint, and never reaches the code
that reads it. Two independent surfaces have to agree, and nothing checks
that they do.

Fixed by adding `-e INCLUDE_REMOTE` to the unit, with a comment above the
list saying that a name missing from it is ignored no matter what `.env`
says, so the next variable added has the warning in front of it.

**What made it visible was the pass count in the log line** — "5 pass(es)
over 5 term(s)" instead of "10 pass(es) … + a remote pass". That line was
added in the ADR body's own change for readability, and it is the only
reason this was caught in minutes rather than at the next quiet digest.

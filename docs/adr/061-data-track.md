# ADR-061 — A `data` track, weighted below `dev`/`security`

## Status

Accepted

## Date

2026-08-23

## Context

A diagnostic sweep of the discovery pipeline (2026-08-23, measured against
both a local snapshot and Atlas's production corpus) found that
`rejectUnknownTrack` (ADR-051) discards real, on-track data-analyst and
data-engineering postings before they ever reach Stage A — none of the
configured tracks' keyword lists recognize this vocabulary at all. Measured
against the live corpus: adding recognition for this vocabulary would
recover **+6 Gupy and +1 Indeed postings currently in-region and discarded**
(Bemobi's "Data Analytics Engineering", Flamengo's "Análise de Dados",
Visagio's "Engenheiro(a) de Dados RJ" among them).

**This conflicts, on the surface, with existing precedent.** B10 and B13's
follow-up already added narrow data-adjacent phrases — `banco de dados`,
`sql server`, `ia`, `inteligência artificial` — directly to the `dev` track
at weight 1.0, not to a separate track. Both are real, deliberate decisions,
not an inconsistency to resolve: B10/B13's additions are narrow, verifiably
software-engineering-flavored phrases ("a database internship," "an AI
posting" — both squarely within CLAUDE.md §1's back-end priority). What
this ADR adds is broader — plain data-analysis/data-engineering roles,
which CLAUDE.md §1's search profile does not name as a priority-1 target at
all. Folding those into `dev` at 1.0 would let a generic data-analyst
posting compete on equal footing with genuine backend/security postings,
which is not what the search profile asks for.

Measuring bare `dados` (the obvious keyword) against the real corpus,
whole-word, the same discipline B10 already used to evaluate and **reject**
this exact word for `dev`: **2 of 11 matches were off-track** —
"Estagiário Administrativo (Dados)" and "Pessoa Estagiária de Dados Para
Suporte e Atendimento ao Cliente" (a customer-support role). Same word,
same false-positive shape B10 already measured (5/7 off-track then,
different corpus day) — the conclusion carries over.

## Considered options

### A. Fold data-adjacent phrases into `dev` at weight 1.0

Rejected as the _general_ answer, even though it is exactly right for the
narrow phrases B10/B13 already added. A generic "Estágio em Análise de
Dados" posting is not one of CLAUDE.md §1's priority-1 targets; scoring it
identically to a genuine backend posting overstates the match.

### B. A separate `data` track, weighted like `automation` (chosen)

`trackWeights.data: 0.7` — visible, not competing on equal footing with
`dev`/`security`. Mirrors exactly how `automation` already sits one tier
below the profile's priority-1 tracks (CLAUDE.md §1). No new formula
branch — `computeTrackAlignment` and `resolveScoringTracks` (ADR-059)
already operate generically over whatever tracks are configured.

### C. Do nothing; rely on `unknownTrackCapScore`

Rejected. `unknownTrackCapScore` (ADR-025) already stops an unknown-track
posting from reaching `apply`, but it does not stop `rejectUnknownTrack`
(ADR-051) from discarding it **before** Stage A ever runs — which is
exactly the recall this ADR is trying to recover. Doing nothing leaves the
6 real postings measured above undiscovered.

## Decision

**`Track` (`scoring/domain/types.ts`) gains `"data"`; `TrackWeights` gains a
`data` field; `ProfileTrackSchema` (`profile/domain/profile.ts`) gains
`"data"` too** — required, since `criteria.tracks` is
`z.record(ProfileTrackSchema, ...)`, completeness-enforced (`criteria.ts`'s
own comment). `trackWeights.data: 0.7` in `config/criteria.yaml`.

**Keywords and the one exclusion were measured against the real production
corpus** (`docker exec`, read-only, same method B10/B13 use), not carried
over from this ADR's own first-draft guess:

| phrase                     | matches | false positives |
| -------------------------- | ------: | --------------: |
| análise de dados           |       1 |               0 |
| data analytics             |       1 |               0 |
| pessoa estagiária de dados |       2 |    1 (excluded) |
| governança de dados        |       1 |               0 |
| inteligência de dados      |       1 |               0 |

`trackExclusions.data: ["suporte e atendimento ao cliente"]` — the one
observed false positive, the same phrase-plus-exclusion shape B10's own
"banco de dados"/"sql server" entries and B8's exclusion precedent already
use.

**Deliberately not added:** bare `dados` (measured, 2/11 off-track,
matching B10's own rejection of the same word for `dev`); `engenheiro(a)
de dados` — a real, valuable pattern seen live against Gupy's API
(Visagio's RJ/SP/NE postings) but **zero occurrences in the stored corpus**
this classifier actually runs against, so there is nothing to measure a
false-positive rate against yet. Whether it is worth adding a Gupy
collection query specifically for "estágio dados" — a _supply_, not
_classification_, question — is out of this ADR's scope; every posting
measured above already reached the corpus through an existing query.

`GENERIC_SKILL_TERMS` (`evidence-provenance.ts`, ADR-057) gets `data: []`
— empty, matching `automation`'s existing empty entry, since no
`profile.yaml` competency is tagged `data` yet and there is nothing to
widen evidence admission for.

## Consequences

**Easy:** `computeTrackAlignment`, `resolveScoringTracks`, `classifyTrack`,
the market-analysis repository and both probe scripts
(`probe-query-terms.ts`, `probe-indeed-terms.ts`) already operate
generically over `Criteria["tracks"]`'s keys — none needed a code change
beyond the probe scripts' own hardcoded "on-track" track list, which now
includes `data`.

**A real, if small, migration cost:** `TrackWeights`/`trackWeights` is a
required field with no default (deliberately — a silently-missing track
weight is exactly the kind of empty-filter-that-passes-everything
`criteria.ts`'s own docs warn against), so every test fixture constructing
a full `Criteria`/`ScoringConfig`/`TrackWeights` object needed a `data`
field added. TypeScript's own compiler found every one of them.

**Reversal cost:** low. Deleting the `data` entries from `Track`/
`TrackWeights`/`ProfileTrackSchema` and `config/criteria.yaml` returns
those 7 postings to `track_unknown`, exactly where they were before this
ADR — no other part of the scoring model depends on `data` existing.

**What this does not do:** add a Gupy/Indeed collection query for
"dados"-flavored terms (a supply question, not classification — every
posting measured here already reaches the corpus today); resolve the
`engenheiro(a) de dados` gender-suffix phrase-matching gap this ADR's own
measurement surfaced (`title-match.ts`'s literal-phrase matcher inserts an
extra token for "Engenheiro(a)", breaking a plain "engenheiro de dados"
phrase — noted here, not fixed, since there is no stored-corpus posting to
measure a fix against yet).

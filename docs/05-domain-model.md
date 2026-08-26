# 05 — Domain model

This document records **boundaries and invariants**, not type definitions. The
TypeScript types in `src/**/domain/` are the schema; duplicating their fields
here would produce a second definition that drifts from the first within a month.

What belongs here is what the types cannot express: why two shapes exist instead
of one, what is guaranteed at each boundary, and what must never happen.

## The central distinction: `RawPosting` and `Posting`

These are separate types on purpose, and collapsing them would be the single
most damaging simplification available in this codebase.

**`RawPosting`** is what a source returned. Its shape belongs to the source, it
may be missing anything, and its fields are whatever Gupy or JobSpy decided to
call them. It is validated tolerantly — `.passthrough()`, optional fields —
because the alternative is a collector that throws on an unannounced field, which
principle 1 forbids.

**`Posting`** is the normalized domain entity. Every later stage — dedup,
pre-filter, scoring, delivery — consumes only this. Its shape belongs to
ArgosCareer and changes only when the domain changes, never because a source
renamed a field.

Normalization is the only place allowed to know both shapes.

### Invariants of `Posting`

| Invariant                                                  | Why                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `company`, `title`, `source`, `sourceId` are non-empty     | The fingerprint is built from company and title; an empty component silently collapses distinct postings into one |
| `fingerprint` is present and stable                        | Recomputing it must give the same value forever — it is the deduplication key and is persisted                    |
| `collectedAt` is set by the collector, not by the database | Re-running a stage must not change when a posting was found                                                       |
| `location` and `workMode` are separate fields              | They are different axes — see below                                                                               |
| `location` is a resolved place or explicitly unknown       | Guessing a city to fill the field corrupts the location filter                                                    |
| `firstSeenAt` is written once and never modified           | Re-collection must not overwrite it; the history is unrecoverable if it does (ADR-007 amendment)                  |
| Raw source payload is retained                             | Schema archaeology in M3 and beyond depends on being able to re-normalize without re-collecting (principle 2)     |

### `location` and `workMode` are different axes

Collapsing them is the second most tempting simplification here, after collapsing
`RawPosting` and `Posting`.

A posting is _both_ somewhere and some way of working: "remote, company based in
São Paulo" and "hybrid in Niterói" are two independent facts. Storing `remote` in
`location` makes the second unrepresentable, and quietly breaks the location
filter — which then rejects a remote posting from a São Paulo company that would
have been perfectly viable.

```
location  → a place, or unknown
workMode  → remote | hybrid | onsite | unknown
```

`unknown` is representable in both and is not the same as absent. A posting that
does not say is a posting that does not say; the pre-filter treats that as a
candidate for review rather than silently discarding or silently accepting it.

### `country` is a third axis, and it is about hiring, not geography

`location` says where the work happens. `country` (ADR-068) says under whose
jurisdiction the hiring falls — which is a different question, and the one that
decides whether an internship is takeable from Brazil at all.

```
location  → a place, or unknown       "where is the work"
workMode  → remote | hybrid | onsite  "does the place matter"
country   → ISO 3166-1 alpha-2, or null   "who can be hired"
```

Two rules make it usable rather than merely present:

- **Only a real two-letter code is stored.** `normalizeCountry` turns
  `"Brazil"` into `null`, not `"BR"`. Translating names would need a table
  covering `"Brasil"`, `"Brésil"` and every misspelling, and would end up
  guessing — the failure CLAUDE.md §15 exists to prevent.
- **Null is resolved by the source, not by the posting.** Every source wired
  up is a Brazilian platform and most state no country, so
  `criteria.sourceDefaultCountry` supplies it. That is a property of the
  source, the same standing `location.nationwideSources` already has. A
  posting neither states nor inherits a country counts as international —
  the conservative direction, since it then competes for a bounded budget
  rather than an unbounded one.

`country` is deliberately **not** part of the fingerprint. Identity is
company + title + city (ADR-007); adding a field would re-collect the whole
corpus as new.

### `seniority` is a field, not only a title pattern

The pre-filter blocks by title keyword, which is cheap and catches most cases.
But the title is not the requirement — "Analista de Sistemas" is sometimes an
internship, and "Estágio" sometimes demands three years of experience.

`seniority` and `experienceYears` are therefore fields on `Posting`, populated
during extraction and visible to scoring, not only to the title blocklist. The
title rule stays as the cheap first pass; the field is what the score sees.

This matters for a decision already recorded: junior and entry-level roles are
out of scope (`01-vision-and-scope.md`), and that exclusion is only trustworthy
if seniority is something the system knows rather than something it
pattern-matched on a string.

### Two timestamps, two write rules

| Field         | Written          | On re-collection   |
| ------------- | ---------------- | ------------------ |
| `firstSeenAt` | Once, on insert  | **Never modified** |
| `lastSeenAt`  | Every collection | Overwritten        |

The reasoning and the hazard are in the ADR-007 amendment. The short version:
a naive upsert makes every posting look like it was found today, silently and
irrecoverably.

### The fingerprint is a domain concept, not a database detail

```
fingerprint = sha256(normalize(company) + normalize(title) + normalize(city))
normalize  = lowercase → strip accents → strip punctuation → collapse whitespace
```

It lives in the domain layer, is a pure function, and is unit-tested
independently of persistence. Two consequences follow and both are binding:

- **The normalization function is frozen once postings are persisted.** Changing
  it changes every fingerprint, which silently re-notifies the entire history.
  A change to it is a migration, not an edit.
- **Fingerprint equality means "already seen", never "identical".** Two postings
  with the same fingerprint may differ in description, salary or deadline. The
  first one seen wins; later ones are recorded as re-sightings, not merged.

## Stage boundaries and what each guarantees

Each arrow is a persisted boundary, which is what makes principle 2 —
independent re-execution — possible rather than aspirational.

| Boundary            | Guarantee entering it                                      | Guarantee leaving it                                       |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Collect → Normalize | Nothing. Source-shaped, possibly empty, possibly an error  | —                                                          |
| Normalize → Dedup   | A valid `Posting`, or the record is rejected with a reason | Every invariant above holds                                |
| Dedup → Pre-filter  | Fingerprint computed                                       | Posting is new, or the run stops for it here               |
| Pre-filter → Score  | Posting passed every deterministic rule                    | Only postings worth LLM budget continue                    |
| Score → Deliver     | Requirements extracted and matched, or a typed failure     | A `ScoreResult`, successful or failed — never an exception |

**Rejection is always recorded with a reason.** A posting that disappears between
two stages without a recorded reason is a bug, not a filter. This is what makes
the pre-filter's cut (measured at 84-97%, city-dependent — docs/02) auditable
instead of a black hole.

## Failure is a value, in every port

All three ports express failure as data rather than as a thrown exception:

- `CollectorPort` → `CollectionResult` with `error` set and an empty list
  (`docs/02-architecture.md`, principle 1)
- `ScorerPort` → a discriminated `ScoreResult` (ADR-006)
- `NotifierPort` → follows the same convention

This is a convention with teeth: a port implementation that throws violates its
contract, and adapter tests assert that it does not — including for the ugly
cases, like a socket timeout mid-response.

The reason for the uniformity is that the pipeline is a batch: an exception
escaping any stage takes down the whole run, and the whole run is that
night's digest.

## Requirements, matches and scores

The scoring types are specified in `04-scoring-model.md` and their reasoning in
ADR-005 and ADR-006. Two invariants belong here rather than there, because they
are enforced in the domain and not in a prompt:

- **`evidence: null` forces `not_met`.** Enforced in code after parsing. A model
  returning `met` with no evidence has returned an invalid result.
- **A `Match` cannot outlive the profile it was computed against.** Matches are
  cached by `(posting, profileHash)`; editing the profile must invalidate them.
  A stale match is worse than a missing one — it is a wrong answer that looks
  computed.

## Identity, and why `sourceId` is not the identity

A posting has three identifiers and they are not interchangeable:

| Identifier    | Scope                    | Used for                                  |
| ------------- | ------------------------ | ----------------------------------------- |
| `sourceId`    | Unique within one source | Re-fetching, linking back to the original |
| `fingerprint` | Cross-source             | Deduplication — "have I seen this job?"   |
| Internal id   | Database                 | Foreign keys                              |

The same job posted to both Gupy and Indeed has **two** `sourceId` values and
**one** `fingerprint`. Using `sourceId` as the dedup key would deliver that job
twice, which fails success criterion 2 in `01-vision-and-scope.md`.

## Resume variants

The profile is the source of truth; the resume PDFs are projections of it. To
answer question 3 — "how should I present my profile for this posting?" — those
projections have to be modelled rather than left as files on a disk.

A `ResumeVariant` is a **named subset of the profile**: an identifier, the tracks
it emphasizes, and which competencies and evidence it foregrounds. It contains no
prose. It is a view over the profile, not a second copy of it.

That is the load-bearing property. A variant holding its own text would drift
from the profile, and the system would recommend a resume whose claims no longer
match the evidence the score was computed from.

Recommending a variant is therefore a pure function over data that already
exists: given the posting's matched requirements and its track, pick the variant
whose emphasized tracks and competencies overlap most. No model call, no
generated text, nothing invented.

## The corpus is not a cache

Every collected posting is retained, **including the ones the pre-filter
rejected** and the ones scored `discard`.

This is a storage decision that looks wasteful and is not. Question 2 — "what do
I need to improve?" — is answered over the whole corpus. "Which companies hire
most", "which regions have most openings", and "which technologies are most
requested" are all questions about the market, not about the shortlist, and
deleting rejected postings deletes most of the market.

Rejection is recorded with its reason (above), so a rejected posting is a data
point with an explanation rather than an absence.

## What is deliberately not modelled in v1

Recorded so their absence is a decision rather than an oversight:

- **Application state.** Nothing tracks what was applied to; that is Phase 2
  feedback and would pull the non-goal of automatic application closer.
- **Company as an entity.** Company is a normalized string. Modelling companies
  properly implies deduplicating company names, which is a harder problem than
  the one being solved.
- **Salary as a comparable number.** Stipend appears as text when the posting
  states it. Parsing Brazilian salary strings into comparable numbers is its own
  project, and the pre-filter's stipend floor is a coarse text rule until it
  proves insufficient.

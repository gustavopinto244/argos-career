# ADR-062 — Filter Gupy queries by `vacancy_type_internship`

## Status

Accepted

## Date

2026-08-23

## Context

Every Gupy query in `config/criteria.yaml` searches by job title only
(`jobName`/`city`/`isRemoteWork`). Gupy's own API also states a `type`
field — `vacancy_type_internship`, `vacancy_type_effective` (a permanent
hire), `vacancy_type_talent_pool`, `vacancy_type_apprentice` and others,
observed directly in `GupyJobSchema`'s own doc comment — and
`GupyCollector` already accepts a `type` search parameter
(`GupyCollectorCriteriaSchema`), unused until now.

`GupyCollector`'s `maxResults` defaults to 50 per query
(`DEFAULT_MAX_RESULTS`), and Gupy's own pagination returns whatever
matches the title string regardless of vacancy type. A title search alone
cannot exclude a same-titled non-internship posting, so some of that
50-slot budget is spent on rows this project throws away immediately after
downloading them.

## Considered options

### A. Leave title-only queries as they are

Rejected. Measured cost, not assumed: querying Gupy's live API with the
same six Rio/remote queries `criteria.yaml` already runs, capped at the
real production limit of 50 results each, 10 of the 158 returned rows
(6%) were `vacancy_type_effective` or `vacancy_type_talent_pool` — genuine
noise consuming cap slots for nothing.

### B. Add `type: vacancy_type_internship` to every Gupy query (chosen)

No new collector code — `GupyCollector` already supports the parameter.
One field per query, same shape every other query field already uses.

## Decision

Every Gupy query in `config/criteria.yaml` sends
`type: vacancy_type_internship`.

**Measured before shipping, at the real 50-per-query production cap**, not
assumed: comparing the six Rio/remote title queries with and without the
type filter, live against Gupy's API. Adding the filter drops 27
non-internship rows that were consuming cap slots (10 `vacancy_type_effective`,
17 `vacancy_type_talent_pool`) and **zero** rows that were genuinely
`vacancy_type_internship` — the filter is safe, it never excludes a real
internship posting. Freeing those slots let 10 postings that were
previously past position 50 — and therefore never fetched at all — fit
inside the cap. One of the ten is a real, on-track, currently-missed
posting: "Estagiário DevOps," Anbima's 2026 internship program, Rio de
Janeiro, hybrid, classifies `automation`. **This is a genuine discovery
gain, not only a bandwidth saving** — the first draft of this change
assumed zero discovery impact; measuring against the real cap (not an
uncapped comparison) corrected that.

**A real bug was found and fixed while adding this.**
`CollectionQuerySchema` (`src/prefilter/domain/criteria.ts`) had no `type`
field. A plain `z.object` silently **strips** unrecognized keys rather
than rejecting them, so a `type:` line in `criteria.yaml` parsed
successfully — `CriteriaSchema.safeParse` returned `success: true` — and
the field never reached `collector.collect(query)` at all. This is exactly
the failure mode CLAUDE.md §15 and this project's own validation discipline
exist to catch, and it slipped past because Zod's default is permissive,
not strict. Fixed by adding `type: z.string().min(1).optional()` to
`CollectionQuerySchema`, with a regression test
(`test/prefilter/domain/criteria.test.ts`) pinning that the field survives
parsing.

## Consequences

**Easy:** config-only for the query change; the schema fix is additive and
optional, so no existing `criteria.yaml` without a `type:` line is
affected.

**A real question this surfaces, not answered here:** `CollectionQuerySchema`
being a plain (non-strict) `z.object` means any _other_ field a future
query might need is silently dropped the same way until someone notices —
this was found only because the query's effect (fewer, more relevant
Gupy results) was measured directly against the live API rather than
trusted from a config diff alone. Whether `CollectionQuerySchema` should
become `.strict()` (reject unknown keys loudly) is a broader schema-design
question than this ADR's own scope, and is not decided here.

**Reversal cost:** trivial — deleting the 14 `type:` lines returns to the
previous, purely title-based query set; the schema field can stay (it is
additive and optional) or be removed with it.

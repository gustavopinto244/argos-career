# ADR-069 — Probe any registered source, and report region and origin

## Status

Accepted

## Date

2026-08-26

## Context

`npm run probe:terms` is this project's discipline for deciding a collection
query: run the term against the live source, apply the _real_ pre-filter, and
count what survives. ADR-063's query log and `criteria.yaml`'s own comments
are the output of that ritual — every term in production was either measured
this way or explicitly recorded as not measured.

It had one limitation that quietly undercut all of it: **the script was
hardcoded to Gupy.** It imported `GupyCollector` and `normalizeGupyJob`
directly, so a term could only ever be measured against one of five sources.
Every query added for CIEE, InfoJobs or Sólides was, unavoidably, a guess —
and `criteria.yaml:143-162`'s InfoJobs block is visibly a hand-run
approximation of what this script does automatically for Gupy.

Two columns were also missing, and both matter now that remote work is the
growth path (ADR-068):

- **in-region.** `probe-indeed-terms.ts:43-52` has always reported it; the
  Gupy probe never did. For a nationwide or remote query it is the column
  that separates signal from a national sweep — `docs/adr/018`'s own
  measurement split 125 passes into 77 Rio and 47 remote, which the probe
  could not have shown.
- **national.** With ADR-068 splitting the scoring budget along
  `country`, a term's worth now depends on which side of that split its
  results land.

## Considered options

### Write a second probe script per source

Rejected. `probe-indeed-terms.ts` already exists as a separate script, for a
real reason — Indeed is external and reading its `DRY_RUN` output avoids a
second undocumented path to the same source (CLAUDE.md §15). That reasoning
does not extend to in-process collectors, which all implement the same port.
Four near-identical scripts would drift.

### Generalize through the registries (chosen)

`collectorFor`/`normalizerFor` are what `executeCollect` itself dispatches
through. Going through them means the probe measures what production would
actually do, rather than a parallel implementation that can disagree with it.

## Decision

`probe:terms` takes `--source` (default `gupy`), plus `--remote`, `--city`,
`--type` and `--max`, and resolves the collector and normalizer through the
same registries the pipeline uses. It reports five columns: returned, passes,
on-track, **in-region**, **national**, and flags a truncated result.

`--type` exists because Gupy's real queries all set
`vacancy_type_internship` (ADR-062); without it the probe would measure a
different query than the one that would ship.

**An unregistered `--source` is a hard error, not a fallback to Gupy.**
Silently probing a different source than the one asked for would produce a
number that looks real and describes nothing — the failure mode this whole
script exists to prevent.

`isInRegion` reuses `normalizeTitle` rather than defining a second accent
folder, and treats remote as in-region unconditionally, matching
`isLocationAllowed` exactly.

## Consequences

A query for any in-process source can now be measured before it ships, which
is what ADR-063's own "measure before adding" checklist assumed was possible
and was not. Verified live while writing this: Gupy remote
`vacancy_type_internship` returns 22 for `estágio` of which **6 pass, 6
on-track, 6 in-region, 6 national**, and `estagiário` returns 17 of which 2;
InfoJobs remote `estagio ti` returns 5 of which 2 survive to national. Those
are real numbers from real requests, not fixtures.

The probe still makes **live requests to the real source**, so it is rate-
limited by politeness (1.5 s between terms) and should not be looped over
long term lists. It is a hand-run tool, not something CI executes —
`docs/07` already draws that line for the `fixture:*` scripts.

Two limits worth naming. `--source` covers only sources with a registered
**collector**: Indeed, Catho and LinkedIn are push-based and have normalizers
only, so they keep using `probe:indeed` or nothing. And `buildCriteria`
passes a fixed set of fields — a source that later needs a criteria field
outside `jobName`/`city`/`isRemoteWork`/`type`/`maxResults` would need it
added here as well as in `CollectionQuerySchema`, which is the same trap
ADR-063 records for the real query path.

# ADR-082 — Recover missed remote, security and infrastructure internships

## Status

Accepted

## Date

2026-10-30

## Context

A production audit found relevant vacancies rejected before delivery. The
current Gupy endpoint ignores the old `isRemoteWork=true` parameter: a live
internship query returned 1,432 nationwide rows, including onsite roles. The
same query with `workplaceType=remote` returned 23 rows, all remote. The
50-result cap therefore bounded the wrong inventory. City and internship-type
filters still worked.

The title classifier missed governance of SI, privacy/DPO and data integration.
LinkedIn's `Greater Rio de Janeiro` label failed the city allowlist. Stage B's
evidence applicability guard rejected academic quotes for `formatura` and
work-mode quotes for feminine `híbrida`. A valid model answer could therefore
be converted to `not_met` and remain cached indefinitely.

An additional collection defect prevented the configured still-listed rescue:
dated postings older than the discovery window never refreshed `lastSeenAt`,
even when their source was currently advertising them.

## Decision

- Translate remote Gupy criteria to `workplaceType=remote`. Preserve the cap.
- Add two measured Rio queries: privacy (one DPO internship) and TI (one
  infrastructure internship). Other probed terms contributed no relevant gain.
- Add narrow title vocabulary for governance of SI, privacy, DPO and data
  integration. Exclude `desenvolvimento profissional`, observed in a marketing
  false positive. Keep classification title-only; do not admit raw description
  boilerplate as a routing signal.
- Accept the exact metro label `Greater Rio de Janeiro` in the location gate.
  Leave stored city strings and fingerprints unchanged, including old rows.
- Admit `formatura` and `híbrida` in the declared-evidence vocabularies.
  Activate Stage B `b-v6`, based on production `b-v4`, with explicit graduation
  lower-bound and work-availability instructions. Preserve the rejected v5
  experiment unchanged. The version change invalidates both whole and partial
  matching caches without deleting history.
- Refresh only `lastSeenAt` on existing fingerprints when a live sighting is
  outside the discovery window. Never insert old unseen postings on this path;
  do not change first discovery time, notification, discard or application state.
  The existing 90-day rescue ceiling remains in force.
- Add Vagas.com to source-freshness monitoring at 96 hours. Its observed 403
  responses and the old Sólides API's 403 require a permitted source interface;
  do not bypass access controls or pretend those sources recovered.

## Consequences

Previously rejected vacancies can reach scoring, and dated inventory can remain
eligible while it is still advertised. Skill gaps remain gaps: Linux does not
prove Windows administration; SQL does not prove SSIS. Weekly hours and a future
graduation date do not prove an immediate start or an 18-month commitment.

Regression tests cover the public query contract, accepted and rejected metro
labels, missed and unrelated titles, real evidence shapes through Stage B, and
refreshing existing sightings without importing stale inventory. No automated
test contacts a third-party service. Live recovery measurements are operational
checks, not assertions about model quality.

Reversal: revert this change. Old prompt files and matching history remain
available; no fingerprint migration or destructive database rewrite is needed.

## Confirmed start and duration declarations

Explicit start-date availability and internship-duration commitments are
stored separately as optional `startAvailability` and
`minimumInternshipMonths` profile fields. Each has its own evidence-catalog tag
and applicability vocabulary. Omitted values emit no evidence; neither is
inferred from weekly hours or graduation. Both are already included in the
serialized profile hash, so confirming either invalidates old Stage B caches.

# ADR-081 — Add 99jobs through its public search and browser detail API

## Status

Accepted

## Date

2026-10-04

## Context

99jobs is a Brazilian early-career platform and fits the product better than a
general senior board. Discovery used an honest Argos User-Agent. Its
`robots.txt` allows the public search and vacancy paths. The search is
server-rendered, has a real internship-level facet, supports Rio city and remote
filters, and paginates through the same fragment endpoint the site UI calls.

The measured stock is weak today. Rio returned one sports internship. Remote
returned three internships; the only technical one is a development talent
pool published in 2023. The normal recency policy rejects it. The operator chose
to activate the source anyway so a future relevant posting is discovered when
it appears, accepting two low-volume searches per four-hour cycle.

Detail pages have two shapes. Legacy pages expose a complete
`schema.org/JobPosting`. Company-branded SPA portals expose only an application
shell and use 99jobs's public opportunities API with a browser-client token
embedded in their public bundle.

## Considered options

### Scrape only the search cards

Rejected. Titles are truncated and cards carry no description or publication
date, so scoring would be incomplete and old talent pools would look new.

### Support only legacy JSON-LD pages

Rejected. Current search results already contain company SPA links; silently
dropping that class would make source coverage depend on which frontend an
employer selected.

### Authenticate a candidate account

Rejected. Collection needs no personal identity. The public browser-client
token reads the vacancy detail without cookies, applications or candidate data.

### Public search plus both detail shapes

Chosen. It keeps collection HTTP-only, preserves real publication dates and
descriptions, and covers both hosting generations visible in the same result
set.

## Decision

Add `99jobs` as an in-process `CollectorPort`. Every query applies level
`Estágio`; production runs one Rio de Janeiro query and one remote query, each
capped at 20 results. Listing and detail requests use the shared bounded fetch,
1.5-second pacing, retries for transient failures and an exact 99jobs hostname
allowlist.

Identity comes from `/jobs/{id}` or `/vagas/{id}` in the listing URL, never the
JSON-LD `identifier`, which can identify the company instead. Tracking query
parameters are removed before persistence. Card modality remains authoritative
when structured detail omits it.

The public browser-client token is supplied as
`NINETYNINEJOBS_PUBLIC_API_TOKEN` from the deployment environment and is never a
candidate credential. Missing or rejected API access becomes a visible partial
source failure rather than silently dropping SPA postings.

## Consequences

The source adds at least two listing requests per collection cycle and one
detail request per returned card; SPA cards add one API detail request. Current
volume keeps this small, and `maxResults` bounds it.

No freshness alert is configured initially because there is no real publication
cadence to measure. After two weeks, `report:supply` decides whether the queries
remain active. Zero on-track yield is grounds to park the queries while keeping
the adapter, matching the Sólides precedent.

The main operational dependency is an undocumented public frontend contract.
Schema drift degrades only this source and is visible through reconciliation
counts and failed-source reporting. Reversal is the two query blocks, two
registry entries, the source files and one environment variable.

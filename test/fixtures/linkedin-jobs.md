# Provenance — `linkedin-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from a
real observation, never invented from imagination, and every one records
where it came from.

- **Source of the real shape:** a screenshot the user shared of an n8n
  workflow's extraction table, built to parse LinkedIn's own job-alert
  emails (an opt-in feature of the user's own LinkedIn account — not
  scraped, not authenticated against LinkedIn in any way; CLAUDE.md §3).
- **Captured:** 2026-08-16, from the user's real inbox via their own n8n
  instance, not through this repository's code — there is no
  `fixture:linkedin` npm script, since extraction for this source happens
  entirely outside this process (ADR-029, mirroring ADR-027's Indeed
  precedent).
- **Derived from:** the real table shown in the screenshot, not committed
  anywhere in this repository. The real rows named real companies (kept out
  of this file, see below).

## What this fixture preserves from the real observation

The one structural fact the whole normalizer exists to handle:

| Fact | Preserved as |
| --- | --- |
| `location` bundles place and work mode into one string — `"Cidade, UF (Modo)"` or `"Brasil (Modo)"` — unlike every other source's separate fields | Every item's `location` |
| A fully-remote posting states the country, not a city, before the parenthetical | Item 2, `"Brasil (Remoto)"` |
| A hybrid posting outside the target metro area still reaches this fixture — filtering that out is the pre-filter's job (`isLocationAllowed`, ADR-011 Amendment 3), not this normalizer's | Item 3, São Paulo |
| Portuguese work-mode labels appear exactly as LinkedIn renders them: `Híbrido`, `Remoto`, `Presencial` | Items 1, 2, 4 respectively |

`link` follows LinkedIn's real `/jobs/view/<id>/` URL shape; the numeric ids
here are fictional placeholders in the same digit range LinkedIn actually
uses, not real posting ids.

**Not represented, because the real n8n table did not read job description
text at all** (the reason this source exists as an email-alert extraction
rather than a scrape in the first place — see ADR-029): there is no
`description` field on this schema, and the normalizer always sets
`description: null`.

## What is fictional

Every company name, title and link here is fictional. The real screenshot
named real companies (Bemobi Wave, SulAmérica, Núclea, BuscarVagas among
them) — none of those appear anywhere in this repository's history, matching
the same discipline `indeed-jobs.md` and `gupy-jobs.md` already follow
(ADR-004).

## Update, 2026-08-23 (docs/11-known-issues.md B15)

This fixture's field names (`title`, `company`, `location`, `link`,
lowercase) were never actually confirmed against a real request — the
2026-08-16 capture above is explicitly a **screenshot** of the table, not a
raw JSON body. Three real ingest runs (2026-08-18 through 2026-08-23, 33
postings total) showed every single item being rejected by
`LinkedinAlertJobSchema`. A real row the operator pasted 2026-08-23 — for
the same "Núclea" / "Bemobi Wave" companies this fixture's own provenance
already named as appearing in the real table — is best explained by the
real JSON using **Title Case** keys (`Title`, `Company`, `Location`,
`Link`, matching the already-documented `Subject`/`ReceivedAt`/
`ExtractedAt` columns) rather than the lowercase names this fixture used.

This fixture's own lowercase shape was **not changed** — `LinkedinAlertJobSchema`
now lower-cases incoming keys before validation, so both shapes parse
identically, and this fixture stays a valid, minimal "well-formed input"
reference. The Title-Case shape itself is exercised directly in
`linkedin-alert-normalizer.test.ts`'s "B15 — the real n8n row's shape"
block, with the real posting's company name replaced by a fictional one per
the same rule as the rest of this file — the structural facts (Title-Case
keys, envelope shipped no usable `sourceId`, link ends in
`/jobs/view/<digits>/`) are real, the company/title text is not.

**Still not a confirmed raw-JSON capture** — the pasted evidence is a
rendered row, not the HTTP Request node's literal body. See B15 for what
would close this out for certain: the new content-free diagnostic metadata
on the `normalization_rejected` event (`payloadKeys`, `hasSourceId`),
readable straight from `posting_events` after the next real n8n delivery.

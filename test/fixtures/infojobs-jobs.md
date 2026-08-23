# Provenance — `infojobs-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from
a raw capture, never invented from imagination, and every one records where
it came from.

- **Pages:** InfoJobs's listing pages (`vagas-de-emprego-{termo}-{local}.aspx`)
  and each result's detail page's `application/ld+json`
  `schema.org/JobPosting` block.
- **Captured:** 2026-08-23, via `npm run fixture:infojobs`.
- **Derived from:** `test/fixtures/infojobs-listing-raw.html` and
  `infojobs-detail-jsonld-raw.json` (both gitignored, not reproducible from
  this repository — re-run the script to get a fresh capture).

## Discovery notes that shaped the schema (ADR-063)

InfoJobs has no JSON API this project could find. The **listing** page is
server-rendered HTML with no embedded JSON at all — every field this project
needs from it (`id`, the detail-page link) comes from a `data-id`/
`data-href` pair on each result card, extracted by
`infojobs-listing-parser.ts` with a scoped regex, not a general HTML parser
(a new dependency this project does not otherwise need). The **detail**
page, by contrast, carries a clean `application/ld+json` block — a real
JSON parse, not scraped.

The location filter is a friendly-URL suffix
(`vagas-de-emprego-{termo}-{cidade-slug}.aspx`), found by reading the real
facet links' own `data-url` attributes — the legacy
`?palabra=&provincia=`-style query-string form silently returns the
unfiltered nationwide set, verified live before this was corrected.

## What this fixture preserves from the real capture

| Fact | Preserved as |
| --- | --- |
| `description` carries literal `<br>` tags as line breaks, not full HTML | Every item's `description` |
| `id` and `jobUrl` are not part of the real JSON-LD block at all — this project's own collector adds them from the listing card, before this schema ever validates the object | Every item's `id`/`jobUrl` |
| A posting whose title reads "home office" in the title itself but has no structured remote/hybrid signal anywhere in the real JSON-LD — `workMode` is always `"unknown"` in this normalizer, honestly, not text-mined from the mention (`infojobs-schema.ts`'s own comment) | Item `10000002` |
| Real cities observed: Rio de Janeiro, Niterói | Items 1–3 |

## What is fictional

Every company name, title wording and posting id here is fictional — the
real capture named real companies and real candidate-facing text, kept out
of this file, matching the same discipline `indeed-jobs.md`/`gupy-jobs.md`
already follow (ADR-004). The **structural** facts above (the `<br>` tags,
the missing `id` in the real JSON-LD, the two real cities) are real,
observed facts from the 2026-08-23 capture.

# Provenance — `vagas-jobs.json`

Per `docs/07-testing-strategy.md`: curated fixtures are derived by hand from
a raw capture, never invented from imagination, and every one records where
it came from.

- **Pages:** Vagas.com's listing pages (`vagas-de-estagio{-cidade}?a[]=24&
  h[]=28`) and each result's detail page's `application/ld+json`
  `schema.org/JobPosting` block.
- **Captured:** 2026-09-01, via `npm run fixture:vagas`.
- **Derived from:** `test/fixtures/vagas-listing-raw.html` and
  `vagas-detail-jsonld-raw.json` (both gitignored, not reproducible from
  this repository — re-run the script to get a fresh capture).

## Discovery notes that shaped the schema (ADR-080)

Vagas.com has no JSON API this project could find. The **listing** page is
server-rendered HTML with no embedded JSON at all — every field this
project needs from it (`id`, the detail-page link, a publication-date
badge) comes from a `data-id-vaga`/`href`/`data-publicacao` triple on each
`<li class="vaga">` card, extracted by `vagas-listing-parser.ts` with a
scoped regex, the same choice ADR-063 made for InfoJobs and for the same
reason. The **detail** page carries a clean `application/ld+json` block — a
real JSON parse, not scraped.

Free-text search on this source is unreliable for narrowing to a technical
track — `vagas-de-estagio-desenvolvimento` returned "Estágio Nutrição" and
"Estagiário de Educação Física" in a live capture, and adding an area facet
on top of a text term did not fix it. The area facet alone
(`a[]=24`, "Informática/T.I.") plus the level facet (`h[]=28`, "Estágio")
is what actually narrows, and `VagasCollector` applies both to every query
unconditionally.

## What this fixture preserves from the real capture

| Fact                                                                                                          | Preserved as       |
| -------------------------------------------------------------------------------------------------------------- | ------------------- |
| `description` carries no markup in any real sample — plain prose, unlike InfoJobs's literal `<br>` convention | Every item's `description` |
| `id` and `jobUrl` are not part of the real JSON-LD block at all — this project's own collector adds them from the listing card | Every item's `id`/`jobUrl` |
| `jobLocationType: "TELECOMMUTE"` is a real, honest schema.org signal Vagas.com states directly on a remote posting — present, not inferred from which facet was queried (unlike InfoJobs) | Item `20000002` |
| `"Localização não informada"` is Vagas.com's own placeholder text for a posting with no stated city, observed verbatim — not a real city named that | Item `20000002` |
| `addressCountry` is the full name `"Brasil"`, not a two-letter ISO code — `normalizeCountry` returns `null` for it, covered by `sourceDefaultCountry` | Every item's `jobLocation.address.addressCountry` |
| Real cities observed: Rio de Janeiro, Niterói                                                                | Items 1, 3          |

## What is fictional

Every company name, title wording and posting id here is fictional — the
real capture named real companies and real candidate-facing text, kept out
of this file, matching the same discipline `infojobs-jobs.md`/`gupy-jobs.md`
already follow (ADR-004). The **structural** facts above (no markup in
`description`, the missing `id`/`jobUrl` in the real JSON-LD,
`jobLocationType`, the placeholder city string, the `addressCountry`
format) are real, observed facts from the 2026-09-01 capture.

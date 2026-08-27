# `nerdin-jobs.json` — provenance

**Source:** `https://www.nerdin.com.br` — listing `vagas.php?busca_vaga=estagi&busca=1`,
detail `vaga_emprego/<slug>-<id>.php`
**Captured:** 2026-08-27, with `npm run fixture:nerdin`
**Derived from:** `nerdin-listing-raw.html`, `nerdin-listing-p2-raw.html`,
`nerdin-detail-raw.html`, `nerdin-detail-jsonld-raw.json` — all gitignored
(`.gitignore` covers `test/fixtures/*-raw.*`), so this file is not
reproducible from the repository alone. That is the trade `docs/07` makes
deliberately: the raw captures carry real employer names and posting text.

Four real postings were sampled: three onsite (Macaé/RJ, Novo Hamburgo/RS,
Curitiba/PR) and one remote.

## Discovery notes that shaped the schema

- The **detail** page carries a complete `application/ld+json`
  `schema.org/JobPosting`. The listing carries only ids and links, so the
  collector makes one detail request per posting — the cost model
  `maxResults` exists to bound.
- **`jobLocationType: "TELECOMMUTE"` appears only on remote postings.** The
  three onsite samples omit the field entirely. That asymmetry is why the
  normalizer maps absence to `unknown` rather than `onsite`.
- On the remote posting, `addressLocality` is the literal string
  **`"Home Office"`** and `addressRegion` is **`"HO"`** — neither is a
  place. Treating the locality as a city would poison the fingerprint and
  get a valid remote posting rejected on location (docs/11 B18).
- **`addressCountry: "BR"`** on every sample, plus
  `applicantLocationRequirements: { "@type": "Country", "name": "BR" }` as a
  second, independent country signal. Either fills `country` (ADR-068)
  without falling back to `sourceDefaultCountry`.
- `employmentType` is an **array** (`["FULL_TIME"]`) on every real sample,
  where schema.org also permits a bare string. It says nothing about
  seniority and is captured for `rawPayload` only.
- `identifier.value` matched the listing href's id on all four samples. The
  href is still what `sourceId` comes from — `identifier` may be a
  `PropertyValue` object, and identity must not move (ADR-007).
- Every real `description` was **plain text**, 133–937 characters: no tags,
  no entities. Item 3 below is fictional in carrying HTML — see below.

## What this fixture preserves from the real capture

| Fact                                              | Preserved                        |
| ------------------------------------------------- | -------------------------------- |
| Full JSON-LD key set and nesting                  | yes, verbatim structure          |
| `jobLocationType` present only when remote        | yes (item 2 only)                |
| `"Home Office"` / `"HO"` on the remote posting    | yes, exact literals              |
| `employmentType` as an array                      | yes (items 1–2)                  |
| `employmentType` as a bare string                 | item 3, tolerance not observation |
| `addressCountry` and `applicantLocationRequirements` | yes, both, on all items       |
| `identifier` as a `PropertyValue` object          | yes                              |
| Date shape without a UTC offset                   | yes (`2026-08-24T00:00:00`)      |
| Real posting dates and validity windows           | shape yes, values shifted        |

## What is fictional

- **Every company name** (`Empresa Fictícia Um/Dois/Três`) and every `id`
  (`900000xx`, chosen well outside NerdIn's real range).
- **Titles and descriptions** are rewritten. Item 3's `description` carries
  HTML tags and an `&amp;` entity that **no real sample had** — it exists to
  exercise `cleanDescription`, and the provenance note is here so nobody
  later reads it as evidence that NerdIn emits HTML.
- Dates are plausible but not the real postings' dates.

Structural facts — key names, nesting, which fields appear on which kind of
posting, array-vs-string shapes — are real. Values are not.

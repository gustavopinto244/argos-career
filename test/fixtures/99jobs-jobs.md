# 99jobs curated fixture

Derived manually from the public filtered-search HTML, one legacy
`schema.org/JobPosting` detail page and the company-portal bundle inspected on
2026-10-04. Names, ids, URLs and descriptions are fictional.

The fixture preserves the two observed delivery shapes after collector
projection: an HTML-entity-escaped JSON-LD description with a timezone-bearing
`datePosted`, and a company SPA/API detail with no city or deadline. The raw
captures produced by `npm run fixture:99jobs` remain gitignored.

/**
 * Hits the real NerdIn listing and detail pages and records both for schema
 * discovery. A script, never run by CI, never called by a test
 * (docs/07-testing-strategy.md) — `test/fixtures/nerdin-*-raw.*` are
 * gitignored and may embed real employer names and posting content.
 *
 * NerdIn (www.nerdin.com.br) is a Brazilian IT-only job board. Discovery
 * session 2026-08-26/27 (ADR-071) established, against the live site:
 *
 * - `robots.txt` is `Allow: /` and disallows only admin/candidature paths.
 *   Everything this script touches is explicitly permitted.
 * - The listing is server-rendered HTML; each card carries
 *   `data-href="vaga_emprego/<slug>-<id>.php"`, and that trailing numeric
 *   id is the stable identity — not the JSON-LD `identifier`, which may be
 *   a `PropertyValue` object.
 * - The **detail** page carries a full `application/ld+json`
 *   `schema.org/JobPosting`, including `jobLocationType: "TELECOMMUTE"` on
 *   remote postings and `addressCountry: "BR"` — richer than InfoJobs,
 *   which had to infer work mode from which facet the query used.
 * - `busca=1` is the submit flag. Without it the search terms are ignored.
 * - Pagination is `?pagina=N`. **`?page=` and `?p=` silently return page
 *   one** — verified by comparing the first card id, and the reason the
 *   collector needs an anti-duplication guard rather than trusting the
 *   parameter.
 *
 * What this script prints is what shapes the schema: the raw ld+json script
 * tag (so the extraction regex is fitted, not guessed), the keys of the
 * first JobPosting, and the listing order with dates (so truncation at
 * `maxResults` can be justified — it is only defensible if the listing is
 * recency-ordered).
 *
 * Run: npm run fixture:nerdin
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const BASE_URL = "https://www.nerdin.com.br";
const LISTING_URL = `${BASE_URL}/vagas.php?busca_vaga=estagi&busca=1`;
const LISTING_PAGE_2_URL = `${LISTING_URL}&pagina=2`;
const OUTPUT_DIR = join(__dirname, "..", "test", "fixtures");
const REQUEST_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`NerdIn responded ${response.status} for ${url}`);
  }
  return response.text();
}

/** Detail hrefs as the cards themselves state them, deduplicated by the
 * trailing id: a card's title and its thumbnail are commonly two anchors to
 * the same posting, and counting both would double the detail-fetch cost. */
function extractCards(listingHtml: string): { id: string; href: string }[] {
  const matches = listingHtml.matchAll(
    /vaga_emprego\/[^"'#?\s]*?-(\d+)\.php/gi,
  );
  const byId = new Map<string, string>();
  for (const match of matches) {
    if (!byId.has(match[1]!)) byId.set(match[1]!, match[0]);
  }
  return [...byId].map(([id, href]) => ({ id, href }));
}

/** Deliberately wider than InfoJobs's equivalent: that one requires the tag
 * to be exactly `<script type="application/ld+json">`, so a single extra
 * attribute or a single quote yields zero results and a source that looks
 * empty rather than broken. */
function extractJsonLdBlocks(detailHtml: string): string[] {
  const matches = detailHtml.matchAll(
    /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  return [...matches].map((match) => match[1]!);
}

function findJobPosting(detailHtml: string): unknown | null {
  for (const block of extractJsonLdBlocks(detailHtml)) {
    try {
      const parsed: unknown = JSON.parse(block);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (
          item &&
          typeof item === "object" &&
          (item as { "@type"?: unknown })["@type"] === "JobPosting"
        ) {
          return item;
        }
      }
    } catch {
      // Recorded by the caller as a parse failure, not silently ignored —
      // a sibling board (Programathor) emits raw control characters inside
      // its JSON-LD, so this is a shape the collector must tolerate.
      console.log("  WARNING: a ld+json block did not parse");
    }
  }
  return null;
}

/** The dates the cards state, in listing order. If this is not descending,
 * truncating at `maxResults` permanently hides newer postings and the facet
 * queries are not shippable at that cap. */
function reportListingOrder(listingHtml: string): void {
  const cardPattern =
    /<div class="vaga-card"[^>]*data-href="vaga_emprego\/[^"]*?-(\d+)\.php"/gi;
  console.log("\nListing order (id, stated date):");
  for (const match of listingHtml.matchAll(cardPattern)) {
    const segment = listingHtml.slice(match.index, match.index + 2600);
    const text = segment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const date =
      /(H[áa] \d+ (?:dias?|semanas?|m[êe]s|meses)|Hoje|Ontem|Publicado em \d{2}\/\d{2}\/\d{4})/.exec(
        text,
      );
    console.log(`  ${match[1]}  ${date?.[1] ?? "(no date on card)"}`);
  }
}

async function main(): Promise<void> {
  console.log(`Fetching listing: ${LISTING_URL}`);
  const listingHtml = await fetchText(LISTING_URL);
  writeFileSync(
    join(OUTPUT_DIR, "nerdin-listing-raw.html"),
    listingHtml,
    "utf8",
  );
  const cards = extractCards(listingHtml);
  console.log(
    `Listing saved: ${listingHtml.length} bytes, ${cards.length} unique card(s).`,
  );
  reportListingOrder(listingHtml);

  await sleep(REQUEST_INTERVAL_MS);
  console.log(`\nFetching page 2: ${LISTING_PAGE_2_URL}`);
  const page2Html = await fetchText(LISTING_PAGE_2_URL);
  writeFileSync(
    join(OUTPUT_DIR, "nerdin-listing-p2-raw.html"),
    page2Html,
    "utf8",
  );
  const page2Cards = extractCards(page2Html);
  const sameAsPageOne =
    page2Cards.length > 0 &&
    page2Cards.map((c) => c.id).join() === cards.map((c) => c.id).join();
  console.log(
    `Page 2: ${page2Cards.length} card(s). Identical to page 1: ${sameAsPageOne}` +
      (sameAsPageOne
        ? "  <-- `pagina` is NOT being honoured; the collector's guard is what stops a duplicate storm"
        : ""),
  );

  const sample = cards.slice(0, 3);
  const details: unknown[] = [];
  for (const [index, card] of sample.entries()) {
    await sleep(REQUEST_INTERVAL_MS);
    const url = `${BASE_URL}/${card.href}`;
    console.log(`\nFetching detail (${index + 1}/${sample.length}): ${url}`);
    const detailHtml = await fetchText(url);
    if (index === 0) {
      writeFileSync(
        join(OUTPUT_DIR, "nerdin-detail-raw.html"),
        detailHtml,
        "utf8",
      );
      const tag = /<script[^>]*ld\+json[^>]*>/i.exec(detailHtml);
      console.log(`  ld+json tag, verbatim: ${tag?.[0] ?? "(none found)"}`);
    }
    const jobPosting = findJobPosting(detailHtml);
    if (jobPosting) details.push(jobPosting);
    else console.log("  WARNING: no JobPosting block found");
  }
  writeFileSync(
    join(OUTPUT_DIR, "nerdin-detail-jsonld-raw.json"),
    JSON.stringify(details, null, 2),
    "utf8",
  );

  console.log(`\n${details.length} detail JobPosting object(s) captured.`);
  if (details[0] && typeof details[0] === "object") {
    console.log("Keys of the first one:", Object.keys(details[0]));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

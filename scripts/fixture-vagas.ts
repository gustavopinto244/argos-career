/**
 * Hits the real Vagas.com listing and detail pages and records both for
 * schema discovery. A script, never run by CI, never called by a test
 * (docs/07-testing-strategy.md) — `test/fixtures/vagas-*-raw.*` are
 * gitignored and may embed recruiter names and real posting content.
 *
 * Vagas.com has no JSON API this project could find (discovery session,
 * 2026-09-01, ADR-080) — the listing page is server-rendered HTML with no
 * embedded JSON, but each **detail** page carries a clean
 * `application/ld+json` `schema.org/JobPosting` block, confirmed against
 * several real postings before this script was written.
 *
 * The listing's own facets, read from the real filter links rather than
 * guessed: `a[]=24` narrows to area "Informática/T.I." (mandatory — plain
 * text search matches "estágio" alone and returns "Estágio Nutrição",
 * "Estagiário de Educação Física"), `h[]=28` narrows to level "Estágio".
 *
 * Run: npm run fixture:vagas
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const LISTING_URL =
  "https://www.vagas.com.br/vagas-de-estagio-rio-de-janeiro?a%5B%5D=24&h%5B%5D=28&ordenar_por=mais_recentes";
const OUTPUT_DIR = join(__dirname, "..", "test", "fixtures");
const REQUEST_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`Vagas.com responded ${response.status} for ${url}`);
  }
  return response.text();
}

/** Detail-page hrefs, as the listing cards themselves state them
 * (`href="/vagas/vNNNN/..."`), not re-derived. */
function extractDetailHrefs(listingHtml: string): string[] {
  const matches = listingHtml.matchAll(/href="(\/vagas\/v\d+[^"]*)"/g);
  return [...new Set([...matches].map((m) => m[1]!))];
}

function extractJobPostingJsonLd(detailHtml: string): unknown | null {
  const blocks = detailHtml.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  );
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]!) as unknown;
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { "@type"?: unknown })["@type"] === "JobPosting"
    ) {
      return parsed;
    }
  }
  return null;
}

async function main(): Promise<void> {
  console.log(`Fetching listing: ${LISTING_URL}`);
  const listingHtml = await fetchText(LISTING_URL);
  writeFileSync(
    join(OUTPUT_DIR, "vagas-listing-raw.html"),
    listingHtml,
    "utf8",
  );

  const cardCount = (listingHtml.match(/<li class="vaga/g) ?? []).length;
  const hrefs = extractDetailHrefs(listingHtml);
  console.log(
    `Listing saved: ${listingHtml.length} bytes, ${cardCount} card(s), ` +
      `${hrefs.length} unique detail link(s).`,
  );

  const sampleHrefs = hrefs.slice(0, 3);
  const details: unknown[] = [];
  for (const [index, href] of sampleHrefs.entries()) {
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);
    const url = new URL(href, LISTING_URL).toString();
    console.log(`Fetching detail (${index + 1}/${sampleHrefs.length}): ${url}`);
    const detailHtml = await fetchText(url);
    if (index === 0) {
      writeFileSync(
        join(OUTPUT_DIR, "vagas-detail-raw.html"),
        detailHtml,
        "utf8",
      );
    }
    const jsonLd = extractJobPostingJsonLd(detailHtml);
    if (jsonLd) details.push(jsonLd);
    else
      console.log(`  WARNING: no application/ld+json JobPosting block found`);
  }
  writeFileSync(
    join(OUTPUT_DIR, "vagas-detail-jsonld-raw.json"),
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

/**
 * Hits the real InfoJobs listing and detail pages and records both for
 * schema discovery. A script, never run by CI, never called by a test
 * (docs/07-testing-strategy.md) — `test/fixtures/infojobs-*-raw.html` are
 * gitignored and may embed recruiter names and real posting content.
 *
 * InfoJobs has no JSON API this project could find (discovery session,
 * 2026-08-23, ADR-063) — the listing page is server-rendered HTML with no
 * embedded JSON, but each **detail** page carries a clean
 * `application/ld+json` `schema.org/JobPosting` block, confirmed against
 * several real postings before this script was written.
 *
 * The location filter is a friendly-URL suffix, not a query parameter —
 * `vagas-de-emprego-{termo}-{cidade}.aspx`, found by reading the real
 * facet links' `data-url` attributes rather than guessing
 * `?provincia=`/`?cidade=`-style params, both of which silently return the
 * unfiltered nationwide set.
 *
 * Run: npm run fixture:infojobs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const LISTING_URL =
  "https://www.infojobs.com.br/vagas-de-emprego-estagio+ti-rio-de-janeiro.aspx";
const OUTPUT_DIR = join(__dirname, "..", "test", "fixtures");
const REQUEST_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`InfoJobs responded ${response.status} for ${url}`);
  }
  return response.text();
}

/** Detail-page hrefs, as the listing cards themselves state them
 * (`data-href="/vaga-de-...`), not re-derived. */
function extractDetailHrefs(listingHtml: string): string[] {
  const matches = listingHtml.matchAll(/data-href="(\/vaga-de-[^"]+)"/g);
  return [...new Set([...matches].map((m) => m[1]!))];
}

function extractJobPostingJsonLd(detailHtml: string): unknown | null {
  const match =
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
      detailHtml,
    );
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as unknown;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`Fetching listing: ${LISTING_URL}`);
  const listingHtml = await fetchText(LISTING_URL);
  writeFileSync(
    join(OUTPUT_DIR, "infojobs-listing-raw.html"),
    listingHtml,
    "utf8",
  );

  const cardCount = (listingHtml.match(/js_vacancyLoad/g) ?? []).length;
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
        join(OUTPUT_DIR, "infojobs-detail-raw.html"),
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
    join(OUTPUT_DIR, "infojobs-detail-jsonld-raw.json"),
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

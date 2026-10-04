/**
 * Captures the real 99jobs public search fragments and a small detail sample
 * for schema discovery. Raw outputs are gitignored and never used by tests.
 *
 * Run: npm run fixture:99jobs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNinetyNineJobsListing } from "../src/posting/infrastructure/ninetyninejobs-listing-parser";

const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/argos-career; personal internship search bot)";
const SEARCH_URL =
  "https://www.99jobs.com/opportunities/filtered_search/search_opportunities";
const OUTPUT_DIR = join(__dirname, "..", "test", "fixtures");
const REQUEST_INTERVAL_MS = 1_500;

function query(filters: "rio" | "remote"): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("page", "1");
  url.searchParams.set("search[term]", "estágio");
  url.searchParams.append("search[opportunity_level_ids][]", "3");
  if (filters === "rio") {
    url.searchParams.set("search[state]", "20");
    url.searchParams.append("search[city][]", "Rio de Janeiro");
  } else {
    url.searchParams.append("search[acting_mode][]", "remote");
  }
  return url.toString();
}

async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`99jobs responded ${response.status} for ${url}`);
  }
  return response.text();
}

async function main(): Promise<void> {
  const allCards = [];
  for (const filter of ["rio", "remote"] as const) {
    if (allCards.length > 0)
      await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
    const html = await fetchText(query(filter));
    writeFileSync(
      join(OUTPUT_DIR, `99jobs-listing-${filter}-raw.html`),
      html,
      "utf8",
    );
    const cards = parseNinetyNineJobsListing(html);
    allCards.push(...cards);
    console.log(`${filter}: ${cards.length} card(s)`);
  }

  const seen = new Set<string>();
  let captured = 0;
  for (const card of allCards) {
    if (seen.has(card.id) || captured >= 3) continue;
    seen.add(card.id);
    await new Promise((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS));
    const url = new URL(card.href);
    url.search = "";
    const html = await fetchText(url.toString());
    writeFileSync(
      join(OUTPUT_DIR, `99jobs-detail-${card.id}-raw.html`),
      html,
      "utf8",
    );
    captured += 1;
  }

  console.log(`${captured} detail page(s) captured.`);
  console.log(
    "SPA API payloads are validated by the collector probe when " +
      "NINETYNINEJOBS_PUBLIC_API_TOKEN is configured.",
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

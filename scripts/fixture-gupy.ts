/**
 * Hits the real Gupy jobs API and records the response for schema discovery.
 * A script, never run by CI, never called by a test (docs/07-testing-strategy.md)
 * — `test/fixtures/gupy-raw.json` is gitignored and may embed recruiter
 * names and real posting content.
 *
 * Run: npm run fixture:gupy
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ENDPOINT = "https://portal.gupy.io/api/job-search/jobs";
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const OUTPUT_PATH = join(__dirname, "..", "test", "fixtures", "gupy-raw.json");

async function main(): Promise<void> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("jobName", "estágio");
  url.searchParams.set("limit", "10");

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Gupy responded ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  writeFileSync(OUTPUT_PATH, JSON.stringify(body, null, 2), "utf8");

  const data = (body as { data?: unknown[] }).data ?? [];
  const first = data[0];
  console.log(`Wrote ${data.length} postings to ${OUTPUT_PATH}`);
  console.log(
    "First item keys:",
    first && typeof first === "object" ? Object.keys(first).sort() : first,
  );
}

void main();

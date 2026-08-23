/**
 * Measures what a candidate `collection.queries` term is actually worth,
 * against the live source — the same discipline `measure:prefilter` applies
 * to the pre-filter, applied one step earlier to the query itself.
 *
 *   npm run probe:terms -- "estágio backend" "estágio dados"
 *
 * Reports, per term: postings the source returned, how many survive the
 * pre-filter, and how many classify onto a real track (dev/security/
 * automation) rather than `unknown`. The last column is the one that
 * matters: a term that returns 50 postings and zero on-track ones is a term
 * that spends Stage A budget to be discarded (ADR-018).
 *
 * Read-only — collects and measures, never writes to the database.
 */
import { GupyCollector } from "../src/posting/infrastructure/gupy-collector";
import { normalizeGupyJob } from "../src/posting/infrastructure/gupy-normalizer";
import { classifyTrack } from "../src/prefilter/domain/classify-track";
import { applyPreFilter } from "../src/prefilter/domain/pre-filter";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";

const TERM_INTERVAL_MS = 1_500;

async function main(): Promise<void> {
  const terms = process.argv.slice(2);
  if (terms.length === 0) {
    console.error('Usage: npm run probe:terms -- "<term>" ["<term>" …]');
    process.exitCode = 1;
    return;
  }

  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );
  const profileKeywords = profile.competencies.flatMap((c) => [
    c.name,
    ...c.aliases,
  ]);
  const now = new Date();
  const collector = new GupyCollector();

  console.log(
    "term".padEnd(34) +
      "returned".padStart(9) +
      "passes".padStart(8) +
      "on-track".padStart(10),
  );

  for (const [index, jobName] of terms.entries()) {
    // Politeness between terms, same reason executeCollect spaces out
    // queries (CLAUDE.md §6).
    if (index > 0) await new Promise((r) => setTimeout(r, TERM_INTERVAL_MS));

    const result = await collector.collect({ jobName, maxResults: 50 });
    if (result.error) {
      console.log(jobName.padEnd(34) + "  ERROR " + result.error.message);
      continue;
    }

    const postings = result.postings
      .map((raw) => normalizeGupyJob(raw, now))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const passes = postings.filter(
      (p) => applyPreFilter(p, criteria, profileKeywords, now).passed,
    );
    const onTrack = passes.filter((p) =>
      classifyTrack(p.title, criteria.tracks, criteria.trackExclusions).some(
        (t) =>
          t === "dev" || t === "security" || t === "automation" || t === "data",
      ),
    );

    console.log(
      jobName.padEnd(34) +
        String(result.postings.length).padStart(9) +
        String(passes.length).padStart(8) +
        String(onTrack.length).padStart(10),
    );
  }
}

void main();

/**
 * Measures what a candidate Indeed `SEARCH_TERMS` entry is actually worth,
 * against a *real* scrape — the same "measure before adding" discipline
 * `probe-query-terms.ts` applies to Gupy queries (ADR-018), applied here to
 * `collectors/indeed/collect.py`'s search term instead.
 *
 * This script does not talk to Indeed itself — `python-jobspy` runs inside
 * the collector's own container, not this Node process, and CLAUDE.md §15
 * forbids inventing a second, undocumented path to the same source. Instead
 * it reads the JSON file `collect.py --dry-run` writes (rows per term, never
 * POSTed anywhere), the same file the operator produces with:
 *
 *   docker run --rm -e DRY_RUN=1 \
 *     -e "SEARCH_TERMS=estagio ti,estagio dados,..." \
 *     -v "$PWD/dry-run-output:/app/output" \
 *     argos-indeed-collector:local
 *
 *   npm run probe:indeed -- ./dry-run-output/dry-run.json
 *
 * Reports, per term: rows jobspy returned, how many survive the real
 * pre-filter, how many classify onto a real track, and — the column that
 * actually decided every term already in `criteria.yaml`'s own comments —
 * how many are *also* in the target metro area or remote. A term that
 * returns volume and zero on-track, in-region postings spends a scheduled
 * run's request budget to be discarded.
 *
 * Read-only — reads the dump, never writes to the database, never makes a
 * network call.
 */
import { readFileSync } from "node:fs";
import { normalizeIndeedJob } from "../src/posting/infrastructure/indeed-normalizer";
import { applyPreFilter } from "../src/prefilter/domain/pre-filter";
import { classifyTrack } from "../src/prefilter/domain/classify-track";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";
import { normalize } from "../src/posting/domain/fingerprint";

interface DryRunDump {
  readonly terms: readonly string[];
  readonly perTerm: Record<string, readonly Record<string, unknown>[]>;
}

function isInRegion(
  posting: ReturnType<typeof normalizeIndeedJob>,
  criteria: ReturnType<typeof loadCriteria>,
): boolean {
  if (!posting) return false;
  if (posting.workMode === "remote") return true;
  if (posting.location.kind !== "known") return false;
  const city = normalize(posting.location.city);
  return criteria.location.cities.some((c) => normalize(c) === city);
}

async function main(): Promise<void> {
  const dumpPath = process.argv[2];
  if (!dumpPath) {
    console.error(
      "Usage: npm run probe:indeed -- <path to collect.py's --dry-run JSON>",
    );
    process.exitCode = 1;
    return;
  }

  const dump = JSON.parse(readFileSync(dumpPath, "utf-8")) as DryRunDump;
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

  console.log(
    "term".padEnd(34) +
      "returned".padStart(9) +
      "passes".padStart(8) +
      "on-track".padStart(10) +
      "in-region".padStart(11),
  );

  // Iterate `perTerm`'s own keys, not `terms` (ADR-070). With
  // `INCLUDE_REMOTE=1` the collector runs a second pass per term and records
  // it under a `"<term> [remote]"` label, so reading `terms` would silently
  // report only the location passes — hiding exactly the rows the remote
  // pass was enabled to measure. `terms` remains the list of search terms;
  // `perTerm` is the list of passes, and passes are what this measures.
  for (const term of Object.keys(dump.perTerm)) {
    const rows = dump.perTerm[term] ?? [];
    const postings = rows
      .map((row) =>
        normalizeIndeedJob(
          { source: "indeed", sourceId: String(row.id ?? ""), payload: row },
          now,
        ),
      )
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
    const inRegion = onTrack.filter((p) => isInRegion(p, criteria));

    console.log(
      term.padEnd(34) +
        String(rows.length).padStart(9) +
        String(passes.length).padStart(8) +
        String(onTrack.length).padStart(10) +
        String(inRegion.length).padStart(11),
    );
  }
}

void main();

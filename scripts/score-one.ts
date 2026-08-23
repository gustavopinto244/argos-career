/**
 * Score ONE posting through the real production path — `buildScorer` →
 * `ApiScorer` → Stage A/B → `computeScore` — and print what every layer
 * actually decided, per requirement.
 *
 * Exists because verifying a scoring change end to end was, until this
 * script, disproportionately hard: `run-calibration.ts` scores the whole
 * worksheet (~25 min, real spend) to answer a question about one posting,
 * and its aggregate output hides which requirement moved.
 *
 * `--cold` is the important flag, and the reason this script has a doc
 * comment this long. Stage B has TWO caches, and the non-obvious one is
 * read first:
 *
 *   matches          whole-posting result (ADR-007)
 *   partial_matches  per-requirement answers (ADR-049's resumability)
 *
 * `StageBMatcher.askOne` consults `partial_matches` before doing anything
 * else, and a saved answer whose `evidence` is null is reused with no
 * revalidation at all. Clearing only `matches` therefore *looks* like a
 * cold run — `stageBCacheHit: false`, a freshly written row — while making
 * zero model calls and reproducing the old answer exactly. That cost a real
 * investigation (docs/11-known-issues.md B12); `--cold` clears both.
 *
 * Run:
 *   npm run score:one -- <fingerprint>
 *   npm run score:one -- <fingerprint> --cold
 */
import Database from "better-sqlite3";
import { parseArgs } from "node:util";
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";
import { PostingsRepository } from "../src/persistence/infrastructure/postings-repository";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";
import { hashProfile } from "../src/profile/domain/profile-hash";
import { buildScorer } from "../src/scoring/infrastructure/build-scorer";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { cold: { type: "boolean", default: false } },
  });
  const fingerprint = positionals[0];
  if (!fingerprint) {
    console.error("Usage: npm run score:one -- <fingerprint> [--cold]");
    process.exitCode = 1;
    return;
  }

  const dbPath = process.env.DATABASE_PATH ?? "./data/argos.db";

  if (values.cold) {
    const raw = new Database(dbPath);
    const whole = raw
      .prepare("DELETE FROM matches WHERE fingerprint=?")
      .run(fingerprint);
    const perRequirement = raw
      .prepare("DELETE FROM partial_matches WHERE fingerprint=?")
      .run(fingerprint);
    raw.close();
    console.log(
      `--cold: cleared ${whole.changes} matches + ${perRequirement.changes} partial_matches row(s).`,
    );
    console.log(
      "Stage A's extraction is deliberately left cached — clearing it too would\n" +
        "change two variables at once (docs/04's calibration protocol).\n",
    );
  }

  const db = createDatabase(dbPath);
  runMigrations(db);
  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );

  console.log(
    `config: adapter=${process.env.SCORER_ADAPTER} model=${process.env.LLM_MODEL} ` +
      `ignoredProviders=${JSON.stringify(criteria.scoring.ignoredProviders)}`,
  );

  const built = buildScorer(db, criteria, profile);
  if (!built.ok) {
    console.error(`buildScorer failed: ${built.error}`);
    process.exitCode = 1;
    return;
  }

  const posting = new PostingsRepository(db).findByFingerprint(fingerprint);
  if (!posting) {
    console.error(`No posting with fingerprint ${fingerprint}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nposting: ${posting.company} — "${posting.title}"\n`);

  const now = new Date();
  const startedAt = Date.now();
  const result = await built.scorer.score(
    posting,
    hashProfile(profile, now),
    now,
  );
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!result.ok) {
    console.log(
      `FAILED after ${elapsedS}s: ${result.reason} (${result.attempts} attempts)`,
    );
    console.log(`diagnostic: ${JSON.stringify(result.diagnostic)}`);
  } else {
    console.log(
      `score ${result.score.toFixed(2)} → ${result.verdict}  (${elapsedS}s)`,
    );
    console.log(
      `mandatory ${(result.breakdown.mandatoryCoverage * 100).toFixed(0)}% | ` +
        `desirable ${(result.breakdown.desirableCoverage * 100).toFixed(0)}% | ` +
        `track ${(result.breakdown.trackAlignment * 100).toFixed(0)}%`,
    );
    console.log(
      `stageA cacheHit=${result.stageACacheHit} stageB cacheHit=${result.stageBCacheHit} ` +
        `evidenceRejected=${result.evidenceRejectedCount}`,
    );
    if (result.blockingFailure) {
      console.log(`BLOCKED by: ${result.blockingFailure}`);
    }
  }

  // The whole point of running one posting: which requirement actually moved.
  const check = new Database(dbPath, { readonly: true });
  const row = check
    .prepare("SELECT matches FROM matches WHERE fingerprint=?")
    .get(fingerprint) as { matches: string } | undefined;
  check.close();
  if (row) {
    console.log("\nper-requirement:");
    for (const match of JSON.parse(row.matches)) {
      console.log(
        `  ${String(match.status).padEnd(8)} ${String(match.requirement.weight).padEnd(9)} ` +
          `${match.requirement.text.slice(0, 62)}`,
      );
    }
  }

  const usage = built.getUsage?.();
  if (usage) {
    console.log(
      `\nusage: ${usage.attempts} attempts, $${usage.costUsd.toFixed(5)}, ` +
        `providers ${JSON.stringify(usage.providerCounts)}`,
    );
    // Zero attempts on a --cold run means a cache was not actually cleared.
    if (values.cold && usage.attempts === 0) {
      console.log(
        "WARNING: --cold made no model calls. Stage B answered entirely from cache;\n" +
          "this run measured nothing (docs/11-known-issues.md B12).",
      );
    }
  }
}

void main();

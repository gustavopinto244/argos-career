/**
 * Measures what a candidate `collection.queries` term is actually worth,
 * against the live source — the same discipline `measure:prefilter` applies
 * to the pre-filter, applied one step earlier to the query itself.
 *
 *   npm run probe:terms -- "estágio backend" "estágio dados"
 *   npm run probe:terms -- --source infojobs "estagio ti"
 *   npm run probe:terms -- --source gupy --remote "estágio backend"
 *
 * Reports, per term:
 *
 *   returned    what the source handed back
 *   passes      how many survive the real pre-filter
 *   on-track    of those, how many classify onto dev/security/automation/data
 *   in-region   of those, how many are remote or in an allowed city
 *   national    of those, how many are hiring in `criteria.homeCountry`
 *
 * **`on-track` and `in-region` are the columns that decide a term.** A term
 * returning 50 postings and zero on-track ones is a term that spends Stage A
 * budget to be discarded (ADR-018). `in-region` is what
 * `probe-indeed-terms.ts` already reported and this script did not — for a
 * remote query it is the difference between signal and a nationwide sweep.
 *
 * **Any registered source, not just Gupy** (ADR-069). This resolved
 * `GupyCollector`/`normalizeGupyJob` by direct import until 2026-08-26, so a
 * term could only ever be measured against one source — which meant every
 * query added for CIEE, InfoJobs or Sólides was, unavoidably, a guess. It now
 * goes through the same `collectorFor`/`normalizerFor` registries the real
 * pipeline uses, so what it measures is what production would do.
 *
 * Read-only — collects and measures, never writes to the database.
 */
import { Posting } from "../src/posting/domain/posting";
import { collectorFor } from "../src/posting/infrastructure/collector-registry";
import { normalizerFor } from "../src/posting/infrastructure/normalizer-registry";
import { classifyTrack } from "../src/prefilter/domain/classify-track";
import { applyPreFilter } from "../src/prefilter/domain/pre-filter";
import { isNationalPosting } from "../src/prefilter/domain/posting-origin";
import { normalizeTitle } from "../src/prefilter/domain/title-match";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";

const TERM_INTERVAL_MS = 1_500;
const DEFAULT_SOURCE = "gupy";
const DEFAULT_MAX_RESULTS = 50;

interface ProbeOptions {
  readonly source: string;
  readonly remote: boolean;
  readonly city: string | undefined;
  readonly type: string | undefined;
  readonly maxResults: number;
  readonly terms: readonly string[];
}

/**
 * Flags before terms, both order-independent. Deliberately hand-rolled
 * rather than pulling in an argument parser: this is a probe script run by
 * hand, and a dependency for five flags is not a trade this project makes.
 */
function parseArgs(argv: readonly string[]): ProbeOptions {
  let source = DEFAULT_SOURCE;
  let remote = false;
  let city: string | undefined;
  let type: string | undefined;
  let maxResults = DEFAULT_MAX_RESULTS;
  const terms: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--source") source = argv[++i] ?? DEFAULT_SOURCE;
    else if (arg === "--remote") remote = true;
    else if (arg === "--city") city = argv[++i];
    else if (arg === "--type") type = argv[++i];
    else if (arg === "--max")
      maxResults = Number(argv[++i]) || DEFAULT_MAX_RESULTS;
    else terms.push(arg);
  }
  return { source, remote, city, type, maxResults, terms };
}

/**
 * Mirrors what `executeCollect` passes a collector, so a term measured here
 * behaves the way the same term would in `criteria.yaml`. `jobName` is the
 * field every collector's own criteria schema reads for the search term.
 */
function buildCriteria(options: ProbeOptions, term: string): unknown {
  return {
    jobName: term,
    maxResults: options.maxResults,
    ...(options.remote ? { isRemoteWork: true } : {}),
    ...(options.city ? { city: options.city } : {}),
    // Gupy's `vacancy_type_internship` filter (ADR-062) is set on every real
    // query in `criteria.yaml`; without it a probe measures a different
    // query than the one that would actually ship.
    ...(options.type ? { type: options.type } : {}),
  };
}

/**
 * Remote counts as in-region unconditionally, exactly as
 * `isLocationAllowed` treats it (`pre-filter.ts`). City comparison reuses
 * `normalizeTitle` — the same accent/case folding the pre-filter's own
 * matching uses — rather than a second, subtly different normalizer.
 */
function isInRegion(posting: Posting, cities: readonly string[]): boolean {
  if (posting.workMode === "remote") return true;
  if (posting.location.kind !== "known") return false;
  const city = normalizeTitle(posting.location.city);
  return cities.some((allowed) => normalizeTitle(allowed) === city);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.terms.length === 0) {
    console.error(
      'Usage: npm run probe:terms -- [--source <name>] [--remote] [--city <city>] [--type <t>] [--max <n>] "<term>" ["<term>" …]',
    );
    process.exitCode = 1;
    return;
  }

  const collector = collectorFor(options.source);
  const normalize = normalizerFor(options.source);
  if (!collector || !normalize) {
    // Named explicitly rather than falling back to Gupy: silently probing a
    // different source than asked for would produce a number that looks real
    // and describes nothing.
    console.error(
      `No collector/normalizer registered for source "${options.source}".`,
    );
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

  console.log(
    `source: ${options.source}` +
      (options.remote ? " · remote" : "") +
      (options.city ? ` · city=${options.city}` : "") +
      ` · maxResults=${options.maxResults}\n`,
  );
  console.log(
    "term".padEnd(34) +
      "returned".padStart(9) +
      "passes".padStart(8) +
      "on-track".padStart(10) +
      "in-region".padStart(11) +
      "national".padStart(10),
  );

  for (const [index, term] of options.terms.entries()) {
    // Politeness between terms, same reason executeCollect spaces out
    // queries (CLAUDE.md §6).
    if (index > 0) await new Promise((r) => setTimeout(r, TERM_INTERVAL_MS));

    const result = await collector.collect(buildCriteria(options, term));
    if (result.error) {
      console.log(term.padEnd(34) + "  ERROR " + result.error.message);
      continue;
    }

    const postings = result.postings
      .map((raw) => normalize(raw, now))
      .filter((p): p is Posting => p !== null);
    const passes = postings.filter(
      (p) => applyPreFilter(p, criteria, profileKeywords, now).passed,
    );
    const onTrack = passes.filter(
      (p) =>
        classifyTrack(p.title, criteria.tracks, criteria.trackExclusions)
          .length > 0,
    );
    const inRegion = onTrack.filter((p) =>
      isInRegion(p, criteria.location.cities),
    );
    const national = inRegion.filter((p) => isNationalPosting(p, criteria));

    console.log(
      term.padEnd(34) +
        String(result.postings.length).padStart(9) +
        String(passes.length).padStart(8) +
        String(onTrack.length).padStart(10) +
        String(inRegion.length).padStart(11) +
        String(national.length).padStart(10) +
        (result.truncated ? "  (truncated)" : ""),
    );
  }
}

void main();

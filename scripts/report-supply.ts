/**
 * Per-source, per-week discovery yield — the number that actually answers
 * "is this source worth it," measured directly rather than guessed at.
 *
 *   npm run report:supply > relatorio-fontes.md
 *   npm run report:supply -- --weeks 12
 *
 * Every collector this project has added (Gupy, CIEE, Sólides, Indeed,
 * LinkedIn) was decided on volume or a one-off probe; none had an ongoing
 * number answering "is it still worth the request/maintenance budget."
 * That gap is exactly what let Indeed go silent for six days
 * (docs/11-known-issues.md B13) and Catho accumulate four ADRs before
 * anyone measured that it delivers nothing (B14) — both were found by a
 * one-off audit, not a number anyone was already looking at.
 *
 * Re-runs `applyPreFilter`/`classifyTrack` against every **active** posting
 * currently stored (`PostingsRepository.findActive()`), with **today's**
 * criteria — not a replay of the historical `posting_events` decision each
 * posting actually received, which would mix outcomes from however many
 * criteria versions have shipped since. This intentionally answers "how is
 * each source doing under the rules as they stand today," matching
 * `measure-prefilter-cut.ts`'s own precedent for the same trade-off.
 * Postings are bucketed by `firstSeenAt`'s ISO week, source's own arrival
 * pattern — not `posting_events.occurred_at`, which only reflects when a
 * pre-filter *decision* happened to run, and can lag arrival by however
 * long a posting sat unclaimed.
 *
 * "on-track & in-region" is exactly `applyPreFilter`'s `passed`, not a
 * separately computed location/track check — `isLocationAllowed` runs
 * inside the same function, so a passed posting is definitionally already
 * in the target metro area or remote (docs/02-architecture.md's rule
 * order). No separate location computation to keep in sync.
 *
 * "delivered" reads `posting_events` (`stage: 'delivery'`, `outcome:
 * 'delivered'`) instead — that event is written once per fingerprint,
 * ever (mirrors `postings.notifiedAt`'s own write-once discipline), so
 * counting event rows here carries no risk of the same posting being
 * counted twice across weeks the way a repeatedly-re-evaluated prefilter
 * rejection would.
 *
 * Read-only throughout — measures, never writes.
 */
import Database from "better-sqlite3";
import { parseArgs } from "node:util";
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";
import { PostingsRepository } from "../src/persistence/infrastructure/postings-repository";
import { applyPreFilter } from "../src/prefilter/domain/pre-filter";
import { classifyTrack } from "../src/prefilter/domain/classify-track";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";

const ON_TRACK_TRACKS = new Set(["dev", "security", "automation", "data"]);

/** Monday-start ISO week key, e.g. "2026-W34" — stable, sortable, and the
 * same bucketing for both the postings loop and the delivery-event query
 * below, so a week's arrivals and that week's deliveries line up. */
function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface WeekBucket {
  arrived: number;
  passed: number;
  onTrackInRegion: number;
  delivered: number;
}

function emptyBucket(): WeekBucket {
  return { arrived: 0, passed: 0, onTrackInRegion: 0, delivered: 0 };
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { weeks: { type: "string" } },
  });
  const weeksWanted = values.weeks ? Number(values.weeks) : 8;

  const databasePath = process.env.DATABASE_PATH ?? "./data/argos.db";
  const db = createDatabase(databasePath);
  runMigrations(db);

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

  const postings = new PostingsRepository(db).findActive();

  // source -> week -> bucket
  const bySourceWeek = new Map<string, Map<string, WeekBucket>>();
  const bucketFor = (source: string, week: string): WeekBucket => {
    let bySource = bySourceWeek.get(source);
    if (!bySource) {
      bySource = new Map();
      bySourceWeek.set(source, bySource);
    }
    let bucket = bySource.get(week);
    if (!bucket) {
      bucket = emptyBucket();
      bySource.set(week, bucket);
    }
    return bucket;
  };

  for (const posting of postings) {
    const week = isoWeekKey(posting.firstSeenAt);
    const bucket = bucketFor(posting.source, week);
    bucket.arrived += 1;

    // `now` is deliberately `posting.firstSeenAt`, not the real current
    // time: `applyPreFilter`'s age checks (`isTooOld`, `isExpired`) would
    // otherwise mark every posting from more than `maxAgeDays` ago as
    // stale regardless of how good it was the week it arrived, making
    // every week but the most recent report near-zero on-track counts for
    // a reason that has nothing to do with that week's real supply
    // quality. Evaluating "was this posting fresh and on-track at the
    // moment it arrived" is what this report is actually asking.
    const outcome = applyPreFilter(
      posting,
      criteria,
      profileKeywords,
      posting.firstSeenAt,
    );
    if (!outcome.passed) continue;
    bucket.passed += 1;

    const tracks = classifyTrack(
      posting.title,
      criteria.tracks,
      criteria.trackExclusions,
    );
    if (tracks.some((t) => ON_TRACK_TRACKS.has(t))) {
      bucket.onTrackInRegion += 1;
    }
  }

  // Delivered counts: real history, not a re-computation (see file header).
  // A separate, read-only raw connection -- same precedent score-one.ts
  // already uses for a query this project's Drizzle repositories don't
  // expose (`readonly: true`, so this can never write to the live db).
  const raw = new Database(databasePath, { readonly: true });
  const deliveryRows = raw
    .prepare(
      `select source, occurred_at as occurredAt
         from posting_events
        where stage = 'delivery' and outcome = 'delivered'`,
    )
    .all() as { source: string | null; occurredAt: number }[];
  raw.close();
  for (const row of deliveryRows) {
    if (!row.source) continue;
    const week = isoWeekKey(new Date(row.occurredAt));
    bucketFor(row.source, week).delivered += 1;
  }

  const sources = [...bySourceWeek.keys()].sort();
  const allWeeks = [
    ...new Set(sources.flatMap((s) => [...bySourceWeek.get(s)!.keys()])),
  ]
    .sort()
    .slice(-Math.max(1, weeksWanted));

  console.log(`# Rendimento por fonte\n`);
  console.log(
    `Gerado em ${now.toISOString()} · últimas ${allWeeks.length} semana(s) com dado · ` +
      `critérios de hoje aplicados retroativamente por \`firstSeenAt\`.\n`,
  );
  console.log(
    `**"on-track em-região"** é exatamente o \`passed\` do pré-filtro — não ` +
      `um cálculo de localização separado, a checagem de local já faz parte ` +
      `da mesma função. **"entregue"** vem do histórico real ` +
      `(\`posting_events\`), gravado uma única vez por vaga.\n`,
  );

  console.log(`## Resumo (todo o período com dado)\n`);
  console.log(
    `| Fonte | Chegaram | On-track em-região | Entregues | Taxa de acerto |`,
  );
  console.log(`| --- | ---: | ---: | ---: | ---: |`);
  for (const source of sources) {
    const weeks = bySourceWeek.get(source)!;
    const totals = [...weeks.values()].reduce(
      (acc, b) => ({
        arrived: acc.arrived + b.arrived,
        passed: acc.passed + b.passed,
        onTrackInRegion: acc.onTrackInRegion + b.onTrackInRegion,
        delivered: acc.delivered + b.delivered,
      }),
      emptyBucket(),
    );
    const rate =
      totals.arrived === 0
        ? "—"
        : `${((100 * totals.onTrackInRegion) / totals.arrived).toFixed(1)}%`;
    console.log(
      `| ${source} | ${totals.arrived} | ${totals.onTrackInRegion} | ` +
        `${totals.delivered} | ${rate} |`,
    );
  }

  console.log(`\n## Chegadas por semana\n`);
  console.log(
    `Uma fonte que some desta tabela por várias semanas seguidas é o sinal ` +
      `que faltou ao B13 (Indeed silenciosa por 6 dias) antes de existir o ` +
      `alerta \`sourceFreshnessHours\` — este relatório é para revisão ` +
      `periódica, não substitui aquele alerta.\n`,
  );
  console.log(`| Fonte | ${allWeeks.join(" | ")} |`);
  console.log(`| --- | ${allWeeks.map(() => "---:").join(" | ")} |`);
  for (const source of sources) {
    const weeks = bySourceWeek.get(source)!;
    const cells = allWeeks.map((w) => weeks.get(w)?.arrived ?? 0);
    console.log(`| ${source} | ${cells.join(" | ")} |`);
  }

  console.log(`\n## On-track em-região por semana\n`);
  console.log(`| Fonte | ${allWeeks.join(" | ")} |`);
  console.log(`| --- | ${allWeeks.map(() => "---:").join(" | ")} |`);
  for (const source of sources) {
    const weeks = bySourceWeek.get(source)!;
    const cells = allWeeks.map((w) => weeks.get(w)?.onTrackInRegion ?? 0);
    console.log(`| ${source} | ${cells.join(" | ")} |`);
  }
}

main();

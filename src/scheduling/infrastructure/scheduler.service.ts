import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { executeCollect, executeDedup, executeDeliver } from "../../cli/main";
import { backupDatabase } from "../../persistence/infrastructure/backup";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../persistence/infrastructure/db";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { RunsRepository } from "../../persistence/infrastructure/runs-repository";
import { collectorFor } from "../../posting/infrastructure/collector-registry";
import { Criteria } from "../../prefilter/domain/criteria";
import { loadCriteria } from "../../prefilter/infrastructure/criteria-loader";
import { Profile } from "../../profile/domain/profile";
import { loadTaxonomy } from "../../market/infrastructure/taxonomy-loader";
import { Taxonomy } from "../../market/domain/taxonomy";
import { loadProfile } from "../../profile/infrastructure/profile-loader";
import { buildScorer } from "../../scoring/infrastructure/build-scorer";
import { TelegramNotifier } from "../../delivery/infrastructure/telegram-notifier";
import { DeliveryOperationsRepository } from "../../persistence/infrastructure/delivery-operations-repository";
import { PendingAlertsRepository } from "../../persistence/infrastructure/pending-alerts-repository";
import { loadTelegramConfig } from "../../delivery/infrastructure/telegram-config";
import {
  Alert,
  evaluateCollectionHealth,
  evaluateDeliveryOutcome,
  evaluateMissedRuns,
  evaluateSourceFreshness,
} from "../domain/alerts";
import { RunLock, runExclusive } from "../domain/run-lock";
import { RUN_LOCK } from "./run-lock.provider";

/**
 * Turns `schedule.collection.intervalHours` into a standard 5-field cron
 * expression firing at minute 0 of every Nth hour — the same shape a crontab
 * entry for "every N hours" would use. `schedule.scoreAndDeliver.time` is
 * `HH:mm`, already validated by `CriteriaSchema`.
 */
export function collectionCronExpression(intervalHours: number): string {
  return `0 */${intervalHours} * * *`;
}

export function deliverCronExpression(time: string): string {
  const [hour, minute] = time.split(":");
  return `${minute} ${hour} * * *`;
}

/**
 * ADR-009's two independent crons, wired through `@nestjs/schedule`
 * (CLAUDE.md §4/§14, M8). Registered dynamically via `SchedulerRegistry`
 * rather than the `@Cron` decorator — the decorator needs a compile-time
 * literal, and the actual schedule is only known once `criteria.yaml` loads.
 *
 * Both handlers call the same `execute*` functions the CLI's `collect`,
 * `dedup` and `deliver` commands already use and are already tested against
 * (`src/cli/main.ts`) — one code path for "run this stage" regardless of
 * what triggered it (principle 2), not a second implementation that could
 * drift from the first.
 *
 * Config (`criteria.yaml`, `profile.yaml`, the database handle) is read
 * once, in `onModuleInit` (`docs/09-configuration.md` rule 5: "config is
 * read once at startup, not per stage") — a mid-deployment edit takes effect
 * on the next container restart, not mid-batch.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  // Definite-assignment (`!`), not `readonly` — assigned in `onModuleInit`,
  // not the constructor; see the comment below for why.
  private db!: Db;
  private criteria!: Criteria;
  private profile!: Profile;
  /** ADR-078 — read here rather than injected, matching how this service
   * already sources `criteria` and `profile`: from the same env-var path
   * `taxonomyProvider` uses, in `onModuleInit`. */
  private taxonomy!: Taxonomy;
  private notifier!: TelegramNotifier;
  private pendingAlerts!: PendingAlertsRepository;

  // Explicit @Inject rather than relying on reflected constructor-parameter
  // metadata: `npm run dev` runs this under `tsx` (esbuild), whose
  // `emitDecoratorMetadata` support is incomplete enough that plain
  // type-based injection silently resolves to `undefined` here — verified
  // by booting the real `tsc` build (works) against `tsx` (does not) while
  // building this service. An explicit token sidesteps the gap in both.
  //
  // Config loading and the database handle live in `onModuleInit`, not
  // here — a constructor that reads files and env vars means the module
  // graph cannot even be *compiled* (e.g. in a test) without a fully
  // configured environment already in place, which is a stricter
  // requirement than DI wiring itself should have.
  constructor(
    @Inject(SchedulerRegistry) private readonly registry: SchedulerRegistry,
    @Inject(RUN_LOCK) private readonly runLock: RunLock,
  ) {}

  onModuleInit(): void {
    this.db = createDatabase(process.env.DATABASE_PATH ?? "./data/argos.db");
    runMigrations(this.db);
    this.criteria = loadCriteria(
      process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
    );
    this.profile = loadProfile(
      process.env.PROFILE_PATH ?? "./config/profile.yaml",
    );
    this.taxonomy = loadTaxonomy(
      process.env.TAXONOMY_PATH ?? "./config/taxonomy.yaml",
    );
    this.notifier = new TelegramNotifier(loadTelegramConfig(), fetch, {
      deliveryStore: new DeliveryOperationsRepository(this.db),
    });
    this.pendingAlerts = new PendingAlertsRepository(this.db);

    const { collection, scoreAndDeliver } = this.criteria.schedule;

    const collectionJob = CronJob.from({
      cronTime: collectionCronExpression(collection.intervalHours),
      onTick: () => void this.runCollectionCycle(),
      start: true,
    });
    this.registry.addCronJob("collection", collectionJob);

    const deliverJob = CronJob.from({
      cronTime: deliverCronExpression(scoreAndDeliver.time),
      timeZone: scoreAndDeliver.timezone,
      onTick: () => void this.runScoreAndDeliverCycle(),
      start: true,
    });
    this.registry.addCronJob("scoreAndDeliver", deliverJob);

    this.logger.log(
      `Scheduled: collection every ${collection.intervalHours}h, ` +
        `scoreAndDeliver daily at ${scoreAndDeliver.time} ${scoreAndDeliver.timezone}.`,
    );
  }

  /** Collect → dedup, then check collection-health and missed-run alerts —
   * the natural place for the missed-run check, since this cycle already
   * runs every few hours regardless of what it finds (docs/08).
   *
   * Both phases are guarded (ADR-024): a tick landing while a manual
   * `POST /runs/collect`/`run_dedup` (or a prior tick that overran) is
   * still in flight logs and skips that phase rather than starting a
   * second one against the same corpus. A locked-out `collect` skips the
   * whole cycle, including the alert check — the alert logic only reads
   * run history that a skipped tick never changes, so there is nothing new
   * to evaluate.
   */
  private async runCollectionCycle(): Promise<void> {
    // Preserves the original try/catch's shape: a thrown collect means
    // dedup is skipped for this tick too, not attempted against whatever
    // partial state the throw left behind — `collected.result` carries that
    // decision out of the locked section rather than nesting a second
    // `runExclusive` inside the same closure.
    const collected = await runExclusive(this.runLock, "collect", async () => {
      try {
        await executeCollect(
          this.db,
          collectorFor,
          this.criteria.collection.queries,
          () => new Date(),
          this.criteria.collection.queryIntervalMs,
          this.criteria.collection,
        );
        return true;
      } catch (cause) {
        this.logger.error("Collection cycle threw unexpectedly", cause);
        return false;
      }
    });

    if (!collected.ok) {
      this.logger.warn(
        "Skipped this collection tick: a collect run is already in flight.",
      );
      return;
    }

    if (collected.result) {
      const dedupped = await runExclusive(this.runLock, "dedup", () =>
        Promise.resolve().then(() => executeDedup(this.db)),
      );
      if (!dedupped.ok) {
        this.logger.warn(
          "Skipped this cycle's dedup phase: a dedup run is already in flight.",
        );
      }
    }

    await this.sendAlerts(this.evaluateAfterCollection());
  }

  private async runScoreAndDeliverCycle(): Promise<void> {
    const runsRepo = new RunsRepository(this.db);
    const built = buildScorer(this.db, this.criteria, this.profile);

    if (!built.ok) {
      await this.sendAlerts([
        {
          text: `scoreAndDeliver misconfigured: ${built.error}`,
          key: "scoring:misconfigured",
        },
      ]);
      return;
    }

    // ADR-024: the concrete incident this guards against — a manual
    // `POST /runs/deliver` landing while this tick's own multi-hour run was
    // still scoring would otherwise score and could notify the same
    // postings twice. `sendAlerts` deliberately does not fire here: a
    // locked-out tick is expected and benign (a manual check-now call ran
    // long), not the unexpected-failure case the alert paths below cover.
    const lockedOut = !this.runLock.tryAcquire("scoreAndDeliver");
    if (lockedOut) {
      this.logger.warn(
        "Skipped this scoreAndDeliver tick: a run is already in flight.",
      );
      return;
    }

    // The lock is released in `finally`, before `runBackup` — a lock held
    // across the backup step would block a manual `deliver` from starting
    // during what is otherwise just a file copy, for no reason connected to
    // what the lock actually protects (ADR-024).
    try {
      try {
        const outcome = await executeDeliver(
          this.db,
          built.scorer,
          this.notifier,
          this.criteria,
          this.profile,
          built.getUsage,
          undefined,
          undefined,
          undefined,
          "internal",
          // docs/11-known-issues.md C1: the scheduled cron and RunsService's
          // REST/MCP-triggered run share this same `RunLock` instance (both
          // injected via `RUN_LOCK`) — a cancel request placed through
          // `POST /runs/scoreAndDeliver/cancel` reaches whichever of the two
          // actually holds the lock right now.
          () => this.runLock.isCancelRequested("scoreAndDeliver"),
          this.taxonomy,
        );

        const run = runsRepo.findById(outcome.runId);
        if (run) {
          await this.sendAlerts(
            evaluateDeliveryOutcome(
              run,
              this.criteria.alerts.scoreFailureRateThreshold,
            ),
          );
        }
      } catch (cause) {
        this.logger.error("scoreAndDeliver cycle threw unexpectedly", cause);
        await this.sendAlerts([
          {
            text: "scoreAndDeliver cycle threw an unexpected error.",
            key: "scoring:threw",
          },
        ]);
      }
    } finally {
      this.runLock.release("scoreAndDeliver");
    }

    this.runBackup();
  }

  /**
   * Chained directly after the nightly cycle finishes, rather than a fourth
   * cron expression offset by some guessed number of minutes from
   * `scoreAndDeliver.time` — that would race the actual run length instead
   * of following it. `executeDeliver` has already called `runsRepo.finish`
   * by the time control returns here — on success, on a failed send, and (as
   * of 2026-08-16) on a throw, which is the case this comment previously
   * asserted without it being true: an exception out of the scoring loop
   * skipped `finish` entirely and left the row open forever. So there is
   * never an unfinished run for the backup to catch mid-write.
   *
   * Synchronous and best-effort: a failed backup is logged and alerted, not
   * thrown — a backup failure must not be mistaken for a pipeline failure
   * principle 1 already has its own alerting for.
   */
  private runBackup(): void {
    try {
      const result = backupDatabase(
        process.env.DATABASE_PATH ?? "./data/argos.db",
        process.env.BACKUPS_DIR ?? "./backups",
      );
      this.logger.log(`Backed up database to ${result.path}`);
    } catch (cause) {
      this.logger.error("Nightly backup failed", cause);
      void this.sendAlerts([
        { text: "Nightly database backup failed.", key: "backup:failed" },
      ]);
    }
  }

  private evaluateAfterCollection(): Alert[] {
    const runsRepo = new RunsRepository(this.db);
    const threshold = this.criteria.alerts.consecutiveEmptyCollectionRuns;

    const recentCollectRuns = runsRepo
      .findRunsSince("collect", null)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, threshold);

    const collectionAlerts = evaluateCollectionHealth(
      recentCollectRuns,
      threshold,
    );

    const missedRunAlerts = evaluateMissedRuns(
      new Date(),
      runsRepo.findLatestFinished("scoreAndDeliver", "success"),
      runsRepo.findLatestFinished("collect", "success"),
      this.criteria.schedule,
    );

    // Reads the corpus, not `runs` — the only signal here that can see a
    // push-based external collector going silent (docs/11-known-issues.md
    // B13). Every check above would report green through exactly that.
    const freshnessAlerts = evaluateSourceFreshness(
      new Date(),
      new PostingsRepository(this.db).findLastSeenAtBySource(),
      this.criteria.alerts.sourceFreshnessHours,
    );

    return [...collectionAlerts, ...missedRunAlerts, ...freshnessAlerts];
  }

  /**
   * Sends alerts, and — before them — anything an earlier cycle could not
   * deliver (ADR-067).
   *
   * Alerting shares the digest's Telegram channel on purpose (docs/08: a
   * second channel is infrastructure nobody maintains). The gap that leaves
   * is that when Telegram is what broke, the alert *about* it goes out over
   * the broken channel and survives only as a journald line. `docs/11` B20
   * is that gap costing a real digest.
   *
   * This closes it without adding a channel, by moving the alert in time
   * instead: a failed send is queued and redelivered on the next cycle that
   * succeeds. Late, but not lost.
   *
   * Called on every collection cycle, including when there is nothing new to
   * report — draining is the whole point, and a cycle with no alerts is
   * exactly when a backlog is most likely to be waiting.
   */
  private async sendAlerts(alerts: readonly Alert[]): Promise<void> {
    await this.redeliverQueuedAlerts();
    for (const alert of alerts) {
      const result = await this.notifier.sendText(alert.text);
      if (!result.ok) {
        this.logger.error(
          `Failed to send alert: ${alert.text} (${result.error.message})`,
        );
        this.pendingAlerts.queue(
          alert.key,
          alert.text,
          new Date(),
          result.error.message,
        );
      }
    }
  }

  /**
   * Re-sends queued alerts, oldest first, stopping at the first failure.
   *
   * Stopping early rather than trying each in turn: if the send failed, the
   * channel is still down, and the remaining attempts would fail the same
   * way while holding up the cycle. They stay queued for the next one.
   *
   * The redelivered text says when the alert was first raised, and how many
   * times the condition recurred while it could not be sent — without that,
   * an alert arriving hours late reads as a fresh problem, which is its own
   * kind of wrong.
   */
  private async redeliverQueuedAlerts(): Promise<void> {
    const queued = this.pendingAlerts.list(MAX_ALERT_REDELIVERIES_PER_CYCLE);
    if (queued.length === 0) return;

    for (const alert of queued) {
      const result = await this.notifier.sendText(formatQueuedAlert(alert));
      if (!result.ok) {
        this.logger.warn(
          `Alert redelivery still failing, ${this.pendingAlerts.count()} queued (${result.error.message})`,
        );
        return;
      }
      this.pendingAlerts.remove(alert.id);
    }

    const remaining = this.pendingAlerts.count();
    if (remaining > 0) {
      this.logger.log(
        `Redelivered ${queued.length} queued alert(s); ${remaining} still queued.`,
      );
    }
  }
}

/** Bounds a single recovery cycle. Telegram rate-limits per chat (docs/11
 * B3), so a long outage must not turn the first successful cycle into a
 * flood; the remainder drains on later cycles. */
const MAX_ALERT_REDELIVERIES_PER_CYCLE = 5;

/** Marks a late alert as late. An alert that reads as current when it
 * describes a condition from hours ago is misleading in a way the original
 * text cannot fix on its own. */
function formatQueuedAlert(alert: {
  readonly text: string;
  readonly firstQueuedAt: Date;
  readonly occurrences: number;
}): string {
  const raised = alert.firstQueuedAt.toISOString();
  const repeated =
    alert.occurrences > 1 ? `, seen ${alert.occurrences}x since` : "";
  return `[delayed alert — first raised ${raised}${repeated}]\n${alert.text}`;
}

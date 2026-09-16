import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { executeCollect, executeDedup } from "../../cli/main";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../persistence/infrastructure/db";
import { collectorFor } from "../../posting/infrastructure/collector-registry";
import { TextNotifier } from "../../delivery/infrastructure/telegram-notifier";
import { TelegramConfigError } from "../../delivery/infrastructure/telegram-config";
import {
  TelegramSubscribers,
  SubscriberNotifier,
  pollSubscribers,
} from "../../radar/infrastructure/telegram-subscribers";
import { RunLock, runExclusive } from "../domain/run-lock";
import { RUN_LOCK } from "./run-lock.provider";
import { JobRadarConfig } from "../../radar/domain/job-radar-config";
import { loadJobRadarConfig } from "../../radar/infrastructure/job-radar-config-loader";
import { deliverJobRadar } from "../../radar/application/deliver-job-radar";

/**
 * Turns `schedule.collection.intervalHours` into a standard 5-field cron
 * expression firing at minute 0 of every Nth hour — the same shape a crontab
 * entry for "every N hours" would use. Each entry in
 * `schedule.scoreAndDeliver.times` is `HH:mm`, already validated (and
 * deduplicated/sorted) by `CriteriaSchema`.
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
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  // Definite-assignment (`!`), not `readonly` — assigned in `onModuleInit`,
  // not the constructor; see the comment below for why.
  private db!: Db;
  private criteria!: JobRadarConfig;
  private notifier!: TextNotifier;
  private subscriberTimer?: ReturnType<typeof setInterval>;
  private polling = false;

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
    this.db = createDatabase(
      process.env.DATABASE_PATH ?? "./data/job-radar.db",
    );
    runMigrations(this.db);
    this.criteria = loadJobRadarConfig(
      process.env.JOB_RADAR_CONFIG_PATH ?? "./config/job-radar.yaml",
    );
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) throw new TelegramConfigError("TELEGRAM_BOT_TOKEN is not set");
    const subscribers = new TelegramSubscribers(this.db);
    this.notifier = new SubscriberNotifier(subscribers, token);
    const poll = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        await pollSubscribers(subscribers, token);
      } catch {
        this.logger.warn(
          "Não foi possível atualizar os assinantes do Telegram",
        );
      } finally {
        this.polling = false;
      }
    };
    this.subscriberTimer = setInterval(() => void poll(), 10_000);
    this.subscriberTimer.unref();

    const { collection, delivery } = this.criteria.schedule;

    const collectionJob = CronJob.from({
      cronTime: collectionCronExpression(collection.intervalHours),
      onTick: () => void this.runCollectionCycle(),
      start: true,
    });
    this.registry.addCronJob("collection", collectionJob);

    // ADR-009 Amendment 1: one or more daily windows, each its own CronJob
    // sharing the same `RunLock` key ("scoreAndDeliver") and handler — two
    // windows landing back-to-back is exactly what the lock in
    // `runScoreAndDeliverCycle` already guards against, so registering N
    // independent jobs needs no new coordination.
    delivery.times.forEach((time, index) => {
      const deliverJob = CronJob.from({
        cronTime: deliverCronExpression(time),
        timeZone: delivery.timezone,
        onTick: () => void this.runScoreAndDeliverCycle(),
        start: true,
      });
      this.registry.addCronJob(`scoreAndDeliver:${index}`, deliverJob);
    });

    this.logger.log(
      `Scheduled: collection every ${collection.intervalHours}h, ` +
        `job-radar delivery daily at ${delivery.times.join(", ")} ${delivery.timezone}.`,
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
  onModuleDestroy(): void {
    if (this.subscriberTimer) clearInterval(this.subscriberTimer);
  }

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
  }

  private async runScoreAndDeliverCycle(): Promise<void> {
    const lockedOut = !this.runLock.tryAcquire("scoreAndDeliver");
    if (lockedOut) {
      this.logger.warn(
        "Skipped this scoreAndDeliver tick: a run is already in flight.",
      );
      return;
    }

    try {
      const outcome = await deliverJobRadar(
        this.db,
        this.notifier,
        this.criteria,
        undefined,
        "internal",
      );
      if (outcome.error) {
        this.logger.error(`Job-radar delivery failed: ${outcome.error}`);
      }
    } catch (cause) {
      this.logger.error("Job-radar delivery threw unexpectedly", cause);
    } finally {
      this.runLock.release("scoreAndDeliver");
    }
  }
}

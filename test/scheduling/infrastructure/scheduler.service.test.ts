import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { SchedulingModule } from "../../../src/scheduling/infrastructure/scheduling.module";
import {
  collectionCronExpression,
  deliverCronExpression,
  SchedulerService,
} from "../../../src/scheduling/infrastructure/scheduler.service";
import { PendingAlertsRepository } from "../../../src/persistence/infrastructure/pending-alerts-repository";
import { createDatabase } from "../../../src/persistence/infrastructure/db";

describe("collectionCronExpression", () => {
  it("fires at minute 0 of every Nth hour", () => {
    expect(collectionCronExpression(4)).toBe("0 */4 * * *");
    expect(collectionCronExpression(1)).toBe("0 */1 * * *");
  });
});

describe("deliverCronExpression", () => {
  it("converts HH:mm into a daily cron expression", () => {
    expect(deliverCronExpression("03:00")).toBe("00 03 * * *");
    expect(deliverCronExpression("23:59")).toBe("59 23 * * *");
  });
});

/**
 * Boots the real DI graph (`SchedulingModule`) against a throwaway config
 * directory and asserts the two ADR-009 cron jobs actually get registered —
 * the check a pure unit test of the expression-building helpers above
 * cannot make on its own. Both jobs are stopped immediately after the
 * assertion so no real timer outlives the test.
 */
describe("SchedulerService — real DI wiring", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-scheduler-"));
    writeFileSync(
      join(dir, "criteria.yaml"),
      `
titleRequired: [estágio]
location: { allowRemote: true }
tracks: { dev: [backend], security: [], automation: [], data: [] }
trackWeights: { dev: 1.0, security: 1.0, automation: 0.7, data: 0.7, unknown: 0.4 }
scoring:
  weights: { mandatory: 65, desirable: 20, trackAlignment: 15 }
  thresholds: { apply: 70, review: 45 }
  minExtractedRequirements: 1
  blockingCapScore: 35
  unknownTrackCapScore: 50
schedule:
  collection: { intervalHours: 6 }
  scoreAndDeliver: { time: "02:30", timezone: "America/Sao_Paulo" }
`,
    );
    writeFileSync(
      join(dir, "profile.yaml"),
      `
courseName: Sistemas de Informação
institution: Universidade Exemplo
courseStart: 2026-03-01
courseEnd: 2029-12-01
englishLevel: intermediate
minimumStipend: "R$ 700"
maxWeeklyHours: "40"
workAvailability: "Remoto em qualquer lugar."
competencies:
  - name: Node.js
    tracks: [dev]
    evidence: ["Built a Node.js service."]
resumeVariants:
  - id: backend
    tracks: [dev]
    competencyNames: [Node.js]
`,
    );

    env = { ...process.env };
    process.env.DATABASE_PATH = join(dir, "argos.db");
    process.env.CRITERIA_PATH = join(dir, "criteria.yaml");
    process.env.PROFILE_PATH = join(dir, "profile.yaml");
    process.env.TELEGRAM_BOT_TOKEN = "000:test";
    process.env.TELEGRAM_CHAT_ID = "123";
  });

  afterEach(() => {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a collection and a scoreAndDeliver cron job matching criteria.yaml", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SchedulingModule],
    }).compile();
    // `.init()` runs the `onModuleInit` lifecycle without needing an HTTP
    // adapter (`createNestApplication()` would, and none is installed —
    // this app has no HTTP surface until M9).
    await moduleRef.init();

    const service = moduleRef.get(SchedulerService);
    expect(service).toBeDefined();

    const registry = moduleRef.get(
      (await import("@nestjs/schedule")).SchedulerRegistry,
    );
    const jobs = registry.getCronJobs();
    expect(jobs.has("collection")).toBe(true);
    expect(jobs.has("scoreAndDeliver")).toBe(true);

    expect(jobs.get("collection")?.cronTime.source).toBe("0 */6 * * *");
    expect(jobs.get("scoreAndDeliver")?.cronTime.source).toBe("30 02 * * *");

    jobs.get("collection")?.stop();
    jobs.get("scoreAndDeliver")?.stop();
    await moduleRef.close();
  });

  it("backs up the real database after a scoreAndDeliver cycle finishes", async () => {
    process.env.BACKUPS_DIR = join(dir, "backups");

    const moduleRef = await Test.createTestingModule({
      imports: [SchedulingModule],
    }).compile();
    await moduleRef.init();

    const service = moduleRef.get(SchedulerService);
    // Exercises the same private method the scoreAndDeliver cron chains
    // into, without driving a full deliver cycle (which needs a real
    // scorer and a real Telegram send) — `runBackup` itself has no such
    // dependency, so this is testing the actual production code path, not
    // a reimplementation of it.
    (service as unknown as { runBackup: () => void }).runBackup();

    expect(existsSync(process.env.BACKUPS_DIR)).toBe(true);
    const backups = readdirSync(process.env.BACKUPS_DIR);
    expect(
      backups.some((f) => f.startsWith("argos-") && f.endsWith(".db")),
    ).toBe(true);

    const registry = moduleRef.get(
      (await import("@nestjs/schedule")).SchedulerRegistry,
    );
    for (const job of registry.getCronJobs().values()) job.stop();
    await moduleRef.close();
  });

  it("queues an undeliverable alert and redelivers it on the next cycle (ADR-067)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SchedulingModule],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(SchedulerService);
    const internals = service as unknown as {
      notifier: { sendText: (text: string) => Promise<unknown> };
      sendAlerts: (alerts: readonly { text: string }[]) => Promise<void>;
    };

    // docs/11 B20: alerting shares the digest's channel, so when Telegram is
    // what broke, the alert about it goes out over the broken channel.
    const sent: string[] = [];
    internals.notifier = {
      sendText: () =>
        Promise.resolve({
          ok: false,
          error: { message: "Telegram request failed" },
        }),
    };
    await internals.sendAlerts([{ text: "No digest sent today." }]);

    const queue = new PendingAlertsRepository(
      createDatabase(process.env.DATABASE_PATH!),
    );
    expect(queue.count()).toBe(1);

    // Next cycle, channel back, nothing new to report — draining is exactly
    // what an otherwise-quiet cycle is for.
    internals.notifier = {
      sendText: (text: string) => {
        sent.push(text);
        return Promise.resolve({ ok: true });
      },
    };
    await internals.sendAlerts([]);

    expect(queue.count()).toBe(0);
    expect(sent).toHaveLength(1);
    // A late alert must announce that it is late, or it reads as a fresh
    // problem hours after the fact.
    expect(sent[0]).toContain("delayed alert");
    expect(sent[0]).toContain("No digest sent today.");

    const registry = moduleRef.get(
      (await import("@nestjs/schedule")).SchedulerRegistry,
    );
    for (const job of registry.getCronJobs().values()) job.stop();
    await moduleRef.close();
  });

  it("stops redelivering at the first failure and keeps the rest queued (ADR-067)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SchedulingModule],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(SchedulerService);
    const internals = service as unknown as {
      notifier: { sendText: (text: string) => Promise<unknown> };
      sendAlerts: (alerts: readonly { text: string }[]) => Promise<void>;
    };

    internals.notifier = {
      sendText: () =>
        Promise.resolve({ ok: false, error: { message: "still down" } }),
    };
    await internals.sendAlerts([{ text: "alert one" }, { text: "alert two" }]);

    const queue = new PendingAlertsRepository(
      createDatabase(process.env.DATABASE_PATH!),
    );
    expect(queue.count()).toBe(2);

    // Channel still down on the next cycle: one attempt, then stop — the
    // rest would fail identically while holding up the cycle.
    let attempts = 0;
    internals.notifier = {
      sendText: () => {
        attempts += 1;
        return Promise.resolve({ ok: false, error: { message: "still down" } });
      },
    };
    await internals.sendAlerts([]);

    expect(attempts).toBe(1);
    expect(queue.count()).toBe(2);

    const registry = moduleRef.get(
      (await import("@nestjs/schedule")).SchedulerRegistry,
    );
    for (const job of registry.getCronJobs().values()) job.stop();
    await moduleRef.close();
  });
});

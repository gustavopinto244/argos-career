import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("SchedulerService — real DI wiring", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "job-radar-scheduler-"));
    writeFileSync(
      join(dir, "job-radar.yaml"),
      `
search:
  label: Busca de vagas
  location: Brasil e remoto
collection:
  queries:
    - source: gupy
      jobName: QA
  queryIntervalMs: 0
  recencyDays: 1
  backfillDays: 7
schedule:
  collection: { intervalHours: 6 }
  delivery: { times: ["02:30", "14:00"], timezone: America/Sao_Paulo }
delivery:
  onsiteCity: Joinville
`,
    );

    env = { ...process.env };
    process.env.DATABASE_PATH = join(dir, "job-radar.db");
    process.env.JOB_RADAR_CONFIG_PATH = join(dir, "job-radar.yaml");
    process.env.TELEGRAM_BOT_TOKEN = "000:test";
    process.env.TELEGRAM_CHAT_ID = "123";
  });

  afterEach(() => {
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers collection and delivery schedules from the job-radar config", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SchedulingModule],
    }).compile();
    await moduleRef.init();

    const service = moduleRef.get(SchedulerService);
    expect(service).toBeDefined();

    const registry = moduleRef.get(
      (await import("@nestjs/schedule")).SchedulerRegistry,
    );
    const jobs = registry.getCronJobs();
    expect(jobs.has("collection")).toBe(true);
    expect(jobs.has("scoreAndDeliver:0")).toBe(true);
    expect(jobs.has("scoreAndDeliver:1")).toBe(true);
    expect(jobs.get("collection")?.cronTime.source).toBe("0 */6 * * *");
    expect(jobs.get("scoreAndDeliver:0")?.cronTime.source).toBe("30 02 * * *");
    expect(jobs.get("scoreAndDeliver:1")?.cronTime.source).toBe("00 14 * * *");

    for (const job of jobs.values()) job.stop();
    await moduleRef.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deliverJobRadar } from "../../../src/radar/application/deliver-job-radar";
import { JobRadarConfig } from "../../../src/radar/domain/job-radar-config";
import {
  Db,
  createDatabase,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../../src/persistence/infrastructure/postings-repository";
import { Posting } from "../../../src/posting/domain/posting";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-radar-"));
  db = createDatabase(join(dir, "radar.db"));
  runMigrations(db);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config: JobRadarConfig = {
  search: { label: "Busca de vagas", location: "Brasil e remoto" },
  collection: {
    queries: [{ source: "gupy", jobName: "vaga" }],
    queryIntervalMs: 0,
    recencyDays: 1,
    backfillDays: 7,
  },
  schedule: {
    collection: { intervalHours: 4 },
    delivery: { times: ["08:00"], timezone: "America/Sao_Paulo" },
  },
  delivery: { requiredCategories: [] },
};

function posting(id: string, firstSeenAt: Date): Posting {
  return {
    source: "gupy",
    sourceId: id,
    fingerprint: `gupy:${id}`,
    company: `Empresa ${id}`,
    title: `Vaga ${id}`,
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "remote",
    seniority: null,
    experienceYears: null,
    applicationDeadline: null,
    publishedAt: firstSeenAt,
    sourceUrl: `https://example.test/${id}`,
    description: null,
    country: "BR",
    collectedAt: firstSeenAt,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    rawPayload: {},
  };
}

describe("deliverJobRadar", () => {
  it("delivers only new vacancies without scoring or a profile", async () => {
    const repository = new PostingsRepository(db);
    repository.upsert(posting("old", new Date("2026-01-01T10:00:00Z")));
    repository.upsert(posting("new", new Date("2026-01-02T10:00:00Z")));
    const messages: string[] = [];
    const notifier = {
      sendText: async (text: string) => {
        messages.push(text);
        return { ok: true as const };
      },
    };

    const first = await deliverJobRadar(db, notifier, config);
    const second = await deliverJobRadar(db, notifier, config);

    expect(first.delivered).toBe(2);
    expect(second.delivered).toBe(0);
    expect(messages[0]).toContain("Vaga new");
    expect(messages[0]).not.toContain("Compatibilidade");
    expect(messages[0]).toContain("Vaga old");
    expect(messages[1]).toContain("Nenhuma vaga nova");
  });

  it("includes each required category when matching vacancies are available", async () => {
    const repository = new PostingsRepository(db);
    repository.upsert(posting("other", new Date("2026-01-03T10:00:00Z")));
    repository.upsert({
      ...posting("support", new Date("2026-01-02T10:00:00Z")),
      title: "Analista de Suporte Técnico",
    });
    repository.upsert({
      ...posting("qa", new Date("2026-01-01T10:00:00Z")),
      title: "Analista de Testes de Software",
    });
    const messages: string[] = [];
    const notifier = {
      sendText: async (text: string) => {
        messages.push(text);
        return { ok: true as const };
      },
    };

    const outcome = await deliverJobRadar(db, notifier, {
      ...config,
      delivery: {
        requiredCategories: [
          { label: "QA", terms: ["QA", "testes"] },
          { label: "Suporte", terms: ["suporte", "support"] },
        ],
      },
    });

    expect(outcome.delivered).toBe(3);
    expect(messages[0]).toContain("Analista de Testes de Software");
    expect(messages[0]).toContain("Analista de Suporte Técnico");
    expect(messages[0]).toContain("Vaga other");
    expect(messages[0]!.indexOf("Analista de Testes de Software")).toBeLessThan(
      messages[0]!.indexOf("Vaga other"),
    );
  });
});

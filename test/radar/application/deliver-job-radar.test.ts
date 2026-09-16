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
  delivery: { onsiteCity: "Joinville", titleTerms: ["assistente", "analista"] },
};

function posting(id: string, firstSeenAt: Date): Posting {
  return {
    source: "gupy",
    sourceId: id,
    fingerprint: `gupy:${id}`,
    company: `Empresa ${id}`,
    title: `Assistente ${id}`,
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "remote",
    seniority: null,
    experienceYears: null,
    applicationDeadline: null,
    publishedAt: firstSeenAt,
    sourceUrl: `https://example.test/${id}`,
    description:
      "Ensino médio completo. Atendimento ao cliente e informática básica.",
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
    expect(messages[0]).toContain("Assistente new");
    expect(messages[0]).not.toContain("Compatibilidade");
    expect(messages[0]).toContain("Assistente old");
    expect(messages[1]).toContain("Nenhuma vaga nova");
  });

  it("splits 41 vacancies into messages of 20, 20 and 1", async () => {
    const repository = new PostingsRepository(db);
    for (let index = 0; index < 41; index++)
      repository.upsert(posting(String(index), new Date("2026-01-01")));
    const messages: string[] = [];
    const outcome = await deliverJobRadar(
      db,
      {
        sendText: async (text) => {
          messages.push(text);
          return { ok: true as const };
        },
      },
      config,
    );
    expect(outcome.delivered).toBe(41);
    expect(
      messages.map((text) => (text.match(/Cargo:/g) ?? []).length),
    ).toEqual([20, 20, 1]);
    expect(repository.findUnnotified()).toHaveLength(0);
  });

  it("keeps only the failed batch pending after partial delivery", async () => {
    const repository = new PostingsRepository(db);
    for (let index = 0; index < 21; index++)
      repository.upsert(posting(String(index), new Date("2026-01-01")));
    let sends = 0;
    const outcome = await deliverJobRadar(
      db,
      {
        sendText: async () =>
          ++sends === 1
            ? { ok: true as const }
            : { ok: false as const, error: { message: "offline" } },
      },
      config,
    );
    expect(outcome.delivered).toBe(20);
    expect(outcome.error).toBe("offline");
    expect(repository.claimForScoring("retry", new Date())).toHaveLength(1);
  });

  it("filters rejected vacancies, releases their claims and retries failed delivery", async () => {
    const repository = new PostingsRepository(db);
    repository.upsert(posting("eligible", new Date("2026-01-02")));
    repository.upsert({
      ...posting("degree", new Date("2026-01-03")),
      description: "Ensino médio completo. Superior obrigatório.",
    });
    const failed = await deliverJobRadar(
      db,
      {
        sendText: async () => ({
          ok: false as const,
          error: { message: "offline" },
        }),
      },
      config,
    );
    expect(failed.delivered).toBe(0);
    const messages: string[] = [];
    const result = await deliverJobRadar(
      db,
      {
        sendText: async (text: string) => {
          messages.push(text);
          return { ok: true as const };
        },
      },
      config,
    );
    expect(result.delivered).toBe(1);
    expect(messages[0]).toContain("Assistente eligible");
    expect(messages[0]).not.toContain("Assistente degree");
    expect(
      repository.claimForScoring("next", new Date()).map((p) => p.sourceId),
    ).toEqual(["degree"]);
  });
});

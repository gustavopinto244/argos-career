import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { postings } from "../../src/persistence/infrastructure/schema";
import {
  CollectorResolver,
  computeRecencyWindowDays,
  describeUrlShape,
  executeCollect,
  executeDedup,
  executeDeliver,
  executeIngestExternal,
  executeStudyPlan,
  type ExternalRawPosting,
} from "../../src/cli/main";
import { createPosting, Posting } from "../../src/posting/domain/posting";
import { normalizeLinkedinAlertJob } from "../../src/posting/infrastructure/linkedin-alert-normalizer";
import { Taxonomy } from "../../src/market/domain/taxonomy";
import { TextNotifier } from "../../src/delivery/infrastructure/telegram-notifier";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../src/persistence/infrastructure/postings-repository";
import {
  parsePostingEventMetadata,
  PostingEventsRepository,
} from "../../src/persistence/infrastructure/posting-events-repository";
import {
  parseScoreFailureCounts,
  RunsRepository,
  parseFailedSources,
  parseTruncatedSources,
} from "../../src/persistence/infrastructure/runs-repository";
import {
  CollectionResult,
  CollectorPort,
} from "../../src/posting/domain/ports/collector.port";
import { Criteria } from "../../src/prefilter/domain/criteria";
import { Profile } from "../../src/profile/domain/profile";
import { StubScorer } from "../../src/scoring/infrastructure/stub-scorer";
import { ScorerPort } from "../../src/scoring/domain/ports/scorer.port";
import { Digest } from "../../src/delivery/domain/digest";
import {
  NotifierPort,
  NotifyResult,
} from "../../src/delivery/domain/ports/notifier.port";

// No test makes a real network call (docs/07-testing-strategy.md) — the
// collector is a stub, never GupyCollector.

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-cli-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stubCollector(result: CollectionResult): CollectorPort {
  return { collect: async () => result };
}

function gupyPayload(id: number, name: string, careerPageName = "Empresa X") {
  return { id, name, careerPageName };
}

describe("executeCollect", () => {
  it("normalizes and upserts every valid posting, recording a successful run", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        { source: "gupy", sourceId: "1", payload: gupyPayload(1, "Estágio A") },
        { source: "gupy", sourceId: "2", payload: gupyPayload(2, "Estágio B") },
      ],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.collected).toBe(2);
    expect(outcome.normalized).toBe(2);
    expect(outcome.isNew).toBe(2);
    expect(outcome.alreadySeen).toBe(0);

    const runsRepo = new RunsRepository(db);
    const run = runsRepo.findById(outcome.runId);
    expect(run?.outcome).toBe("success");
    expect(run?.newCount).toBe(2);

    // docs/audit PR-021: collection had no posting_events coverage at all
    // before this -- a posting's fate before scoring was previously only
    // answerable from the run-level aggregate, never per-posting.
    const events = new PostingEventsRepository(db).findByRun(outcome.runId);
    const collectEvents = events.filter((e) => e.stage === "collect");
    expect(collectEvents).toHaveLength(2);
    expect(collectEvents.every((e) => e.outcome === "new")).toBe(true);
  });

  it("reports already-seen postings on a second run over the same source data", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        { source: "gupy", sourceId: "1", payload: gupyPayload(1, "Estágio A") },
      ],
    });

    await executeCollect(db, () => collector, [{}], undefined, 0);
    const second = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(second.isNew).toBe(0);
    expect(second.alreadySeen).toBe(1);

    const events = new PostingEventsRepository(db).findByRun(second.runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe("collect");
    expect(events[0]?.outcome).toBe("already_seen");
  });

  it("skips a normalize failure without failing the whole run", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        { source: "gupy", sourceId: "1", payload: gupyPayload(1, "Estágio A") },
        { source: "gupy", sourceId: "2", payload: { nothingUseful: true } },
      ],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.collected).toBe(2);
    expect(outcome.normalized).toBe(1);
  });

  it("records a failed run and returns the error when the collector itself fails, never throwing", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
      error: { message: "Gupy responded 500" },
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.error).toBe("Gupy responded 500");

    const runsRepo = new RunsRepository(db);
    expect(runsRepo.findById(outcome.runId)?.outcome).toBe("failed");
  });
});

describe("executeCollect — multi-query cycles", () => {
  /** Records each query it is asked for, answering with one posting each. */
  function recordingCollector(errorOn: number[] = []): {
    collector: CollectorPort;
    queries: unknown[];
  } {
    const queries: unknown[] = [];
    return {
      queries,
      collector: {
        collect: async (criteria: unknown): Promise<CollectionResult> => {
          const index = queries.length;
          queries.push(criteria);
          if (errorOn.includes(index)) {
            return {
              source: "gupy",
              collectedAt: new Date(),
              postings: [],
              error: new Error(`query ${index} failed`),
            };
          }
          return {
            source: "gupy",
            collectedAt: new Date(),
            postings: [
              {
                source: "gupy",
                sourceId: String(index),
                payload: gupyPayload(index, `Estágio ${index}`),
              },
            ],
          };
        },
      },
    };
  }

  it("issues every configured query and folds them into ONE run row", async () => {
    const { collector, queries } = recordingCollector();
    const outcome = await executeCollect(
      db,
      () => collector,
      [{ jobName: "estágio", city: "Rio de Janeiro" }, { isRemoteWork: true }],
      undefined,
      0,
    );

    expect(queries).toEqual([
      { jobName: "estágio", city: "Rio de Janeiro" },
      { isRemoteWork: true },
    ]);
    expect(outcome.collected).toBe(2);
    expect(outcome.isNew).toBe(2);

    // One cycle is one run — anything that counts runs (the digest summary,
    // the consecutive-empty-collection alert) depends on this.
    const runs = new RunsRepository(db).findRecent("collect", 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.collectedCount).toBe(2);
  });

  it("keeps what succeeded when one query fails, and stays a success", async () => {
    const { collector } = recordingCollector([0]);
    const outcome = await executeCollect(
      db,
      () => collector,
      [{}, {}],
      undefined,
      0,
    );

    expect(outcome.error).toBe("query 0 failed");
    expect(outcome.isNew).toBe(1); // the surviving query still persisted
    const run = new RunsRepository(db).findById(outcome.runId);
    // Degraded, not down (principle 1): one dead query out of two must not
    // look identical to a dead source, or the collection-health alert fires
    // on a healthy cycle.
    expect(run?.outcome).toBe("success");
  });

  it("marks the run failed only when every query fails", async () => {
    const { collector } = recordingCollector([0, 1]);
    const outcome = await executeCollect(
      db,
      () => collector,
      [{}, {}],
      undefined,
      0,
    );

    expect(outcome.error).toBe("query 0 failed");
    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.outcome).toBe("failed");
  });
});

describe("computeRecencyWindowDays (docs/audit AC-028 — gap-aware recovery)", () => {
  const WINDOW = { recencyDays: 1, backfillDays: 7 };
  const NOW = new Date("2026-08-15T12:00:00Z");

  it("uses backfillDays when there is no successful collect on record", () => {
    expect(computeRecencyWindowDays(null, NOW, WINDOW)).toBe(7);
  });

  it("uses recencyDays for a normal gap (a few hours since the last success)", () => {
    const lastSuccess = new Date("2026-08-15T08:00:00Z"); // 4h before NOW
    expect(computeRecencyWindowDays(lastSuccess, NOW, WINDOW)).toBe(1);
  });

  it("widens to cover the actual gap after an outage longer than recencyDays", () => {
    const lastSuccess = new Date("2026-08-12T12:00:00Z"); // 3 days before NOW
    expect(computeRecencyWindowDays(lastSuccess, NOW, WINDOW)).toBe(3);
  });

  it("caps the widened window at backfillDays — no unbounded recovery", () => {
    const lastSuccess = new Date("2026-08-01T12:00:00Z"); // 14 days before NOW
    expect(computeRecencyWindowDays(lastSuccess, NOW, WINDOW)).toBe(7);
  });
});

describe("executeCollect — recency window (ADR-019)", () => {
  const WINDOW = { recencyDays: 1, backfillDays: 7 };

  /** Gupy payload carrying an explicit publication date. */
  function datedPayload(
    id: number,
    name: string,
    publishedDate: string | null,
  ) {
    const base = gupyPayload(id, name);
    return publishedDate === null ? base : { ...base, publishedDate };
  }

  function collectorWith(payloads: unknown[]): CollectorPort {
    return {
      collect: async () => ({
        source: "gupy",
        collectedAt: new Date(),
        postings: payloads.map((payload, i) => ({
          source: "gupy",
          sourceId: String(i),
          payload,
        })),
      }),
    };
  }

  it("drops a posting published before the window and keeps a fresh one", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    // Seed a successful collect so this is NOT treated as a first run.
    await executeCollect(
      db,
      () => collectorWith([]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(1, "Estágio Fresco", "2026-08-15T06:00:00Z"),
          datedPayload(2, "Estágio Velho", "2026-07-01T06:00:00Z"),
        ]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(1);

    const events = new PostingEventsRepository(db).findByRun(outcome.runId);
    const tooOldEvents = events.filter((e) => e.outcome === "too_old");
    expect(tooOldEvents).toHaveLength(1);
    expect(tooOldEvents[0]?.stage).toBe("collect");
    expect(tooOldEvents[0]?.reason).toMatch(/publishedAt.*before cutoff/);
  });

  it("keeps a posting the source never dated — absence is not evidence of age", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    await executeCollect(
      db,
      () => collectorWith([]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    const outcome = await executeCollect(
      db,
      () => collectorWith([datedPayload(3, "Estágio Sem Data", null)]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });

  it("uses the wider backfill window when no successful collect exists yet", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    // Four days old: outside recencyDays (1), inside backfillDays (7).
    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(4, "Estágio de 4 dias", "2026-08-11T12:00:00Z"),
        ]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });

  it("recovers a posting published during a multi-day outage instead of losing it (docs/audit AC-028)", async () => {
    const lastSuccessAt = new Date("2026-08-12T12:00:00Z");
    await executeCollect(
      db,
      () => collectorWith([]),
      [{}],
      () => lastSuccessAt,
      0,
      WINDOW,
    );

    // The app was down for 3 days; this run is the first since the outage.
    // A posting published 2 days ago is outside recencyDays (1) but inside
    // the actual gap since the last success — the honest fix ADR-019 named
    // and deferred.
    const now = new Date("2026-08-15T12:00:00Z");
    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(
            6,
            "Estágio Publicado no Apagão",
            "2026-08-13T12:00:00Z",
          ),
        ]),
      [{}],
      () => now,
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });

  it("applies no window at all when none is configured", async () => {
    const outcome = await executeCollect(
      db,
      () =>
        collectorWith([
          datedPayload(5, "Estágio Antigo", "2020-01-01T00:00:00Z"),
        ]),
      [{}],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });
});

describe("executeCollect — per-source recency window (docs/audit PR-003)", () => {
  const WINDOW = { recencyDays: 1, backfillDays: 10 };

  function indeedPayload(title: string, company: string, datePosted: string) {
    return { id: title, title, company, date_posted: datePosted };
  }

  /** gupy always succeeds with whatever postings are given it; indeed
   * either fails outright or succeeds with the given postings, so a test
   * can control each source's health independently across several runs. */
  function collectorFor(
    indeedOutcome: { failed: true } | { failed: false; postings: unknown[] },
  ): CollectorResolver {
    return (source: string) => ({
      collect: async () => {
        if (source === "gupy") {
          return { source: "gupy", collectedAt: new Date(), postings: [] };
        }
        return indeedOutcome.failed
          ? {
              source: "indeed",
              collectedAt: new Date(),
              postings: [],
              error: { message: "Indeed unreachable" },
            }
          : {
              source: "indeed",
              collectedAt: new Date(),
              postings: indeedOutcome.postings.map((payload, i) => ({
                source: "indeed",
                sourceId: String(i),
                payload,
              })),
            };
      },
    });
  }

  const day = (n: number) => new Date(`2026-08-1${n}T12:00:00Z`);

  it("recovers a posting from a source down for days, even though another source stayed healthy and kept every run 'success'", async () => {
    // Day 0: both sources succeed -- establishes each one's own baseline.
    await executeCollect(
      db,
      collectorFor({ failed: false, postings: [] }),
      [{ source: "gupy" }, { source: "indeed" }],
      () => day(0),
      0,
      WINDOW,
    );

    // Days 1-3: gupy keeps succeeding (so the run's own aggregate outcome
    // is "success" every single time -- executeCollect's allFailed is only
    // true when EVERY query fails), while indeed fails every time. Under
    // the old global-window bug, findLatestFinished("collect", "success")
    // would keep advancing on gupy's success alone, hiding indeed's outage
    // entirely.
    for (let n = 1; n <= 3; n++) {
      await executeCollect(
        db,
        collectorFor({ failed: true }),
        [{ source: "gupy" }, { source: "indeed" }],
        () => day(n),
        0,
        WINDOW,
      );
    }

    // Day 4: indeed recovers, reporting a posting published on day 1 --
    // 3 days before now. Outside recencyDays (1), which is all the old
    // global logic would have granted (the "last successful run" was
    // yesterday, day 3, since gupy carried it). Inside the real gap since
    // indeed's own last success (day 0, 4 days ago), which is what a
    // correct per-source window must grant instead.
    const outcome = await executeCollect(
      db,
      collectorFor({
        failed: false,
        postings: [
          indeedPayload(
            "Estágio Indeed Publicado no Apagão",
            "Empresa Y",
            day(1).toISOString(),
          ),
        ],
      }),
      [{ source: "gupy" }, { source: "indeed" }],
      () => day(4),
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.tooOld).toBe(0);
  });

  it("still applies the ordinary short window to the source that stayed healthy throughout", async () => {
    await executeCollect(
      db,
      collectorFor({ failed: false, postings: [] }),
      [{ source: "gupy" }, { source: "indeed" }],
      () => day(0),
      0,
      WINDOW,
    );
    for (let n = 1; n <= 3; n++) {
      await executeCollect(
        db,
        collectorFor({ failed: true }),
        [{ source: "gupy" }, { source: "indeed" }],
        () => day(n),
        0,
        WINDOW,
      );
    }

    // gupy has been succeeding every single run -- its own window on day 4
    // should still be the ordinary recencyDays (1), not the wide gap
    // indeed earned. A posting from day 1 (3 days old) must be dropped for
    // gupy specifically, proving the two sources' windows are independent,
    // not both accidentally widened together.
    const collector = (source: string) => ({
      collect: async () => {
        if (source === "indeed") {
          return { source: "indeed", collectedAt: new Date(), postings: [] };
        }
        return {
          source: "gupy",
          collectedAt: new Date(),
          postings: [
            {
              source: "gupy",
              sourceId: "1",
              payload: {
                ...gupyPayload(1, "Estágio Gupy Antigo"),
                publishedDate: day(1).toISOString(),
              },
            },
          ],
        };
      },
    });

    const outcome = await executeCollect(
      db,
      collector,
      [{ source: "gupy" }, { source: "indeed" }],
      () => day(4),
      0,
      WINDOW,
    );

    expect(outcome.normalized).toBe(0);
    expect(outcome.tooOld).toBe(1);
  });
});

describe("executeCollect — collector dispatch by source", () => {
  it("routes each query to the collector its source names", async () => {
    const asked: string[] = [];
    const make = (name: string): CollectorPort => ({
      collect: async () => {
        asked.push(name);
        return { source: name, collectedAt: new Date(), postings: [] };
      },
    });
    const registry: Record<string, CollectorPort> = {
      gupy: make("gupy"),
      ciee: make("ciee"),
    };

    await executeCollect(
      db,
      (source) => registry[source] ?? null,
      [{ source: "ciee" }, { source: "gupy" }, { source: "ciee" }],
      undefined,
      0,
    );

    expect(asked).toEqual(["ciee", "gupy", "ciee"]);
  });

  it("closes the run as failed when resolving a collector throws", async () => {
    // Collectors themselves cannot throw (principle 1), so the reachable
    // throw inside `executeCollect` is everything around them — resolution,
    // and the database writes. Either way the run row must not be left open;
    // see the matching test for `executeDeliver`.
    await expect(
      executeCollect(
        db,
        () => {
          throw new Error("registry exploded");
        },
        [{ source: "gupy" }],
        undefined,
        0,
      ),
    ).rejects.toThrow("registry exploded");

    const [run] = new RunsRepository(db).findRecent("collect", 1);
    expect(run?.outcome).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
  });

  it("defaults a query with no source to gupy", async () => {
    const asked: string[] = [];
    await executeCollect(
      db,
      (source) => {
        asked.push(source);
        return {
          collect: async () => ({
            source,
            collectedAt: new Date(),
            postings: [],
          }),
        };
      },
      [{ jobName: "estágio" }],
      undefined,
      0,
    );

    expect(asked).toEqual(["gupy"]);
  });

  it("reports an unregistered source rather than dying on a config typo", async () => {
    const outcome = await executeCollect(
      db,
      () => null,
      [{ source: "gupq" }],
      undefined,
      0,
    );

    expect(outcome.error).toContain(
      'No collector registered for source "gupq"',
    );
    expect(outcome.collected).toBe(0);
  });

  it("records the failed source and failure reason on the run row (docs/11 B2)", async () => {
    const outcome = await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "indeed",
          collectedAt: new Date(),
          postings: [],
          error: { message: "Indeed responded 500" },
        }),
      }),
      [{ source: "indeed" }],
      undefined,
      0,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.failureReason).toBe("Indeed responded 500");
    expect(parseFailedSources(run!)).toEqual(["indeed"]);
  });

  it("still normalizes and persists postings a collector returned alongside an error (docs/audit AC-004)", async () => {
    // A page-2+ failure must not erase page 1's valid results — the
    // collector reports both `postings` (whatever succeeded) and `error`
    // (what failed after) in the same CollectionResult.
    const outcome = await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "gupy",
          collectedAt: new Date(),
          postings: [
            {
              source: "gupy",
              sourceId: "1",
              payload: gupyPayload(1, "Estágio A"),
            },
          ],
          error: { message: "Gupy responded 500 on page 2" },
        }),
      }),
      [{ source: "gupy" }],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.isNew).toBe(1);

    const postingsRepo = new PostingsRepository(db);
    expect(postingsRepo.findActive()).toHaveLength(1);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.failureReason).toBe("Gupy responded 500 on page 2");
    expect(run?.normalizedCount).toBe(1);
  });

  it("leaves failedSources empty on the run row when every query succeeds", async () => {
    const outcome = await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "gupy",
          collectedAt: new Date(),
          postings: [],
        }),
      }),
      [{ source: "gupy" }],
      undefined,
      0,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.failureReason).toBeNull();
    expect(parseFailedSources(run!)).toEqual([]);
  });
});

describe("executeCollect — multi-source dispatch", () => {
  it("normalizes each source with its own normalizer in one cycle", async () => {
    // The bug this guards: executeCollect used to call normalizeGupyJob
    // directly, so a second source's payloads were handed to Gupy's schema,
    // failed validation and vanished — indistinguishable from an empty
    // source.
    const collector: CollectorPort = {
      collect: async (criteria) => {
        const which = (criteria as { source?: string }).source;
        return which === "ciee"
          ? {
              source: "ciee",
              collectedAt: new Date(),
              postings: [
                {
                  source: "ciee",
                  sourceId: "9000001",
                  payload: {
                    codigoVaga: 9000001,
                    tipoVaga: "ESTAGIO",
                    nomeEmpresa: "ALFA SERVICOS DIGITAIS LTDA",
                    areaProfissional: "Informática",
                    nivelEscolar: "SU",
                    local: { cidade: "Rio de Janeiro", uf: "RJ" },
                    atividades: ["Atividade exemplo"],
                  },
                },
              ],
            }
          : {
              source: "gupy",
              collectedAt: new Date(),
              postings: [
                {
                  source: "gupy",
                  sourceId: "1",
                  payload: gupyPayload(1, "Estágio em Backend"),
                },
              ],
            };
      },
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{ source: "gupy" }, { source: "ciee" }],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(2);
    expect(outcome.unnormalizable).toBe(0);
    expect(outcome.error).toBeUndefined();

    const titles = new PostingsRepository(db)
      .findActive()
      .map((p) => p.title)
      .sort();
    expect(titles).toEqual(["Estágio em Backend", "Estágio em Informática"]);
  });

  it("reports an unregistered source as a wiring bug, not an empty source", async () => {
    const collector: CollectorPort = {
      collect: async () => ({
        source: "jooble",
        collectedAt: new Date(),
        postings: [
          { source: "jooble", sourceId: "1", payload: { anything: true } },
        ],
      }),
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(0);
    expect(outcome.unnormalizable).toBe(1);
    expect(outcome.error).toContain("No normalizer registered");
  });

  it("counts an item the normalizer rejects as unnormalizable, not silently (docs/audit AC-012)", async () => {
    // The bug this guards: a registered normalizer returning null (as
    // opposed to no normalizer being registered at all) was not counted
    // anywhere on this internal path — executeIngestExternal already
    // counted the equivalent case correctly.
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio válido"),
        },
        // careerPageName empty -> normalizeGupyJob returns null
        {
          source: "gupy",
          sourceId: "2",
          payload: gupyPayload(2, "Sem empresa", ""),
        },
      ],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.unnormalizable).toBe(1);
    expect(outcome.error).toBeUndefined();

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.unnormalizableCount).toBe(1);
  });

  it("sums receivedCount and schemaRejectedCount across collectors (docs/audit AC-012)", async () => {
    const collector: CollectorPort = {
      collect: async () => ({
        source: "gupy",
        collectedAt: new Date(),
        postings: [
          { source: "gupy", sourceId: "1", payload: gupyPayload(1, "x") },
        ],
        receivedCount: 5,
        schemaRejectedCount: 3,
      }),
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{ source: "gupy" }, { source: "gupy" }],
      undefined,
      0,
    );

    expect(outcome.received).toBe(10);
    expect(outcome.schemaRejected).toBe(6);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.receivedCount).toBe(10);
    expect(run?.schemaRejectedCount).toBe(6);
  });

  it("reports received/schemaRejected as null, not a false 0, when a collector does not report them (docs/audit PR-014)", async () => {
    // Reversing this test's own prior name and expectation: a run where a
    // collector cannot report these counts used to look identical to one
    // that genuinely received zero items. null is the honest "unreconcilable
    // this run," never silently folded into the sum.
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.received).toBeNull();
    expect(outcome.schemaRejected).toBeNull();

    const run = new RunsRepository(db).findRecent("collect", 1)[0];
    expect(run?.receivedCount).toBeNull();
    expect(run?.schemaRejectedCount).toBeNull();
  });

  it("stays null if any query in the run cannot report a count, even when others can (docs/audit PR-014)", async () => {
    let call = 0;
    const collector = {
      collect: async () => {
        call += 1;
        return call === 1
          ? {
              source: "gupy",
              collectedAt: new Date(),
              postings: [],
              receivedCount: 5,
              schemaRejectedCount: 1,
            }
          : { source: "gupy", collectedAt: new Date(), postings: [] };
      },
    };

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}, {}],
      undefined,
      0,
    );

    expect(outcome.received).toBeNull();
    expect(outcome.schemaRejected).toBeNull();
  });

  it("records which source(s) reported truncation (docs/audit AC-013)", async () => {
    const registry: Record<string, CollectorPort> = {
      gupy: {
        collect: async () => ({
          source: "gupy",
          collectedAt: new Date(),
          postings: [
            { source: "gupy", sourceId: "1", payload: gupyPayload(1, "x") },
          ],
          truncated: true,
        }),
      },
      ciee: {
        collect: async () => ({
          source: "ciee",
          collectedAt: new Date(),
          postings: [],
          truncated: false,
        }),
      },
    };

    const outcome = await executeCollect(
      db,
      (source) => registry[source] ?? null,
      [{ source: "gupy" }, { source: "ciee" }],
      undefined,
      0,
    );

    expect(outcome.truncatedSources).toEqual(["gupy"]);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(parseTruncatedSources(run!)).toEqual(["gupy"]);
  });

  it("leaves truncatedSources empty when no collector reports it", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
    });

    const outcome = await executeCollect(
      db,
      () => collector,
      [{}],
      undefined,
      0,
    );

    expect(outcome.truncatedSources).toEqual([]);
    const run = new RunsRepository(db).findById(outcome.runId);
    expect(parseTruncatedSources(run!)).toEqual([]);
  });
});

describe("executeDedup", () => {
  it("scans the corpus and records a run without touching a collector", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio Back-End"),
        },
        {
          source: "gupy",
          sourceId: "2",
          payload: gupyPayload(2, "Estágio Back End (Rio de Janeiro)"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const outcome = executeDedup(db);

    expect(outcome.scanned).toBe(2);
    // Shadow mode (docs/audit PR-006): logged, not merged — both stay active.
    expect(outcome.markedDuplicate).toBe(0);
    expect(outcome.shadowCandidateCount).toBe(1);

    const postingsRepo = new PostingsRepository(db);
    expect(postingsRepo.findActive()).toHaveLength(2);
  });

  it("is independently re-runnable — a second run over an unchanged corpus marks nothing new", () => {
    const first = executeDedup(db);
    const second = executeDedup(db);

    expect(first.scanned).toBe(0);
    expect(second.markedDuplicate).toBe(0);
  });
});

function deliverCriteria(): Criteria {
  return {
    collection: {
      queries: [{ source: "gupy" }],
      queryIntervalMs: 0,
      recencyDays: 1,
      backfillDays: 7,
    },
    titleBlocklist: [],
    titleRequired: ["estágio"],
    location: { cities: [], allowRemote: true, nationwideSources: [] },
    blockedCompanies: [],
    minKeywordAdherence: 0,
    maxAgeDays: null,
    undatedBacklogCutoverAt: null,
    maxFutureSkewDays: 1,
    tracks: { dev: ["backend"], security: [], automation: [], data: [] },
    trackExclusions: { dev: [], security: [], automation: [], data: [] },
    rejectUnknownTrack: false,
    schedule: {
      collection: { intervalHours: 4 },
      scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    },
    alerts: {
      consecutiveEmptyCollectionRuns: 2,
      scoreFailureRateThreshold: 0.5,
      sourceFreshnessHours: {},
    },
    trackWeights: {
      dev: 1.0,
      security: 1.0,
      automation: 0.7,
      data: 0.7,
      unknown: 0.4,
    },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
      unknownTrackCapScore: 50,
      stageBConcurrency: 8,
      ignoredProviders: [],
    },
  };
}

function deliverProfile(): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
    workAvailability: "40h remoto, disponível dias úteis.",
    competencies: [
      {
        name: "Node.js",
        tracks: ["dev"],
        aliases: [],
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

/** Records every digest it receives instead of sending anything. */
function recordingNotifier(result: NotifyResult = { ok: true }): {
  notifier: NotifierPort;
  digests: Digest[];
} {
  const digests: Digest[] = [];
  return {
    digests,
    notifier: {
      notify: async (digest: Digest) => {
        digests.push(digest);
        return result;
      },
    },
  };
}

describe("describeUrlShape (ADR-064)", () => {
  it("distinguishes the link shape the normalizer accepts from the one it rejects", () => {
    // The single question the LinkedIn fix turns on. Both are real shapes:
    // the canonical alert link, and LinkedIn's email tracking redirect.
    expect(
      describeUrlShape("https://www.linkedin.com/jobs/view/4451703964/"),
    ).toMatchObject({
      host: "www.linkedin.com",
      pathTemplate: "/jobs/view/<digits>",
      hasJobsViewPath: true,
    });
    expect(
      describeUrlShape("https://www.linkedin.com/e/v2?e=tok"),
    ).toMatchObject({
      pathTemplate: "/e/v2",
      hasJobsViewPath: false,
      hasQuery: true,
    });
  });

  it("survives a /comm/-prefixed link with tracking parameters", () => {
    expect(
      describeUrlShape(
        "https://www.linkedin.com/comm/jobs/view/4451703964/?trk=eml-jobs_jymbii",
      ),
    ).toMatchObject({
      pathTemplate: "/comm/jobs/view/<digits>",
      hasJobsViewPath: true,
      hasQuery: true,
    });
  });

  it("names each way a link can be absent, since they are different bugs", () => {
    // "n8n sent no Link key" and "n8n sent an empty Link" call for different
    // fixes in different places; one `kind` for both would hide that.
    expect(describeUrlShape(undefined)).toEqual({ kind: "absent" });
    expect(describeUrlShape(null)).toEqual({ kind: "null" });
    expect(describeUrlShape("   ")).toEqual({ kind: "empty" });
    expect(describeUrlShape(42)).toEqual({
      kind: "not-a-string",
      valueType: "number",
    });
  });

  it("still answers the normalizer's predicate for a link URL cannot parse", () => {
    expect(describeUrlShape("/jobs/view/4451703964/")).toEqual({
      kind: "unparseable",
      hasJobsViewPath: true,
    });
  });

  it("masks path segments that could carry identity, and never the query", () => {
    const shape = describeUrlShape(
      "https://example.com/u/aVeryLongOpaqueTokenSegment123456/x?token=secret",
    ) as Record<string, unknown>;

    expect(shape.pathTemplate).toBe("/u/<opaque>/x");
    expect(shape.hasQuery).toBe(true);
    // The whole reason this function exists instead of storing the link.
    expect(JSON.stringify(shape)).not.toContain("secret");
    expect(JSON.stringify(shape)).not.toContain("aVeryLongOpaqueTokenSegment");
  });

  it("bounds how much of a long path it describes", () => {
    const shape = describeUrlShape(
      `https://example.com/${Array.from({ length: 20 }, (_, i) => `s${i}`).join("/")}`,
    ) as { pathTemplate: string };
    expect(shape.pathTemplate.split("/").filter(Boolean)).toHaveLength(8);
  });
});

describe("executeIngestExternal", () => {
  const NOW = new Date("2026-08-16T14:00:00Z");

  /** A minimal, faithful stand-in for `normalizeIndeedJob` — the point of
   * this suite is `executeIngestExternal`'s own loop/bookkeeping, not the
   * real normalizer, which has its own test file. */
  function fakeNormalizer(): {
    normalize: (
      raw: { source: string; sourceId: string; payload: unknown },
      now: Date,
    ) => Posting | null;
    calls: unknown[];
  } {
    const calls: unknown[] = [];
    return {
      calls,
      normalize: (raw, now) => {
        calls.push(raw.payload);
        const payload = raw.payload as { title?: string; company?: string };
        if (!payload.title || !payload.company) return null;
        return createPosting({
          source: raw.source,
          sourceId: raw.sourceId,
          company: payload.company,
          title: payload.title,
          location: { kind: "unknown" },
          workMode: "unknown",
          collectedAt: now,
          firstSeenAt: now,
          lastSeenAt: now,
          rawPayload: payload,
        });
      },
    };
  }

  it("normalizes and upserts a batch, recording one 'collect' run", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [
        { sourceId: "in-1", payload: { title: "Estágio A", company: "X" } },
        { sourceId: "in-2", payload: { title: "Estágio B", company: "Y" } },
      ],
      () => NOW,
    );

    expect(outcome.collected).toBe(2);
    expect(outcome.normalized).toBe(2);
    expect(outcome.isNew).toBe(2);
    expect(outcome.alreadySeen).toBe(0);
    expect(outcome.unnormalizable).toBe(0);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.kind).toBe("collect");
    expect(run?.outcome).toBe("success");

    const stored = new PostingsRepository(db).findActive();
    expect(stored).toHaveLength(2);
    expect(stored.map((p) => p.source)).toEqual(["indeed", "indeed"]);
  });

  it("leaves receivedCount/schemaRejectedCount null, not a false 0 -- external ingest has no reconcilable raw count of its own (docs/audit PR-014)", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.receivedCount).toBeNull();
    expect(run?.schemaRejectedCount).toBeNull();
  });

  it("records the caller-supplied truncated flag on the run row (docs/audit PR-015)", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
      true,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(parseTruncatedSources(run!)).toEqual(["indeed"]);
  });

  it("defaults truncated to false when the caller omits it", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(parseTruncatedSources(run!)).toEqual([]);
  });

  it("treats a flat item with no payload key as the payload itself (docs/11 B15)", async () => {
    // Every rejected LinkedIn item in production recorded source_id as
    // null, not "" -- which rules out an envelope carrying an empty
    // sourceId, but leaves "envelope without sourceId" and "flat item,
    // no envelope at all" equally supported. B15's own fix covered the
    // first; this covers the second, so the path works whichever n8n
    // actually sends. Additive: a caller that does send `payload` (every
    // one in this repository) is unaffected.
    // The real LinkedIn normalizer, not the fake one above: the whole
    // point is whether the genuine production path survives this shape.
    const outcome = await executeIngestExternal(
      db,
      "linkedin",
      normalizeLinkedinAlertJob,
      [
        // Flat: the job's own fields, no { sourceId, payload } wrapper,
        // Title Case as the real pasted n8n row showed.
        {
          Title: "Estágio Backend",
          Company: "Empresa X",
          Location: "Rio de Janeiro, RJ (Híbrido)",
          Link: "https://www.linkedin.com/jobs/view/4451703964/",
        } as unknown as ExternalRawPosting,
      ],
      () => NOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.unnormalizable).toBe(0);

    const [stored] = new PostingsRepository(db).findActive();
    expect(stored?.company).toBe("Empresa X");
    // sourceId recovered from the link, since the flat shape carries none.
    expect(stored?.sourceId).toBe("4451703964");
  });

  it("records the run's unnormalizable count on the run row, not only in sourceQueryStats (ADR-064)", async () => {
    // The row that hid LinkedIn's 100% loss for eight days read
    // `collected: N, normalized: 0, unnormalizable: 0` — arithmetically
    // impossible, and indistinguishable from a source that sent nothing.
    const outcome = await executeIngestExternal(
      db,
      "linkedin",
      normalizeLinkedinAlertJob,
      [
        // The exact shape Atlas recorded: flat, Title Case, no sourceId,
        // and a link carrying no /jobs/view/<digits> to recover one from.
        {
          Title: "Estágio Backend",
          Company: "Empresa X",
          Location: "Rio de Janeiro, RJ (Híbrido)",
          Link: "https://www.linkedin.com/e/v2?e=tracking",
        } as unknown as ExternalRawPosting,
      ],
      () => NOW,
    );

    expect(outcome.normalized).toBe(0);
    expect(outcome.unnormalizable).toBe(1);

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.collectedCount).toBe(1);
    expect(run?.normalizedCount).toBe(0);
    expect(run?.unnormalizableCount).toBe(1);
  });

  it("records a rejected item's link shape, masked, so the next real ingest says why (ADR-064)", async () => {
    const outcome = await executeIngestExternal(
      db,
      "linkedin",
      normalizeLinkedinAlertJob,
      [
        {
          Title: "Estágio Backend",
          Company: "Empresa X",
          Location: "Rio de Janeiro, RJ (Híbrido)",
          Link: "https://www.linkedin.com/e/v2?e=account-identifying-token",
        } as unknown as ExternalRawPosting,
      ],
      () => NOW,
    );

    const [event] = new PostingEventsRepository(db).findByRun(outcome.runId);
    expect(event?.outcome).toBe("normalization_rejected");
    const metadata = parsePostingEventMetadata(event!) as {
      linkKey?: string;
      linkShape?: Record<string, unknown>;
    };

    expect(metadata.linkKey).toBe("Link");
    expect(metadata.linkShape).toMatchObject({
      kind: "url",
      host: "www.linkedin.com",
      pathTemplate: "/e/v2",
      hasQuery: true,
      // The predicate `deriveSourceIdFromLink` applies — false is exactly
      // the fact that explains the rejection.
      hasJobsViewPath: false,
    });
    // The boundary this diagnostic exists inside: the tracking token must
    // not survive anywhere in the recorded metadata.
    expect(JSON.stringify(metadata)).not.toContain("account-identifying-token");
  });

  it("counts an item the normalizer rejects as unnormalizable, not a thrown error", async () => {
    const { normalize } = fakeNormalizer();
    const outcome = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [
        { sourceId: "in-1", payload: { title: "Estágio A", company: "X" } },
        { sourceId: "in-2", payload: { title: "no company" } }, // rejected
      ],
      () => NOW,
    );

    expect(outcome.normalized).toBe(1);
    expect(outcome.unnormalizable).toBe(1);
    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.outcome).toBe("success");
  });

  it("re-ingesting the same sourceId upserts rather than duplicating", async () => {
    const { normalize } = fakeNormalizer();
    const first = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
    );
    expect(first.isNew).toBe(1);

    const second = await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      () => NOW,
    );
    expect(second.isNew).toBe(0);
    expect(second.alreadySeen).toBe(1);
    expect(new PostingsRepository(db).findActive()).toHaveLength(1);
  });

  it("closes the run as failed, not orphaned, when the normalizer throws", async () => {
    // Same bookkeeping guarantee executeCollect/executeDeliver already
    // carry (#49) — a throw between start and finish must not leave the
    // row open forever.
    const throwing = () => {
      throw new Error("boom");
    };

    await expect(
      executeIngestExternal(
        db,
        "indeed",
        throwing,
        [{ sourceId: "in-1", payload: {} }],
        () => NOW,
      ),
    ).rejects.toThrow("boom");

    const [run] = new RunsRepository(db).findRecent("collect", 1);
    expect(run?.outcome).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
  });
});

describe("executeDeliver", () => {
  it("runs its own dedup pass over a near-duplicate from external ingest before scoring, without a separate dedup run ever having been called (docs/audit AC-005, AC-010 Amendment 3)", async () => {
    // The exact scenario AC-005 names: Indeed/Catho/LinkedIn ingest via
    // executeIngestExternal, which normalizes/upserts but never runs
    // dedupSimilarPostings itself -- only the scheduler's own collection
    // cycle does, on its own schedule. Two near-duplicate postings land via
    // external ingest and executeDeliver is called directly, with no
    // executeDedup call anywhere in between.
    //
    // Shadow mode (docs/audit PR-006) changed what "catches" means here:
    // layer 2 no longer excludes the near-duplicate from scoring -- both
    // postings below get scored and delivered, same as if they were
    // genuinely distinct openings. What AC-005's atomic wrapping still
    // guarantees is that the scan happens at all, inside the same
    // transaction as the scoring claim, and is recorded: a shadow-candidate
    // `posting_events` row exists for the pair even though executeDeliver
    // was called directly, with no separate `executeDedup` in between.
    const normalize = (
      raw: { source: string; sourceId: string; payload: unknown },
      now: Date,
    ) => {
      const payload = raw.payload as { title: string; company: string };
      return createPosting({
        source: raw.source,
        sourceId: raw.sourceId,
        company: payload.company,
        title: payload.title,
        location: { kind: "unknown" },
        workMode: "unknown",
        collectedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        rawPayload: payload,
      });
    };
    await executeIngestExternal(db, "indeed", normalize, [
      {
        sourceId: "1",
        payload: { title: "Estágio Back-End", company: "Empresa X" },
      },
      {
        sourceId: "2",
        payload: {
          title: "Estágio Back End (Rio de Janeiro)",
          company: "Empresa X",
        },
      },
    ]);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    // Both near-duplicates reach scoring -- shadow mode never excludes.
    expect(outcome.filtered).toBe(2);
    expect(outcome.scored).toBe(2);

    const postingsRepo = new PostingsRepository(db);
    const active = postingsRepo.findActive();
    expect(active).toHaveLength(2);

    // But the internal dedup pass still ran and still logged the pair --
    // this is what AC-005's atomic wrapping actually guarantees now.
    const laterPosting = active.find((p) => p.sourceId === "2");
    const events = new PostingEventsRepository(db).findByFingerprint(
      laterPosting!.fingerprint,
    );
    expect(
      events.some(
        (e) =>
          e.stage === "dedup-similarity" && e.outcome === "shadow_candidate",
      ),
    ).toBe(true);
  });

  it("takes an unnotified posting end to end: pre-filter, score, digest, notify, mark notified", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.filtered).toBe(1);
    expect(outcome.scored).toBe(1);
    expect(outcome.delivered).toBe(1);
    expect(digests).toHaveLength(1);
    expect(digests[0]?.review).toHaveLength(1);

    const postingsRepo = new PostingsRepository(db);
    const [posting] = postingsRepo.findActive();
    expect(posting?.company).toBe("Empresa X");

    const runsRepo = new RunsRepository(db);
    const run = runsRepo.findById(outcome.runId);
    expect(run?.outcome).toBe("success");
    expect(run?.deliveredCount).toBe(1);
  });

  it("routes a periodGate result to the digest's periodBlocked section, not review/discard (period-gate.ts)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const periodGateScorer: ScorerPort = {
      score: async () => ({
        ok: true,
        score: 35,
        verdict: "discard",
        breakdown: {
          mandatoryCoverage: 1,
          desirableCoverage: 1,
          trackAlignment: 1,
        },
        blockingFailure: {
          text: "Estar cursando a partir do 4º período.",
          category: "academic",
          weight: "blocking",
        },
        blockingFailures: [
          {
            text: "Estar cursando a partir do 4º período.",
            category: "academic",
            weight: "blocking",
          },
        ],
        lowConfidence: false,
        criticalGaps: [],
        periodGate: { minimumPeriod: 4, opensAtLabel: "2027.2" },
        recommendedVariant: null,
        highlights: [],
        missingTerms: [],
        inputTruncated: false,
        stageACacheHit: false,
        stageBCacheHit: false,
        evidenceRejectedCount: 0,
      }),
    };
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      periodGateScorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBeUndefined();
    expect(digests).toHaveLength(1);
    expect(digests[0]?.recommended).toHaveLength(0);
    expect(digests[0]?.review).toHaveLength(0);
    expect(digests[0]?.periodBlocked).toEqual([
      expect.objectContaining({ opensAtLabel: "2027.2" }),
    ]);

    // Not marked notified — a period-blocked posting should surface again
    // every run until it actually opens, not be consumed like a real digest
    // entry (the same reasoning digest.ts's own doc comment states).
    const postingsRepo = new PostingsRepository(db);
    expect(postingsRepo.findUnnotified()).toHaveLength(1);
  });

  it("persists OpenRouter usage onto the run row when getUsage is provided (docs/audit AC-015)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();
    const getUsage = () => ({
      calls: 3,
      promptTokens: 100,
      completionTokens: 50,
      cachedPromptTokens: 10,
      costUsd: 0.0042,
      attempts: 4,
      attemptsByOutcome: {
        success: 3,
        timeout: 0,
        networkError: 0,
        rateLimited: 0,
        serverError: 1,
        providerError: 0,
        authError: 0,
        configError: 0,
        requestError: 0,
        invalidEnvelope: 0,
        invalidOutput: 0,
        httpError: 0,
      },
      attemptsByStageOutcome: {
        "stage-a": {
          success: 0,
          timeout: 0,
          networkError: 0,
          rateLimited: 0,
          serverError: 0,
          providerError: 0,
          authError: 0,
          configError: 0,
          requestError: 0,
          invalidEnvelope: 0,
          invalidOutput: 0,
          httpError: 0,
        },
        "stage-b": {
          success: 0,
          timeout: 0,
          networkError: 0,
          rateLimited: 0,
          serverError: 0,
          providerError: 0,
          authError: 0,
          configError: 0,
          requestError: 0,
          invalidEnvelope: 0,
          invalidOutput: 0,
          httpError: 0,
        },
        unknown: {
          success: 2,
          timeout: 1,
          networkError: 0,
          rateLimited: 0,
          serverError: 0,
          providerError: 0,
          authError: 0,
          configError: 0,
          requestError: 0,
          invalidEnvelope: 0,
          invalidOutput: 0,
          httpError: 0,
        },
      },
      providerCounts: {},
      errorTypeCounts: {},
      attemptsWithoutUsage: 1,
      blockedByCircuit: 0,
    });

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
      getUsage,
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.llmAttempts).toBe(4);
    expect(run?.llmCostUsd).toBeCloseTo(0.0042);
    expect(run?.llmAttemptsWithoutUsage).toBe(1);
  });

  it("leaves llm usage columns at 0 when no getUsage is provided (the stub-adapter path)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    const run = new RunsRepository(db).findById(outcome.runId);
    expect(run?.llmAttempts).toBe(0);
    expect(run?.llmCostUsd).toBe(0);
  });

  it("closes the run as failed when the scorer throws, instead of leaving it open forever", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const { notifier } = recordingNotifier();
    // `ScorerPort` forbids this (ADR-006), and on 2026-08-16 `ApiScorer` did
    // it anyway: a prompt template missing from the image threw straight
    // through. What matters here is not the throw but the bookkeeping — the
    // run row must not survive as `finishedAt: null`, which `/health` reads
    // as "still running" and `findLatestFinished` skips.
    const throwingScorer: ScorerPort = {
      score: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    };

    await expect(
      executeDeliver(db, throwingScorer, notifier, criteria, deliverProfile()),
    ).rejects.toThrow("ENOENT");

    const runsRepo = new RunsRepository(db);
    const [run] = runsRepo.findRecent("scoreAndDeliver", 1);
    expect(run?.outcome).toBe("failed");
    expect(run?.finishedAt).not.toBeNull();
    // The pre-filter had already passed one posting before the throw; the
    // row records that rather than flattening the run to zeroes.
    expect(run?.filteredCount).toBe(1);
    expect(run?.scoredCount).toBe(0);
  });

  it("never notifies the same posting twice (ADR-007) — a second run finds nothing to deliver", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);

    const first = await executeDeliver(
      db,
      scorer,
      recordingNotifier().notifier,
      criteria,
      deliverProfile(),
    );
    const { notifier: secondNotifier, digests } = recordingNotifier();
    const second = await executeDeliver(
      db,
      scorer,
      secondNotifier,
      criteria,
      deliverProfile(),
    );

    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0);
    expect(digests[0]?.review).toHaveLength(0);
  });

  it("does not mark a posting notified when the notifier fails", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier({
      ok: false,
      error: { message: "Telegram unreachable" },
    });

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBe("Telegram unreachable");

    const runsRepo = new RunsRepository(db);
    expect(runsRepo.findById(outcome.runId)?.outcome).toBe("failed");

    const postingsRepo = new PostingsRepository(db);
    expect(postingsRepo.findUnnotified()).toHaveLength(1);
  });

  it("surfaces a posting that fails scoring in the digest's review section, with the failure reason (docs/audit AC-009, ADR-006)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const failingScorer: ScorerPort = {
      score: async () => ({
        ok: false,
        reason: "extraction_failed",
        attempts: 3,
        permanent: false,
        diagnostic: {
          stage: "stage-a",
          kind: "transport_failed",
          category: "timeout",
        },
      }),
    };
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      failingScorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    // Not discarded (ADR-006): filtered but not counted as successfully
    // scored, still delivered in the digest's review section.
    expect(outcome.filtered).toBe(1);
    expect(outcome.scored).toBe(0);
    expect(outcome.delivered).toBe(1);
    expect(digests[0]?.review).toHaveLength(1);
    expect(digests[0]?.review[0]?.outcome.scoreFailureReason).toBe(
      "extraction_failed",
    );

    // scoredCount stays 0 -- evaluateDeliveryOutcome's failure-rate alert
    // reads this as "successfully scored", and this posting was not.
    const runsRepo = new RunsRepository(db);
    const run = runsRepo.findById(outcome.runId);
    expect(run?.scoredCount).toBe(0);
    expect(run?.filteredCount).toBe(1);
    expect(parseScoreFailureCounts(run!)).toEqual({ extraction_failed: 1 });

    const scoreEvent = new PostingEventsRepository(db)
      .findByRun(outcome.runId)
      .find((event) => event.stage === "score");
    expect(parsePostingEventMetadata(scoreEvent!)).toMatchObject({
      diagnostic: {
        stage: "stage-a",
        kind: "transport_failed",
        category: "timeout",
      },
    });
  });

  describe("docs/audit PR-002 — recoverable scoring failures", () => {
    async function collectOnePosting(): Promise<void> {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [
          {
            source: "gupy",
            sourceId: "1",
            payload: gupyPayload(1, "Estágio em Backend"),
          },
        ],
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);
    }

    function failingScorer(): ScorerPort {
      return {
        score: async () => ({
          ok: false,
          reason: "extraction_failed",
          attempts: 3,
          permanent: false,
          diagnostic: {
            stage: "stage-a",
            kind: "transport_failed",
            category: "timeout",
          },
        }),
      };
    }

    it("does not mark a failed posting notified, so it stays a candidate for the next run", async () => {
      await collectOnePosting();
      const criteria = deliverCriteria();
      const { notifier } = recordingNotifier();

      await executeDeliver(
        db,
        failingScorer(),
        notifier,
        criteria,
        deliverProfile(),
      );

      // Before this fix, every entry in the digest -- failures included --
      // was marked notified unconditionally, permanently removing a
      // transiently-failed posting from all future scoring the moment its
      // one failure message was delivered.
      const postingsRepo = new PostingsRepository(db);
      expect(postingsRepo.findUnnotified()).toHaveLength(1);
    });

    it("retries a failed posting on the next run and reports it again", async () => {
      await collectOnePosting();
      const criteria = deliverCriteria();

      const first = await executeDeliver(
        db,
        failingScorer(),
        recordingNotifier().notifier,
        criteria,
        deliverProfile(),
      );
      const { notifier, digests } = recordingNotifier();
      const second = await executeDeliver(
        db,
        failingScorer(),
        notifier,
        criteria,
        deliverProfile(),
      );

      expect(first.filtered).toBe(1);
      expect(second.filtered).toBe(1);
      expect(digests[0]?.review[0]?.outcome.scoreFailureReason).toBe(
        "extraction_failed",
      );
    });

    it("clears the failure count once a posting scores successfully again", async () => {
      await collectOnePosting();
      const criteria = deliverCriteria();

      await executeDeliver(
        db,
        failingScorer(),
        recordingNotifier().notifier,
        criteria,
        deliverProfile(),
      );
      const postingsRepo = new PostingsRepository(db);
      const [posting] = postingsRepo.findUnnotified();
      expect(postingsRepo.getScoreFailureCount(posting!.fingerprint)).toBe(1);

      await executeDeliver(
        db,
        new StubScorer(criteria),
        recordingNotifier().notifier,
        criteria,
        deliverProfile(),
      );

      expect(postingsRepo.getScoreFailureCount(posting!.fingerprint)).toBe(0);
    });

    it("stops retrying and marks the posting notified once maxScoreFailures is reached", async () => {
      await collectOnePosting();
      const criteria = deliverCriteria();
      const maxScoreFailures = 2;

      // First two runs each fail and consume one attempt of the budget.
      for (let i = 0; i < maxScoreFailures; i++) {
        await executeDeliver(
          db,
          failingScorer(),
          recordingNotifier().notifier,
          criteria,
          deliverProfile(),
          undefined,
          undefined,
          undefined,
          maxScoreFailures,
        );
      }

      const postingsRepo = new PostingsRepository(db);
      expect(postingsRepo.findUnnotified()).toHaveLength(1);

      // The third run hits the ceiling: no model call, marked notified with
      // a distinct reason, and gone from the unnotified pool for good.
      const ask = failingScorer();
      const { notifier, digests } = recordingNotifier();
      const outcome = await executeDeliver(
        db,
        ask,
        notifier,
        criteria,
        deliverProfile(),
        undefined,
        undefined,
        undefined,
        maxScoreFailures,
      );

      expect(outcome.delivered).toBe(1);
      expect(digests[0]?.review[0]?.outcome.scoreFailureReason).toBe(
        "max_retries_exceeded",
      );
      expect(postingsRepo.findUnnotified()).toHaveLength(0);
    });
  });

  describe("docs/audit PR-007 — a permanent transport failure stops the batch", () => {
    it("stops scoring the rest of the run after one permanent failure, leaving the others untouched", async () => {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [1, 2, 3].map((n) => ({
          source: "gupy",
          sourceId: String(n),
          payload: gupyPayload(n, `Estágio em Backend ${n}`, `Empresa ${n}`),
        })),
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);

      const criteria = deliverCriteria();
      // Every posting would fail identically -- a revoked API key, not a
      // content-specific problem -- so the second and third calls this
      // scorer would otherwise receive are exactly the "known-doomed
      // requests" PR-007 says must not happen.
      const scoreCalls: string[] = [];
      const permanentlyFailingScorer: ScorerPort = {
        score: async (posting) => {
          scoreCalls.push(posting.fingerprint);
          return {
            ok: false,
            reason: "extraction_failed",
            attempts: 1,
            permanent: true,
            diagnostic: {
              stage: "stage-a",
              kind: "permanent_error",
              category: "authError",
            },
          };
        },
      };
      const { notifier, digests } = recordingNotifier();

      const outcome = await executeDeliver(
        db,
        permanentlyFailingScorer,
        notifier,
        criteria,
        deliverProfile(),
      );

      expect(scoreCalls).toHaveLength(1);
      expect(outcome.filtered).toBe(3);
      expect(outcome.scored).toBe(0);
      expect(digests[0]?.review).toHaveLength(1);

      // The two postings never reached are simply untouched -- still
      // candidates for the next run once the config problem is fixed.
      const postingsRepo = new PostingsRepository(db);
      expect(postingsRepo.findUnnotified()).toHaveLength(3);
    });

    it("keeps scoring normally when a failure is not permanent", async () => {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [1, 2].map((n) => ({
          source: "gupy",
          sourceId: String(n),
          payload: gupyPayload(n, `Estágio em Backend ${n}`, `Empresa ${n}`),
        })),
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);

      const criteria = deliverCriteria();
      const scoreCalls: string[] = [];
      const transientlyFailingScorer: ScorerPort = {
        score: async (posting) => {
          scoreCalls.push(posting.fingerprint);
          return {
            ok: false,
            reason: "extraction_failed",
            attempts: 3,
            permanent: false,
            diagnostic: {
              stage: "stage-a",
              kind: "transport_failed",
              category: "timeout",
            },
          };
        },
      };
      const { notifier } = recordingNotifier();

      const outcome = await executeDeliver(
        db,
        transientlyFailingScorer,
        notifier,
        criteria,
        deliverProfile(),
      );

      expect(scoreCalls).toHaveLength(2);
      expect(outcome.filtered).toBe(2);
    });
  });

  describe("docs/11-known-issues.md C1 — cooperative cancellation", () => {
    function okScoreResult() {
      return {
        ok: true as const,
        score: 80,
        verdict: "apply" as const,
        breakdown: {
          mandatoryCoverage: 1,
          desirableCoverage: 1,
          trackAlignment: 1,
        },
        blockingFailure: null,
        blockingFailures: [],
        lowConfidence: false,
        criticalGaps: [],
        periodGate: null,
        recommendedVariant: null,
        highlights: [],
        missingTerms: [],
        inputTruncated: false,
        stageACacheHit: false,
        stageBCacheHit: false,
        evidenceRejectedCount: 0,
      };
    }

    it("stops after the posting in flight when the cancel flag flips, and still delivers what was scored", async () => {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [1, 2, 3].map((n) => ({
          source: "gupy",
          sourceId: String(n),
          payload: gupyPayload(n, `Estágio em Backend ${n}`, `Empresa ${n}`),
        })),
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);

      const criteria = deliverCriteria();
      const scoreCalls: string[] = [];
      // Flips true after the first posting is scored -- simulates a cancel
      // request arriving mid-run, observed at the next loop checkpoint.
      const scorer: ScorerPort = {
        score: async (posting) => {
          scoreCalls.push(posting.fingerprint);
          return okScoreResult();
        },
      };
      const { notifier, digests } = recordingNotifier();

      const outcome = await executeDeliver(
        db,
        scorer,
        notifier,
        criteria,
        deliverProfile(),
        undefined,
        undefined,
        undefined,
        undefined,
        "internal",
        () => scoreCalls.length >= 1,
      );

      expect(scoreCalls).toHaveLength(1);
      expect(outcome.filtered).toBe(3);
      expect(outcome.scored).toBe(1);
      expect(outcome.cancelled).toBe(true);
      expect(outcome.delivered).toBe(1);
      expect(digests[0]?.recommended).toHaveLength(1);

      const run = new RunsRepository(db).findById(outcome.runId);
      expect(run?.outcome).toBe("cancelled");

      // The two postings never reached stay real candidates, exactly like
      // PR-007's permanent-failure path -- cancellation is not a rejection.
      const postingsRepo = new PostingsRepository(db);
      expect(postingsRepo.findUnnotified()).toHaveLength(2);
    });

    it("never cancels when isCancelRequested is not passed (default behavior unchanged)", async () => {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [1, 2].map((n) => ({
          source: "gupy",
          sourceId: String(n),
          payload: gupyPayload(n, `Estágio em Backend ${n}`, `Empresa ${n}`),
        })),
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);

      const criteria = deliverCriteria();
      const scorer: ScorerPort = { score: async () => okScoreResult() };
      const { notifier } = recordingNotifier();

      const outcome = await executeDeliver(
        db,
        scorer,
        notifier,
        criteria,
        deliverProfile(),
      );

      expect(outcome.scored).toBe(2);
      expect(outcome.cancelled).toBeUndefined();
      const run = new RunsRepository(db).findById(outcome.runId);
      expect(run?.outcome).toBe("success");
    });
  });

  describe("docs/audit PR-004 — persisted claim as the scoring admission barrier", () => {
    function rawClaimFields(fingerprint: string) {
      const row = db
        .select({
          scoringClaimedAt: postings.scoringClaimedAt,
          scoringClaimRunId: postings.scoringClaimRunId,
        })
        .from(postings)
        .where(eq(postings.fingerprint, fingerprint))
        .get();
      return row ?? null;
    }

    it("releases the claim (not just leaves notifiedAt null) on a recoverable scoring failure", async () => {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [
          {
            source: "gupy",
            sourceId: "1",
            payload: gupyPayload(1, "Estágio em Backend"),
          },
        ],
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);

      const criteria = deliverCriteria();
      const failingScorer: ScorerPort = {
        score: async () => ({
          ok: false,
          reason: "extraction_failed",
          attempts: 3,
          permanent: false,
          diagnostic: {
            stage: "stage-a",
            kind: "transport_failed",
            category: "timeout",
          },
        }),
      };
      const { notifier } = recordingNotifier();

      await executeDeliver(
        db,
        failingScorer,
        notifier,
        criteria,
        deliverProfile(),
      );

      const postingsRepo = new PostingsRepository(db);
      const [candidate] = postingsRepo.findUnnotified();
      // The regression this guards: findUnnotified() does not look at claim
      // state at all, so it would report this posting as a candidate even
      // if releaseUnresolvedClaims were never called -- only reading the
      // claim columns directly proves the barrier was actually released.
      expect(rawClaimFields(candidate!.fingerprint)).toEqual({
        scoringClaimedAt: null,
        scoringClaimRunId: null,
      });
    });

    it("marks the claim under this run's id while scoring is in progress, atomically with dedup", async () => {
      const collector = stubCollector({
        source: "gupy",
        collectedAt: new Date(),
        postings: [
          {
            source: "gupy",
            sourceId: "1",
            payload: gupyPayload(1, "Estágio em Backend"),
          },
        ],
      });
      await executeCollect(db, () => collector, [{}], undefined, 0);

      const criteria = deliverCriteria();
      const captured: { fields: ReturnType<typeof rawClaimFields> } = {
        fields: null,
      };
      const observingScorer: ScorerPort = {
        score: async (posting) => {
          captured.fields = rawClaimFields(posting.fingerprint);
          return {
            ok: true,
            score: 80,
            verdict: "apply",
            breakdown: {
              mandatoryCoverage: 1,
              desirableCoverage: 1,
              trackAlignment: 1,
            },
            blockingFailure: null,
            blockingFailures: [],
            lowConfidence: false,
            criticalGaps: [],
            periodGate: null,
            recommendedVariant: null,
            highlights: [],
            missingTerms: [],
            inputTruncated: false,
            stageACacheHit: false,
            stageBCacheHit: false,
            evidenceRejectedCount: 0,
          };
        },
      };
      const { notifier } = recordingNotifier();

      const outcome = await executeDeliver(
        db,
        observingScorer,
        notifier,
        criteria,
        deliverProfile(),
      );

      expect(captured.fields).not.toBeNull();
      expect(captured.fields?.scoringClaimRunId).toBe(outcome.runId);
      expect(captured.fields?.scoringClaimedAt).not.toBeNull();
    });
  });

  it("excludes a posting that fails the pre-filter from scoring and the digest", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Analista Pleno de Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.filtered).toBe(0);
    expect(outcome.scored).toBe(0);
    expect(outcome.delivered).toBe(0);
    expect(digests[0]?.review).toHaveLength(0);
  });

  it("records a rejected prefilter event, with reason, for a posting the pre-filter drops (docs/audit AC-019)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Analista Pleno de Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    const events = new PostingEventsRepository(db).findByRun(outcome.runId);
    const prefilterEvents = events.filter((e) => e.stage === "prefilter");
    expect(prefilterEvents).toHaveLength(1);
    expect(prefilterEvents[0]?.outcome).toBe("rejected");
    expect(prefilterEvents[0]?.reason).toBe("title_missing_required_term");
    expect(prefilterEvents[0]?.criteriaHash).toBeTruthy();
  });

  it("records passed prefilter, score and delivery events for a posting that reaches the digest (docs/audit AC-019/AC-027)", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    const events = new PostingEventsRepository(db).findByRun(outcome.runId);
    const stages = events.map((e) => e.stage).sort();
    expect(stages).toEqual(["delivery", "prefilter", "score"]);

    const prefilterEvent = events.find((e) => e.stage === "prefilter");
    expect(prefilterEvent?.outcome).toBe("passed");
    expect(prefilterEvent?.reason).toBeNull();

    const scoreEvent = events.find((e) => e.stage === "score");
    expect(scoreEvent?.outcome).toBeTruthy();

    const deliveryEvent = events.find((e) => e.stage === "delivery");
    expect(deliveryEvent?.outcome).toBe("delivered");

    const [posting] = new PostingsRepository(db).findActive();
    const history = new PostingEventsRepository(db).findByFingerprint(
      posting!.fingerprint,
    );
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  it("reports collected and deduplicated counts from collect/dedup runs since the last delivery", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
        {
          source: "gupy",
          sourceId: "2",
          payload: gupyPayload(2, "Estágio em Backend (Rio de Janeiro)"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);
    executeDedup(db);

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    const outcome = await executeDeliver(
      db,
      scorer,
      notifier,
      criteria,
      deliverProfile(),
    );

    expect(outcome.error).toBeUndefined();
    expect(digests[0]?.summary.collected).toBe(2);
    expect(digests[0]?.summary.failedSources).toEqual([]);
  });

  it("reports the real failed source, not a hardcoded guess (docs/11 B2)", async () => {
    // Regression test: this summary used to hardcode ["gupy"] for any
    // failed collect run in the window, regardless of which source it
    // actually was.
    await executeCollect(
      db,
      () => ({
        collect: async () => ({
          source: "indeed",
          collectedAt: new Date(),
          postings: [],
          error: { message: "Indeed responded 500" },
        }),
      }),
      [{ source: "indeed" }],
      undefined,
      0,
    );

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    await executeDeliver(db, scorer, notifier, criteria, deliverProfile());

    expect(digests[0]?.summary.failedSources).toEqual(["indeed"]);
  });

  it("surfaces a source truncated via external ingest in the digest summary (docs/audit PR-015)", async () => {
    const normalize = (
      raw: { source: string; sourceId: string; payload: unknown },
      now: Date,
    ) => {
      const payload = raw.payload as { title: string; company: string };
      return createPosting({
        source: raw.source,
        sourceId: raw.sourceId,
        company: payload.company,
        title: payload.title,
        location: { kind: "unknown" },
        workMode: "unknown",
        collectedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        rawPayload: payload,
      });
    };
    await executeIngestExternal(
      db,
      "indeed",
      normalize,
      [{ sourceId: "in-1", payload: { title: "Estágio A", company: "X" } }],
      undefined,
      true,
    );

    const criteria = deliverCriteria();
    const scorer = new StubScorer(criteria);
    const { notifier, digests } = recordingNotifier();

    await executeDeliver(db, scorer, notifier, criteria, deliverProfile());

    expect(digests[0]?.summary.truncatedSources).toEqual(["indeed"]);
  });
});

const studyPlanTaxonomy: Taxonomy = {
  skills: [{ canonical: "PostgreSQL", aliases: ["Postgres"] }],
};

/** Records every text send instead of hitting the network. */
function recordingTextNotifier(): { notifier: TextNotifier; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notifier: {
      sendText: async (text: string) => {
        sent.push(text);
        return { ok: true };
      },
    },
  };
}

describe("executeStudyPlan", () => {
  it("sends a study plan built from the current corpus, over the active database only", async () => {
    const collector = stubCollector({
      source: "gupy",
      collectedAt: new Date(),
      postings: [
        {
          source: "gupy",
          sourceId: "1",
          payload: gupyPayload(1, "Estágio em Backend"),
        },
      ],
    });
    await executeCollect(db, () => collector, [{}], undefined, 0);

    const { notifier, sent } = recordingTextNotifier();
    const outcome = await executeStudyPlan(
      db,
      deliverCriteria(),
      deliverProfile(),
      studyPlanTaxonomy,
      notifier,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.delivered).toBe(true);
    expect(outcome.corpusSize).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Corpus: 1 vagas");
  });

  it("reports a delivery failure without throwing", async () => {
    const notifier: TextNotifier = {
      sendText: async () => ({
        ok: false,
        error: { message: "Telegram is down" },
      }),
    };

    const outcome = await executeStudyPlan(
      db,
      deliverCriteria(),
      deliverProfile(),
      studyPlanTaxonomy,
      notifier,
    );

    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toBe("Telegram is down");
  });
});

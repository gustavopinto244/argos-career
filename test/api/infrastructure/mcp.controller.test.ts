import { mkdtempSync, rmSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ApiModule } from "../../../src/api/infrastructure/api.module";
import { COLLECTOR } from "../../../src/api/infrastructure/collector.provider";
import { NOTIFIER } from "../../../src/api/infrastructure/notifier.provider";
import { Digest } from "../../../src/delivery/domain/digest";
import {
  NotifierPort,
  NotifyResult,
} from "../../../src/delivery/domain/ports/notifier.port";
import { TextNotifier } from "../../../src/delivery/infrastructure/telegram-notifier";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { ApplicationEventsRepository } from "../../../src/feedback/infrastructure/application-events-repository";
import { PostingsRepository } from "../../../src/persistence/infrastructure/postings-repository";
import { RunsRepository } from "../../../src/persistence/infrastructure/runs-repository";
import {
  CollectionResult,
  CollectorPort,
} from "../../../src/posting/domain/ports/collector.port";
import { createPosting } from "../../../src/posting/domain/posting";

const API_KEY = "test-api-key-for-mcp-suite";
const AUTOMATION_KEY = "test-automation-key-for-mcp-suite";
const FEEDBACK_KEY = "test-feedback-key-for-mcp-suite";

/** No real Gupy/Telegram request in this suite — same reasoning as
 * runs.controller.test.ts's fakes. */
class FakeCollector implements CollectorPort {
  readonly calls: unknown[] = [];
  async collect(criteria: unknown): Promise<CollectionResult> {
    this.calls.push(criteria);
    return { source: "fake", postings: [], collectedAt: new Date() };
  }
}
class FakeNotifier implements NotifierPort, TextNotifier {
  readonly sent: Digest[] = [];
  readonly sentText: string[] = [];
  async notify(digest: Digest): Promise<NotifyResult> {
    this.sent.push(digest);
    return { ok: true };
  }
  async sendText(text: string): Promise<NotifyResult> {
    this.sentText.push(text);
    return { ok: true };
  }
}

let dir: string;
let app: INestApplication;
let db: Db;
let env: NodeJS.ProcessEnv;
let client: Client;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "argos-mcp-"));
  env = { ...process.env };
  process.env.DATABASE_PATH = join(dir, "argos.db");
  process.env.API_KEY = API_KEY;
  process.env.API_AUTOMATION_KEY = AUTOMATION_KEY;
  process.env.API_FEEDBACK_KEY = FEEDBACK_KEY;
  process.env.SCORER_ADAPTER = "stub";
  process.env.PROFILE_PATH = "./config/profile.example.yaml";

  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule],
  })
    .overrideProvider(COLLECTOR)
    .useValue(() => new FakeCollector())
    .overrideProvider(NOTIFIER)
    .useValue(new FakeNotifier())
    .compile();
  app = moduleRef.createNestApplication();
  // The MCP client transport is a real `fetch`, unlike Supertest — it needs
  // a real listening port, not an in-memory request. Bound explicitly to
  // IPv4 loopback: an unqualified `listen(0)` can bind IPv6-only on some
  // hosts, which the client then can't reach via the "127.0.0.1" URL below.
  await app.listen(0, "127.0.0.1");
  port = (app.getHttpServer().address() as AddressInfo).port;

  db = createDatabase(process.env.DATABASE_PATH);
  runMigrations(db);

  client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
  );
  // Same `exactOptionalPropertyTypes` friction as `McpController`'s cast on
  // the server side — `Transport.sessionId` is declared as always a
  // `string`, but the SDK's own client sets it to `undefined` in stateless
  // mode; a type annotation gap, not a real structural mismatch.
  await client.connect(transport as unknown as Transport);
});

afterEach(async () => {
  await client.close();
  await app.close();
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? "null");
}

describe("MCP server", () => {
  it("lists all fifteen tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "cancel_run",
        "discard_posting",
        "get_health",
        "get_personal_gap_analysis",
        "get_run",
        "get_study_plan",
        "list_application_events",
        "list_postings",
        "list_runs",
        "mark_applied",
        "record_application_event",
        "run_collect",
        "run_dedup",
        "run_deliver",
        "unmark_applied",
      ].sort(),
    );
  });

  it("get_health returns the same shape as GET /health", async () => {
    const result = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    expect(textOf(result)).toEqual({
      lastSuccessfulRun: { collect: null, dedup: null, scoreAndDeliver: null },
    });
  });

  it("run_dedup triggers a real dedup cycle and writes a run row", async () => {
    const result = await client.callTool({
      name: "run_dedup",
      arguments: {},
    });
    const body = textOf(result) as { runId: string };
    expect(body.runId).toBeDefined();

    const repo = new RunsRepository(db);
    expect(repo.findById(body.runId)?.kind).toBe("dedup");
  });

  it("run_collect calls the injected fake collector, not a real one", async () => {
    const result = await client.callTool({
      name: "run_collect",
      arguments: { city: "Rio de Janeiro" },
    });
    const body = textOf(result) as { collected: number };
    expect(body.collected).toBe(0);
  });

  it("list_runs and get_run round-trip a run created via run_dedup", async () => {
    const created = textOf(
      await client.callTool({ name: "run_dedup", arguments: {} }),
    ) as { runId: string };

    const listed = textOf(
      await client.callTool({
        name: "list_runs",
        arguments: { kind: "dedup", limit: 5 },
      }),
    ) as { runs: { runId: string }[] };
    expect(listed.runs.some((r) => r.runId === created.runId)).toBe(true);

    const detail = textOf(
      await client.callTool({
        name: "get_run",
        arguments: { runId: created.runId },
      }),
    ) as { runId: string; kind: string };
    expect(detail.kind).toBe("dedup");
  });

  it("get_run returns an isError result for an unknown runId, not a crash", async () => {
    const result = await client.callTool({
      name: "get_run",
      arguments: { runId: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
  });

  it("run_deliver scores with the stub scorer and sends through the fake notifier", async () => {
    const result = await client.callTool({
      name: "run_deliver",
      arguments: {},
    });
    const body = textOf(result) as { delivered: number };
    expect(body.delivered).toBe(0);
  });

  it("run_deliver is rate-limited past the expensive-operation budget, same as the REST path (docs/audit AC-021)", async () => {
    // MCP tool calls all share one /mcp route, invisible to a per-HTTP-route
    // throttle guard -- this is why the check lives in RunsService, not on
    // RunsController alone. isError, not a thrown connection failure: MCP's
    // safely() wrapper turns the 429 into a tool error result.
    for (let i = 0; i < 3; i++) {
      const result = await client.callTool({
        name: "run_deliver",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
    }

    const fourth = await client.callTool({
      name: "run_deliver",
      arguments: {},
    });
    expect(fourth.isError).toBe(true);
    const content = fourth.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain("Rate limit exceeded");
  });

  it("cancel_run (docs/11-known-issues.md C1) returns an isError result when nothing is in flight", async () => {
    const result = await client.callTool({
      name: "cancel_run",
      arguments: { kind: "scoreAndDeliver" },
    });
    expect(result.isError).toBe(true);
  });

  it("cancel_run rejects a kind that has no cancellation checkpoint", async () => {
    const result = await client.callTool({
      name: "cancel_run",
      arguments: { kind: "collect" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain("Cancellation is only supported");
  });

  it("get_study_plan reads the corpus and sends through the fake notifier", async () => {
    const result = await client.callTool({
      name: "get_study_plan",
      arguments: {},
    });
    const body = textOf(result) as { corpusSize: number; delivered: boolean };
    expect(body.corpusSize).toBe(0);
    expect(body.delivered).toBe(true);
  });

  it("discard_posting removes a posting from the digest pool — the Hermes-facing path", async () => {
    const repo = new PostingsRepository(db);
    const { posting } = repo.upsert(
      createPosting({
        source: "gupy",
        sourceId: "1",
        company: "Empresa X",
        title: "Estágio Backend",
        location: { kind: "known", city: "Rio de Janeiro" },
        workMode: "hybrid",
        collectedAt: new Date(),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        rawPayload: {},
      }),
    );
    expect(repo.findUnnotified()).toHaveLength(1);

    const result = await client.callTool({
      name: "discard_posting",
      arguments: { fingerprint: posting.fingerprint, reason: "not a fit" },
    });

    expect(textOf(result)).toEqual({
      fingerprint: posting.fingerprint,
      discarded: true,
    });
    expect(repo.findUnnotified()).toHaveLength(0);
  });

  it("discard_posting returns an isError result for an unknown fingerprint", async () => {
    const result = await client.callTool({
      name: "discard_posting",
      arguments: { fingerprint: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
  });

  describe("an automation principal cannot mutate posting state over MCP", () => {
    // `ApiKeyGuard` allowlists `POST /mcp` for an automation key but not
    // `/postings/*`, so these mutations are admin-only over REST. Without a
    // per-tool check, MCP would be a way around that path-based policy —
    // the reason `discard_posting` carries `requirePrincipalKind`, and the
    // reason the two applied-bookmark tools now do too.
    async function automationClient(): Promise<Client> {
      const automation = new Client({ name: "auto", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${AUTOMATION_KEY}` },
          },
        },
      );
      await automation.connect(transport as unknown as Transport);
      return automation;
    }

    it.each(["mark_applied", "unmark_applied", "discard_posting"])(
      "refuses %s",
      async (name) => {
        const stored = seedPosting("1", "Estágio em Backend");
        const automation = await automationClient();
        try {
          const result = await automation.callTool({
            name,
            arguments: { fingerprint: stored.fingerprint },
          });
          expect(result.isError).toBe(true);
        } finally {
          await automation.close();
        }
        // The state it was denied is genuinely unchanged — not merely an
        // error returned after the write landed.
        const repo = new PostingsRepository(db);
        expect(repo.findAppliedAtMap().size).toBe(0);
        expect(repo.findDiscardedFingerprints().size).toBe(0);
      },
    );

    // ADR-075 Amendment 1: `note` carries a literal quote of the recruiter's
    // email (the outcome-tracking Hermes skill writes it). `automation`
    // exists to trigger pipeline stages, not to read correspondence — and a
    // read should never be broader than the write for the same rows, which
    // is already `["admin", "feedback"]`.
    it("refuses list_application_events, which exposes quoted email text", async () => {
      const stored = seedPosting("1", "Estágio em Backend");
      const automation = await automationClient();
      try {
        const result = await automation.callTool({
          name: "list_application_events",
          arguments: { fingerprint: stored.fingerprint },
        });
        expect(result.isError).toBe(true);
      } finally {
        await automation.close();
      }
    });

    it("still allows the read-only tools it is entitled to", async () => {
      seedPosting("1", "Estágio em Backend");
      const automation = await automationClient();
      try {
        const result = await automation.callTool({
          name: "list_postings",
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await automation.close();
      }
    });
  });

  function seedPosting(fingerprintSourceId: string, title: string) {
    const repo = new PostingsRepository(db);
    return repo.upsert(
      createPosting({
        source: "gupy",
        sourceId: fingerprintSourceId,
        company: "Empresa X",
        title,
        location: { kind: "known", city: "Rio de Janeiro" },
        workMode: "hybrid",
        collectedAt: new Date(),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        rawPayload: {},
      }),
    ).posting;
  }

  it("list_postings reads the corpus (ADR-072) — the Hermes-facing analysis query", async () => {
    seedPosting("1", "Estágio Backend");

    const result = await client.callTool({
      name: "list_postings",
      arguments: {},
    });

    const body = textOf(result) as {
      total: number;
      postings: { fingerprint: string; applied: boolean }[];
    };
    expect(body.total).toBe(1);
    expect(body.postings[0]?.applied).toBe(false);
  });

  it("mark_applied and unmark_applied toggle the bookmark list_postings' applied filter reads", async () => {
    const posting = seedPosting("1", "Estágio Backend");

    const marked = await client.callTool({
      name: "mark_applied",
      arguments: { fingerprint: posting.fingerprint },
    });
    expect(textOf(marked)).toEqual({
      fingerprint: posting.fingerprint,
      applied: true,
    });

    const listedApplied = textOf(
      await client.callTool({
        name: "list_postings",
        arguments: { applied: true },
      }),
    ) as { total: number };
    expect(listedApplied.total).toBe(1);

    const unmarked = await client.callTool({
      name: "unmark_applied",
      arguments: { fingerprint: posting.fingerprint },
    });
    expect(textOf(unmarked)).toEqual({
      fingerprint: posting.fingerprint,
      applied: false,
    });

    const listedAppliedAfter = textOf(
      await client.callTool({
        name: "list_postings",
        arguments: { applied: true },
      }),
    ) as { total: number };
    expect(listedAppliedAfter.total).toBe(0);
  });

  it("mark_applied returns an isError result for an unknown fingerprint", async () => {
    const result = await client.callTool({
      name: "mark_applied",
      arguments: { fingerprint: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
  });

  describe("record_application_event / list_application_events (ADR-075)", () => {
    it("records an event and reads it back, most recent first", async () => {
      const posting = seedPosting("1", "Estágio Backend");

      const recorded = await client.callTool({
        name: "record_application_event",
        arguments: {
          fingerprint: posting.fingerprint,
          kind: "response_received",
          note: "recrutador pediu disponibilidade",
        },
      });
      expect(textOf(recorded)).toEqual({
        fingerprint: posting.fingerprint,
        kind: "response_received",
      });

      await client.callTool({
        name: "record_application_event",
        arguments: {
          fingerprint: posting.fingerprint,
          kind: "interview_scheduled",
        },
      });

      const listed = textOf(
        await client.callTool({
          name: "list_application_events",
          arguments: { fingerprint: posting.fingerprint },
        }),
      ) as { kind: string; note: string | null }[];
      expect(listed.map((e) => e.kind)).toEqual([
        "interview_scheduled",
        "response_received",
      ]);
      expect(listed[1]?.note).toBe("recrutador pediu disponibilidade");
    });

    it("never records 'applied' as a kind (ADR-075) — mark_applied owns that fact", async () => {
      const posting = seedPosting("1", "Estágio Backend");
      const result = await client.callTool({
        name: "record_application_event",
        arguments: { fingerprint: posting.fingerprint, kind: "applied" },
      });
      expect(result.isError).toBe(true);
    });

    it("returns an isError result for an unknown fingerprint", async () => {
      const result = await client.callTool({
        name: "record_application_event",
        arguments: { fingerprint: "does-not-exist", kind: "rejected" },
      });
      expect(result.isError).toBe(true);
    });

    it("list_application_events reads an empty history without erroring", async () => {
      const posting = seedPosting("1", "Estágio Backend");
      const result = await client.callTool({
        name: "list_application_events",
        arguments: { fingerprint: posting.fingerprint },
      });
      expect(textOf(result)).toEqual([]);
    });
  });

  describe("get_personal_gap_analysis (ADR-076)", () => {
    it("scopes to applied postings and reports how many were in scope", async () => {
      const posting = seedPosting("1", "Estágio em Backend");
      const repo = new PostingsRepository(db);
      repo.markApplied(posting.fingerprint, new Date());
      // A posting that is not applied must not count toward the scope.
      seedPosting("2", "Estágio em Frontend");

      const result = await client.callTool({
        name: "get_personal_gap_analysis",
        arguments: { scope: "applied" },
      });

      expect(result.isError).toBeFalsy();
      const body = textOf(result) as {
        scope: string;
        track: string | null;
        scopedPostingCount: number;
        gaps: unknown[];
      };
      expect(body.scope).toBe("applied");
      expect(body.track).toBeNull();
      expect(body.scopedPostingCount).toBe(1);
      // No cached extraction/match data was seeded, so there is nothing to
      // rank a gap from — an empty list, not an error.
      expect(body.gaps).toEqual([]);
    });

    it("scopes to discarded postings, reporting zero when nothing was ever scored", async () => {
      seedPosting("1", "Estágio em Backend");

      const result = await client.callTool({
        name: "get_personal_gap_analysis",
        arguments: { scope: "discarded" },
      });

      expect(result.isError).toBeFalsy();
      const body = textOf(result) as { scopedPostingCount: number };
      // Never scored (no cached matches) means verdict is null, which the
      // "discarded" scope excludes — the pre-filter is not a competency
      // judgement.
      expect(body.scopedPostingCount).toBe(0);
    });

    // Distinct from the two tests above in what it actually pins: this
    // reuses the exact same applied posting and only changes `scope`, so it
    // catches the MCP layer silently ignoring/hardcoding the parameter
    // rather than genuinely passing it through to executePersonalGapAnalysis
    // — a bug the other two tests, each with a differently-shaped fixture,
    // would not have caught.
    it("does not count an applied posting toward the discarded scope", async () => {
      const posting = seedPosting("1", "Estágio em Backend");
      const repo = new PostingsRepository(db);
      repo.markApplied(posting.fingerprint, new Date());

      const result = await client.callTool({
        name: "get_personal_gap_analysis",
        arguments: { scope: "discarded" },
      });

      const body = textOf(result) as { scopedPostingCount: number };
      expect(body.scopedPostingCount).toBe(0);
    });

    it("rejects a missing scope rather than defaulting to one", async () => {
      const result = await client.callTool({
        name: "get_personal_gap_analysis",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("the feedback principal (ADR-075)", () => {
    async function feedbackClient(): Promise<Client> {
      const feedback = new Client({ name: "feedback", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: { headers: { Authorization: `Bearer ${FEEDBACK_KEY}` } },
        },
      );
      await feedback.connect(transport as unknown as Transport);
      return feedback;
    }

    it.each([
      "list_postings",
      "mark_applied",
      "unmark_applied",
      "record_application_event",
      "list_application_events",
    ])("can call %s", async (name) => {
      const posting = seedPosting("1", "Estágio Backend");
      const feedback = await feedbackClient();
      try {
        const result = await feedback.callTool({
          name,
          arguments: {
            fingerprint: posting.fingerprint,
            kind: "response_received",
          },
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await feedback.close();
      }
    });

    it.each(["discard_posting", "run_collect", "run_dedup", "run_deliver"])(
      "cannot call %s",
      async (name) => {
        const posting = seedPosting("1", "Estágio Backend");
        const feedback = await feedbackClient();
        try {
          const result = await feedback.callTool({
            name,
            arguments: { fingerprint: posting.fingerprint },
          });
          expect(result.isError).toBe(true);
        } finally {
          await feedback.close();
        }
      },
    );

    it("recordedBy on a feedback-reported event carries the feedback principal's id", async () => {
      const posting = seedPosting("1", "Estágio Backend");
      const feedback = await feedbackClient();
      try {
        await feedback.callTool({
          name: "record_application_event",
          arguments: { fingerprint: posting.fingerprint, kind: "offer" },
        });
      } finally {
        await feedback.close();
      }

      const repo = new ApplicationEventsRepository(db);
      const [row] = repo.findByFingerprint(posting.fingerprint);
      expect(row?.recordedBy).toMatch(/^feedback:/);
    });

    it("can call list_application_events — same scope as the write side", async () => {
      const posting = seedPosting("1", "Estágio Backend");
      const feedback = await feedbackClient();
      try {
        const result = await feedback.callTool({
          name: "list_application_events",
          arguments: { fingerprint: posting.fingerprint },
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await feedback.close();
      }
    });

    it("can call get_personal_gap_analysis (ADR-076)", async () => {
      const feedback = await feedbackClient();
      try {
        const result = await feedback.callTool({
          name: "get_personal_gap_analysis",
          arguments: { scope: "applied" },
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await feedback.close();
      }
    });
  });
});

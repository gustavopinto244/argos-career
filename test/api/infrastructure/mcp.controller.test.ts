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
import { PostingsRepository } from "../../../src/persistence/infrastructure/postings-repository";
import { RunsRepository } from "../../../src/persistence/infrastructure/runs-repository";
import {
  CollectionResult,
  CollectorPort,
} from "../../../src/posting/domain/ports/collector.port";
import { createPosting } from "../../../src/posting/domain/posting";

const API_KEY = "test-api-key-for-mcp-suite";

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "argos-mcp-"));
  env = { ...process.env };
  process.env.DATABASE_PATH = join(dir, "argos.db");
  process.env.API_KEY = API_KEY;
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
  const port = (app.getHttpServer().address() as AddressInfo).port;

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
  it("lists all twelve tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "cancel_run",
        "discard_posting",
        "get_health",
        "get_run",
        "get_study_plan",
        "list_postings",
        "list_runs",
        "mark_applied",
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
});

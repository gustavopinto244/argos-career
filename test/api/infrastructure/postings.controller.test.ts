import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ApiModule } from "../../../src/api/infrastructure/api.module";
import { COLLECTOR } from "../../../src/api/infrastructure/collector.provider";
import { NOTIFIER } from "../../../src/api/infrastructure/notifier.provider";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../../src/persistence/infrastructure/postings-repository";
import { createPosting } from "../../../src/posting/domain/posting";
import {
  CollectionResult,
  CollectorPort,
} from "../../../src/posting/domain/ports/collector.port";
import {
  NotifierPort,
  NotifyResult,
} from "../../../src/delivery/domain/ports/notifier.port";
import { Digest } from "../../../src/delivery/domain/digest";

const API_KEY = "test-api-key-for-suite";

// No real network call in this suite (docs/07-testing-strategy.md) —
// ApiModule always wires COLLECTOR/NOTIFIER, even though this controller
// never touches either; these fakes exist only to satisfy DI.
class FakeCollector implements CollectorPort {
  async collect(): Promise<CollectionResult> {
    return { source: "fake", postings: [], collectedAt: new Date() };
  }
}

class FakeNotifier implements NotifierPort {
  async notify(_digest: Digest): Promise<NotifyResult> {
    return { ok: true };
  }
}

let dir: string;
let app: INestApplication;
let db: Db;
let repo: PostingsRepository;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "argos-api-postings-"));
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
  await app.init();

  db = createDatabase(process.env.DATABASE_PATH);
  runMigrations(db);
  repo = new PostingsRepository(db);
});

afterEach(async () => {
  await app.close();
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

function auth(req: request.Test): request.Test {
  return req.set("Authorization", `Bearer ${API_KEY}`);
}

function seedPosting(): string {
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
  return posting.fingerprint;
}

describe("POST /postings/:fingerprint/discard", () => {
  it("requires authentication", async () => {
    await request(app.getHttpServer())
      .post(`/postings/${seedPosting()}/discard`)
      .expect(401);
  });

  it("discards an existing posting and removes it from the digest pool", async () => {
    const fingerprint = seedPosting();
    expect(repo.findUnnotified()).toHaveLength(1);

    const response = await auth(
      request(app.getHttpServer()).post(`/postings/${fingerprint}/discard`),
    )
      .send({ reason: "Not interested in fintech" })
      .expect(201);

    expect(response.body).toEqual({ fingerprint, discarded: true });
    expect(repo.findUnnotified()).toHaveLength(0);
  });

  it("accepts an empty body — reason is optional", async () => {
    const fingerprint = seedPosting();

    await auth(
      request(app.getHttpServer()).post(`/postings/${fingerprint}/discard`),
    ).expect(201);

    expect(repo.findUnnotified()).toHaveLength(0);
  });

  it("returns 404 for a fingerprint that does not exist", async () => {
    await auth(
      request(app.getHttpServer()).post(
        "/postings/no-such-fingerprint/discard",
      ),
    ).expect(404);
  });

  it("is idempotent from the caller's perspective: a second call still succeeds", async () => {
    const fingerprint = seedPosting();

    await auth(
      request(app.getHttpServer()).post(`/postings/${fingerprint}/discard`),
    )
      .send({ reason: "first" })
      .expect(201);

    // Write-once at the storage layer (postings-repository.test.ts covers
    // that the original reason survives) — from the API's perspective,
    // calling discard twice is not an error.
    await auth(
      request(app.getHttpServer()).post(`/postings/${fingerprint}/discard`),
    )
      .send({ reason: "second" })
      .expect(201);
  });
});

describe("POST/DELETE /postings/:fingerprint/applied (ADR-072)", () => {
  it("requires authentication", async () => {
    await request(app.getHttpServer())
      .post(`/postings/${seedPosting()}/applied`)
      .expect(401);
  });

  it("marks a posting applied, then unmarks it — a reversible toggle, unlike discard", async () => {
    const fingerprint = seedPosting();

    const marked = await auth(
      request(app.getHttpServer()).post(`/postings/${fingerprint}/applied`),
    ).expect(201);
    expect(marked.body).toEqual({ fingerprint, applied: true });

    const unmarked = await auth(
      request(app.getHttpServer()).delete(`/postings/${fingerprint}/applied`),
    ).expect(200);
    expect(unmarked.body).toEqual({ fingerprint, applied: false });
  });

  it("returns 404 for a fingerprint that does not exist", async () => {
    await auth(
      request(app.getHttpServer()).post(
        "/postings/no-such-fingerprint/applied",
      ),
    ).expect(404);
    await auth(
      request(app.getHttpServer()).delete(
        "/postings/no-such-fingerprint/applied",
      ),
    ).expect(404);
  });
});

describe("POST/GET /postings/:fingerprint/application-events (ADR-075)", () => {
  it("requires authentication", async () => {
    await request(app.getHttpServer())
      .post(`/postings/${seedPosting()}/application-events`)
      .expect(401);
  });

  it("records an event and reads it back, most recent first", async () => {
    const fingerprint = seedPosting();

    const recorded = await auth(
      request(app.getHttpServer()).post(
        `/postings/${fingerprint}/application-events`,
      ),
    )
      .send({ kind: "response_received", note: "resposta por e-mail" })
      .expect(201);
    expect(recorded.body).toEqual({ fingerprint, kind: "response_received" });

    await auth(
      request(app.getHttpServer()).post(
        `/postings/${fingerprint}/application-events`,
      ),
    )
      .send({ kind: "interview_scheduled" })
      .expect(201);

    const listed = await auth(
      request(app.getHttpServer()).get(
        `/postings/${fingerprint}/application-events`,
      ),
    ).expect(200);
    expect(listed.body.fingerprint).toBe(fingerprint);
    expect(
      (listed.body.events as { kind: string }[]).map((e) => e.kind),
    ).toEqual(["interview_scheduled", "response_received"]);
  });

  it("returns 404 for a fingerprint that does not exist", async () => {
    await auth(
      request(app.getHttpServer()).post(
        "/postings/no-such-fingerprint/application-events",
      ),
    )
      .send({ kind: "rejected" })
      .expect(404);
  });

  it("rejects an unrecognized kind", async () => {
    const fingerprint = seedPosting();
    await auth(
      request(app.getHttpServer()).post(
        `/postings/${fingerprint}/application-events`,
      ),
    )
      .send({ kind: "applied" })
      .expect(500);
  });

  // The REST body has no ValidationPipe behind it (src/main.ts registers
  // none), so the domain factory is the only runtime check on this path.
  // Before it validated occurredAt, this reached the INSERT and came back as
  // a 500 reading `NOT NULL constraint failed: application_events.occurred_at`.
  it("rejects an unparseable occurredAt instead of hitting the database", async () => {
    const fingerprint = seedPosting();
    await auth(
      request(app.getHttpServer()).post(
        `/postings/${fingerprint}/application-events`,
      ),
    )
      .send({ kind: "rejected", occurredAt: "garbage" })
      .expect(500);

    // The point is that nothing was written, not merely that it errored.
    const listed = await auth(
      request(app.getHttpServer()).get(
        `/postings/${fingerprint}/application-events`,
      ),
    ).expect(200);
    expect(listed.body.events).toEqual([]);
  });

  it("accepts a valid ISO occurredAt and stores it verbatim", async () => {
    const fingerprint = seedPosting();
    await auth(
      request(app.getHttpServer()).post(
        `/postings/${fingerprint}/application-events`,
      ),
    )
      .send({ kind: "rejected", occurredAt: "2026-08-28T10:39:19.000Z" })
      .expect(201);

    const listed = await auth(
      request(app.getHttpServer()).get(
        `/postings/${fingerprint}/application-events`,
      ),
    ).expect(200);
    expect(
      (listed.body.events as { occurredAt: string }[])[0]?.occurredAt,
    ).toBe("2026-08-28T10:39:19.000Z");
  });

  it("reads an empty history for a posting with no events, without erroring", async () => {
    const fingerprint = seedPosting();
    const listed = await auth(
      request(app.getHttpServer()).get(
        `/postings/${fingerprint}/application-events`,
      ),
    ).expect(200);
    expect(listed.body).toEqual({ fingerprint, events: [] });
  });
});

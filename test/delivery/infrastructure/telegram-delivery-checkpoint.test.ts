import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Digest } from "../../../src/delivery/domain/digest";
import { renderDigestText } from "../../../src/delivery/domain/render-digest";
import {
  splitForTelegram,
  TelegramNotifier,
} from "../../../src/delivery/infrastructure/telegram-notifier";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { DeliveryOperationsRepository } from "../../../src/persistence/infrastructure/delivery-operations-repository";
import { createPosting } from "../../../src/posting/domain/posting";
import { EMPTY_RECOMMENDATION } from "../../../src/scoring/domain/recommendation";

const NOW = new Date("2026-08-17T12:00:00Z");
const CONFIG = { botToken: "123:abc", chatId: "456" };

let dir: string;
let db: Db;
let repository: DeliveryOperationsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-delivery-checkpoint-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new DeliveryOperationsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function success(messageId: number): Response {
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: messageId } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function multiChunkDigest(): Digest {
  const posting = createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: `Estágio ${"x".repeat(8_500)}`,
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    sourceUrl: "https://example.org/1",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
  });
  return {
    runId: "run-1",
    generatedAt: NOW,
    recommended: [],
    review: [
      {
        posting,
        outcome: {
          score: 50,
          verdict: "review",
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
          ...EMPTY_RECOMMENDATION,
        },
      },
    ],
    periodBlocked: [],
    unreachable: [],
    summary: {
      collected: 1,
      deduplicated: 1,
      filtered: 1,
      scored: 1,
      failedSources: [],
      truncatedSources: [],
    },
  };
}

describe("DeliveryOperationsRepository", () => {
  it("persists a sending chunk across a simulated restart and requires explicit reconciliation", () => {
    const prepared = repository.prepare(
      "telegram:channel",
      "digest-hash",
      ["first", "second"],
      NOW,
    );
    expect(repository.claim(prepared.operationId, "owner-a", NOW, 60_000)).toBe(
      true,
    );
    repository.startChunk(prepared.operationId, 0, NOW);

    const afterRestart = new DeliveryOperationsRepository(db).prepare(
      "telegram:channel",
      "digest-hash",
      ["first", "second"],
      new Date(NOW.getTime() + 1_000),
    );
    expect(afterRestart.chunks.map((chunk) => chunk.state)).toEqual([
      "sending",
      "pending",
    ]);

    repository.reconcileUncertainChunk(
      prepared.operationId,
      0,
      "retry",
      new Date(NOW.getTime() + 2_000),
    );
    expect(
      repository.prepare(
        "telegram:channel",
        "digest-hash",
        ["first", "second"],
        new Date(NOW.getTime() + 3_000),
      ).chunks[0]?.state,
    ).toBe("pending");
  });

  it("does not let another owner claim an active lease, but allows takeover after expiry", () => {
    const prepared = repository.prepare("channel", "hash", ["body"], NOW);
    expect(repository.claim(prepared.operationId, "owner-a", NOW, 1_000)).toBe(
      true,
    );
    expect(
      repository.claim(
        prepared.operationId,
        "owner-b",
        new Date(NOW.getTime() + 999),
        1_000,
      ),
    ).toBe(false);
    expect(
      repository.claim(
        prepared.operationId,
        "owner-b",
        new Date(NOW.getTime() + 1_001),
        1_000,
      ),
    ).toBe(true);
  });

  it("rejects a different chunk manifest for the same delivery identity", () => {
    repository.prepare("channel", "hash", ["original"], NOW);
    expect(() =>
      repository.prepare("channel", "hash", ["changed"], NOW),
    ).toThrow(/does not match/);
  });
});

describe("TelegramNotifier durable chunk resume", () => {
  it("finalizes an all-confirmed operation left open by a crash", async () => {
    const digest = multiChunkDigest();
    const text = renderDigestText(digest);
    const chunks = splitForTelegram(text);
    const channelKey = createHash("sha256")
      .update(`telegram:${CONFIG.chatId}`)
      .digest("hex");
    const contentHash = createHash("sha256").update(text).digest("hex");
    const prepared = repository.prepare(channelKey, contentHash, chunks, NOW);
    expect(repository.claim(prepared.operationId, "crashed", NOW, 60_000)).toBe(
      true,
    );
    chunks.forEach((_chunk, index) => {
      repository.startChunk(prepared.operationId, index, NOW);
      repository.confirmChunk(prepared.operationId, index, 100 + index, NOW);
    });

    const fetchImpl = vi.fn<typeof fetch>();
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      deliveryStore: repository,
      now: () => new Date(NOW.getTime() + 1_000),
    });

    await expect(notifier.notify(digest)).resolves.toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      repository.claim(
        prepared.operationId,
        "another-owner",
        new Date(NOW.getTime() + 2_000),
        60_000,
      ),
    ).toBe(false);
  });

  it("retries only the failed and remaining chunks, then makes the operation idempotent", async () => {
    const digest = multiChunkDigest();
    const chunkCount = splitForTelegram(renderDigestText(digest)).length;
    expect(chunkCount).toBeGreaterThan(2);

    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(success(101))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const firstNotifier = new TelegramNotifier(CONFIG, firstFetch, {
      pacingMs: 0,
      deliveryStore: repository,
      now: () => NOW,
    });
    await expect(firstNotifier.notify(digest)).resolves.toMatchObject({
      ok: false,
      error: {
        message: expect.stringMatching(/delivery [a-f0-9]{64} chunk 1/),
      },
    });
    expect(firstFetch).toHaveBeenCalledTimes(2);

    let nextMessageId = 200;
    const retryFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(success(nextMessageId++)),
    );
    const retryNotifier = new TelegramNotifier(CONFIG, retryFetch, {
      pacingMs: 0,
      deliveryStore: new DeliveryOperationsRepository(db),
      now: () => new Date(NOW.getTime() + 1_000),
    });
    await expect(retryNotifier.notify(digest)).resolves.toEqual({ ok: true });
    expect(retryFetch).toHaveBeenCalledTimes(chunkCount - 1);

    const duplicateFetch = vi.fn<typeof fetch>();
    const duplicateNotifier = new TelegramNotifier(CONFIG, duplicateFetch, {
      pacingMs: 0,
      deliveryStore: new DeliveryOperationsRepository(db),
      now: () => new Date(NOW.getTime() + 2_000),
    });
    await expect(duplicateNotifier.notify(digest)).resolves.toEqual({
      ok: true,
    });
    expect(duplicateFetch).not.toHaveBeenCalled();
  });

  it("leaves a never-opened connection retryable by the next run, not stuck uncertain (ADR-065)", async () => {
    // Reproduces the 2026-08-25 incident: the digest was composed in full,
    // the send failed at the transport, and the chunk was left `uncertain`
    // — which `sendDurable` refuses to re-send. The posting was only
    // delivered 24h later, by the next night's freshly-composed digest.
    const digest = multiChunkDigest();
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });

    const failingFetch = vi.fn<typeof fetch>(async () => {
      throw refused;
    });
    const failingNotifier = new TelegramNotifier(CONFIG, failingFetch, {
      pacingMs: 0,
      maxRetries: 1,
      transportRetryBaseMs: 0,
      deliveryStore: repository,
      now: () => NOW,
    });
    await expect(failingNotifier.notify(digest)).resolves.toMatchObject({
      ok: false,
    });

    // The point of the fix: the chunk is left `failed`, not `uncertain`, so
    // the next run delivers it rather than refusing with "reconcile it
    // before retrying" — which is what the assertion below proves.
    let nextMessageId = 300;
    const retryFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(success(nextMessageId++)),
    );
    const retryNotifier = new TelegramNotifier(CONFIG, retryFetch, {
      pacingMs: 0,
      deliveryStore: new DeliveryOperationsRepository(db),
      now: () => new Date(NOW.getTime() + 1_000),
    });
    await expect(retryNotifier.notify(digest)).resolves.toEqual({ ok: true });
    expect(retryFetch).toHaveBeenCalled();
  });

  it("still refuses to re-send after a timeout, which may have been delivered (ADR-065)", async () => {
    // The guard this change must not weaken. An AbortError leaves the chunk
    // uncertain on purpose: re-sending could post the digest twice.
    const digest = multiChunkDigest();
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });

    const failingFetch = vi.fn<typeof fetch>(async () => {
      throw aborted;
    });
    const failingNotifier = new TelegramNotifier(CONFIG, failingFetch, {
      pacingMs: 0,
      transportRetryBaseMs: 0,
      deliveryStore: repository,
      now: () => NOW,
    });
    await expect(failingNotifier.notify(digest)).resolves.toMatchObject({
      ok: false,
    });

    const retryFetch = vi.fn<typeof fetch>();
    const retryNotifier = new TelegramNotifier(CONFIG, retryFetch, {
      pacingMs: 0,
      deliveryStore: new DeliveryOperationsRepository(db),
      now: () => new Date(NOW.getTime() + 1_000),
    });
    await expect(retryNotifier.notify(digest)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("uncertain chunk") },
    });
    expect(retryFetch).not.toHaveBeenCalled();
  });
});

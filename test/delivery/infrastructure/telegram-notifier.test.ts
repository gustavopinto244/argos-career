import { describe, expect, it, vi } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { ScoreOutcome } from "../../../src/scoring/domain/types";
import {
  EMPTY_RECOMMENDATION,
  Recommendation,
} from "../../../src/scoring/domain/recommendation";
import { Digest, ScoredPosting } from "../../../src/delivery/domain/digest";
import {
  TelegramNotifier,
  splitForTelegram,
} from "../../../src/delivery/infrastructure/telegram-notifier";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

const NOW = new Date("2026-08-14T03:00:00Z");
const CONFIG = { botToken: "123:abc", chatId: "456" };

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    sourceUrl: "https://example.org/vagas/1",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

function outcome(
  overrides: Partial<ScoreOutcome & Recommendation> = {},
): ScoreOutcome & Recommendation {
  return {
    score: 62,
    verdict: "review",
    breakdown: {
      mandatoryCoverage: 1,
      desirableCoverage: 1,
      trackAlignment: 1,
    },
    blockingFailure: null,
    blockingFailures: [],
    lowConfidence: true,
    criticalGaps: [],
    periodGate: null,
    ...EMPTY_RECOMMENDATION,
    ...overrides,
  };
}

function emptyDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    runId: "run-1",
    generatedAt: NOW,
    recommended: [],
    review: [],
    periodBlocked: [],
    summary: {
      collected: 0,
      deduplicated: 0,
      filtered: 0,
      scored: 0,
      failedSources: [],
      truncatedSources: [],
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function rateLimited(retryAfterSeconds?: number): Response {
  return jsonResponse(
    {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after " + retryAfterSeconds,
      ...(retryAfterSeconds === undefined
        ? {}
        : { parameters: { retry_after: retryAfterSeconds } }),
    },
    { status: 429 },
  );
}

// No test lets real pacing/retry delays elapse — either pacingMs: 0 for
// tests that don't care about it, or fake timers for tests that do.
const NO_PACING = { pacingMs: 0 };

function manyScoredEntries(count: number): ScoredPosting[] {
  const scored: ScoredPosting = { posting: posting(), outcome: outcome() };
  return Array.from({ length: count }, (_, i) => ({
    ...scored,
    posting: posting({
      sourceId: String(i),
      sourceUrl: `https://example.org/${i}`,
    }),
  }));
}

describe("splitForTelegram", () => {
  it("returns a single chunk when the whole text fits under the limit", () => {
    const chunks = splitForTelegram("a\n\n---\n\nb\n\n---\n\nc");
    expect(chunks).toEqual(["a\n\n---\n\nb\n\n---\n\nc"]);
  });

  it("splits into multiple chunks when sections together exceed the limit", () => {
    const section = "x".repeat(3000);
    const text = [section, section, section].join("\n\n---\n\n");
    const chunks = splitForTelegram(text, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    expect(chunks.join("")).toContain(section);
  });

  it("splits a single oversized section on its entry boundaries", () => {
    const entry = "y".repeat(2000);
    const oversizedSection = [entry, entry, entry].join("\n\n");
    const chunks = splitForTelegram(oversizedSection, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

describe("TelegramNotifier — success", () => {
  it("sends one request for a digest that fits in one message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 101 } }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts to the sendMessage endpoint with the configured chat id and bot token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 101 } }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    await notifier.notify(emptyDigest());

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(init.body as string) as {
      chat_id: string;
      text: string;
    };
    expect(body.chat_id).toBe("456");
    expect(body.text).toContain("Resumo da execução");
  });

  it("sends one request per chunk for a digest large enough to need several", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 101 } }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, NO_PACING);

    const result = await notifier.notify(
      emptyDigest({ review: manyScoredEntries(80) }),
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("TelegramNotifier — pacing between chunks (docs/11 B3)", () => {
  it("waits pacingMs before sending each chunk after the first", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ ok: true, result: { message_id: 101 } }),
      );
      const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
        pacingMs: 1_100,
      });

      const promise = notifier.notify(
        emptyDigest({ review: manyScoredEntries(80) }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const afterFirstChunk = fetchImpl.mock.calls.length;
      expect(afterFirstChunk).toBeGreaterThanOrEqual(1);

      // Still paced, not yet fired: fetchImpl's call count hasn't grown just
      // from letting microtasks flush.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl.mock.calls.length).toBe(afterFirstChunk);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirstChunk);

      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait before the very first chunk", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ ok: true, result: { message_id: 101 } }),
      );
      const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
        pacingMs: 60_000,
      });

      const promise = notifier.notify(emptyDigest());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.runAllTimersAsync();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TelegramNotifier — 429 retry, honoring retry_after (docs/11 B3)", () => {
  it("retries once retry_after elapses, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(rateLimited(5))
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, result: { message_id: 101 } }),
        );
      const notifier = new TelegramNotifier(CONFIG, fetchImpl, NO_PACING);

      const promise = notifier.notify(emptyDigest());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Not yet retried at less than the stated 5s.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up and reports failure after exhausting maxRetries on persistent 429", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => rateLimited(0));
      const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
        ...NO_PACING,
        maxRetries: 2,
      });

      const promise = notifier.notify(emptyDigest());
      const result = await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        return promise;
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("429");
        expect(result.error.message).toContain("2 retries");
      }
      // Initial attempt + 2 retries, never more.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a default wait when retry_after is missing", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(rateLimited(undefined))
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, result: { message_id: 101 } }),
        );
      const notifier = new TelegramNotifier(CONFIG, fetchImpl, NO_PACING);

      const promise = notifier.notify(emptyDigest());
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps an excessive retry_after at retryAfterCapMs rather than waiting the full stated time", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(rateLimited(3_600)) // an hour, stated
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, result: { message_id: 101 } }),
        );
      const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
        ...NO_PACING,
        retryAfterCapMs: 10_000,
      });

      const promise = notifier.notify(emptyDigest());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Capped well under the stated hour.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TelegramNotifier — failure, never throws", () => {
  it("returns ok:false with the status and body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Forbidden: bot was blocked", { status: 403 }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("403");
      expect(result.error.message).not.toContain("bot was blocked");
    }
  });

  it("returns ok:false, not a throw, when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Telegram request failed");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("retries a connection that never opened, then succeeds (ADR-065)", async () => {
    // ECONNREFUSED proves nothing was delivered, so retrying cannot
    // duplicate the digest. Before ADR-065 this returned on the first
    // throw and left the chunk uncertain.
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw refused;
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    });
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      transportRetryBaseMs: 0,
    });

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry a timeout, which may already have been delivered (ADR-065)", async () => {
    // The distinction the whole change rests on: an AbortError means the
    // request may have arrived while the response was in flight. Retrying
    // would send the digest twice.
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    const fetchImpl = vi.fn(async () => {
      throw aborted;
    });
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      transportRetryBaseMs: 0,
    });

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a connection that broke mid-flight (ADR-065)", async () => {
    // ECONNRESET is deliberately absent from NEVER_SENT_ERROR_CODES: the
    // request may have been fully sent before the socket died.
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      }),
    });
    const fetchImpl = vi.fn(async () => {
      throw reset;
    });
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      transportRetryBaseMs: 0,
    });

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries on a connection that never opened", async () => {
    const unresolved = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "ENOTFOUND",
      }),
    });
    const fetchImpl = vi.fn(async () => {
      throw unresolved;
    });
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      maxRetries: 2,
      transportRetryBaseMs: 0,
    });

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    // Initial attempt plus two retries.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats a 2xx response without message_id as an uncertain failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: {} }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("message_id");
  });

  it("bounds a Telegram acknowledgement body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        result: { message_id: 101 },
        padding: "x".repeat(2_000),
      }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      maxResponseBytes: 256,
    });

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe("Telegram request failed");
  });

  it("times out while reading a stalled 2xx acknowledgement body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true'));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, {
      timeoutMs: 20,
    });

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe("Telegram request failed");
  });

  it("stops sending further chunks once one chunk fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, result: { message_id: 101 } }),
      )
      .mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, NO_PACING);

    const result = await notifier.notify(
      emptyDigest({ review: manyScoredEntries(80) }),
    );

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a plain 5xx the way it retries a 429", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl, NO_PACING);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts a request that never resolves, rather than hanging forever (docs/audit AC-022)", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    const notifier = new TelegramNotifier(
      CONFIG,
      fetchImpl as unknown as typeof fetch,
      { ...NO_PACING, timeoutMs: 50 },
    );

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Telegram request failed");
      expect(result.error.cause).toBeInstanceOf(DOMException);
    }
  });
});

describe("TelegramNotifier.sendText — M8 alerts", () => {
  it("posts plain text to the same sendMessage endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { message_id: 101 } }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.sendText("gupy: 2 consecutive runs failed.");

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe("gupy: 2 consecutive runs failed.");
  });

  it("returns ok:false, not a throw, on a failed send", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.sendText("alert");

    expect(result.ok).toBe(false);
  });
});

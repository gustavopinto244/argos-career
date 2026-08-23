import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../../src/scoring/infrastructure/circuit-breaker";
import {
  LlmTransportError,
  OpenRouterClient,
} from "../../../src/scoring/infrastructure/openrouter-client";

const ZERO_OUTCOMES = {
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
};

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function client(fetchImpl: typeof fetch): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: "test-key",
    model: "test/model",
    fetchImpl,
  });
}

describe("OpenRouterClient.complete — success", () => {
  it("returns the first choice's message content", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "hello" } }] }),
    );

    await expect(client(fetchImpl).complete("prompt")).resolves.toBe("hello");
  });

  it("posts the model, messages, and bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    await client(fetchImpl).complete("say hi");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    expect(
      (init.headers as Record<string, string>)["X-OpenRouter-Metadata"],
    ).toBe("enabled");
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
    };
    expect(body.model).toBe("test/model");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
    expect(body.max_tokens).toBe(2_048);
  });

  it("applies completion limits per operation and accounts by stage", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const c = client(fetchImpl);

    await c.complete("stage A prompt", {
      stage: "stage-a",
      timeoutMs: 120_000,
      maxCompletionTokens: 1_234,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(1_234);
    expect(c.getUsage().attemptsByStageOutcome["stage-a"].success).toBe(1);
    expect(c.getUsage().attemptsByStageOutcome.unknown.success).toBe(0);
  });

  it("caps reasoning tokens when reasoningMaxTokens is set (ADR-052 Amendment 2)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    await client(fetchImpl).complete("stage A prompt", {
      reasoningMaxTokens: 3_000,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      reasoning?: { max_tokens: number };
    };
    expect(body.reasoning).toEqual({ max_tokens: 3_000 });
  });

  it("rejects a non-positive reasoningMaxTokens without making a network call", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const error = await client(fetchImpl)
      .complete("prompt", { reasoningMaxTokens: 0 })
      .catch((cause: unknown) => cause);

    expect((error as Error).message).toMatch(/reasoningMaxTokens/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("omits the reasoning field when reasoningMaxTokens is not set", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    await client(fetchImpl).complete("say hi");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      reasoning?: unknown;
    };
    expect(body.reasoning).toBeUndefined();
  });

  it("sends provider.ignore when ignoredProviders is configured (ADR-056)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const c = new OpenRouterClient({
      apiKey: "test-key",
      model: "test/model",
      fetchImpl,
      ignoredProviders: ["sail-research", "some-other"],
    });
    await c.complete("say hi");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      provider?: { ignore?: string[] };
    };
    expect(body.provider).toEqual({
      ignore: ["sail-research", "some-other"],
    });
  });

  it("omits the provider field entirely when no providers are ignored", async () => {
    // The default request body must stay byte-identical to what it was
    // before ADR-056 existed — an empty `provider.ignore` is not the same
    // thing as not constraining routing at all.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    await client(fetchImpl).complete("say hi");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as { provider?: unknown };
    expect(body.provider).toBeUndefined();
  });

  it("respects a custom baseUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      baseUrl: "http://localhost:1234/v1",
      fetchImpl,
    });
    await c.complete("prompt");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
  });
});

describe("OpenRouterClient.complete — failure, throws with a clear message", () => {
  it("throws with the status but never echoes a provider response body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("insufficient credits", { status: 402 }),
    );
    const error = await client(fetchImpl)
      .complete("prompt")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as Error).message).toContain("402");
    expect((error as Error).message).not.toContain("insufficient credits");
  });

  it("throws an LlmTransportError carrying the failure category, not just a message (docs/audit AC-016)", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const error = await client(fetchImpl)
      .complete("prompt")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).category).toBe("serverError");
    expect((error as LlmTransportError).status).toBe(500);
  });

  it("throws on a malformed (non-JSON) response body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /malformed/i,
    );
  });

  it("throws when the response has an empty choices array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /unexpected/i,
    );
  });

  it("throws when the response is missing choices entirely", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /unexpected/i,
    );
  });

  it("classifies a top-level provider error carried by HTTP 200", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: "gen-test-1",
        model: "deepseek/test",
        error: {
          code: 503,
          message: "upstream echoed content that must not be persisted",
          metadata: { error_type: "provider_overloaded" },
        },
        openrouter_metadata: {
          attempts: [
            { provider: "Chutes", model: "deepseek/test", status: 503 },
          ],
        },
        usage: { prompt_tokens: 20, completion_tokens: 0, cost: 0.002 },
      }),
    );
    const c = client(fetchImpl);

    const error = await c
      .complete("prompt", { stage: "stage-a" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmTransportError);
    expect(error).toMatchObject({
      category: "providerError",
      errorType: "provider_overloaded",
      provider: "Chutes",
      model: "deepseek/test",
      generationId: "gen-test-1",
      status: 200,
    });
    expect((error as Error).message).not.toContain("echoed content");
    const usage = c.getUsage();
    expect(usage.attemptsByOutcome.providerError).toBe(1);
    expect(usage.attemptsByOutcome.invalidOutput).toBe(0);
    expect(usage.attemptsByStageOutcome["stage-a"].providerError).toBe(1);
    expect(usage.providerCounts).toEqual({ Chutes: 1 });
    expect(usage.errorTypeCounts).toEqual({ provider_overloaded: 1 });
    expect(usage.costUsd).toBeCloseTo(0.002);
  });

  it("classifies a choice-level in-band error instead of returning partial content", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: { content: "partial output" },
            finish_reason: "error",
            error: {
              code: 429,
              message: "rate limited",
              metadata: { error_type: "rate_limit_exceeded" },
            },
          },
        ],
        provider: "DeepInfra",
      }),
    );

    const error = await client(fetchImpl)
      .complete("prompt", { stage: "stage-b" })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      category: "rateLimited",
      errorType: "rate_limit_exceeded",
      provider: "DeepInfra",
      finishReason: "error",
    });
  });

  it("throws when fetch itself rejects (network failure)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /connection reset/,
    );
  });

  it("aborts and throws once the timeout elapses", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("This operation was aborted"));
          });
        }),
    );
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    });

    await expect(c.complete("prompt")).rejects.toThrow(/aborted/i);
  });

  it("times out while reading a success body that stalls after headers", async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":['));
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      timeoutMs: 5,
    });

    const error = await c.complete("prompt").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).category).toBe("timeout");
    expect(c.getUsage().attemptsByOutcome.timeout).toBe(1);
  });

  it("rejects an oversized response body before parsing it", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("123456", { status: 200 }),
    );
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      maxResponseBytes: 5,
    });

    const error = await c.complete("prompt").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).category).toBe("invalidEnvelope");
  });

  it.each([
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ maxCompletionTokens: 0 }, /maxCompletionTokens/],
    [{ maxResponseBytes: 0 }, /maxResponseBytes/],
  ] as const)("rejects invalid client bounds", (bounds, error) => {
    expect(
      () =>
        new OpenRouterClient({
          apiKey: "k",
          model: "m",
          fetchImpl: vi.fn(),
          ...bounds,
        }),
    ).toThrow(error);
  });
});

describe("OpenRouterClient.getUsage — attempt accounting (docs/audit AC-015)", () => {
  it("counts a successful call under both calls and attempts", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "x" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      }),
    );
    const c = client(fetchImpl);
    await c.complete("prompt");

    const usage = c.getUsage();
    expect(usage.calls).toBe(1);
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome).toEqual({ ...ZERO_OUTCOMES, success: 1 });
    expect(usage.attemptsWithoutUsage).toBe(0);
    expect(usage.costUsd).toBeCloseTo(0.001);
  });

  it("counts a non-2xx response as an attempt, not just a thrown error", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("insufficient credits", { status: 402 }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.calls).toBe(0);
    expect(usage.attempts).toBe(1);
    // Insufficient account credit is run-wide: every remaining posting would
    // fail identically, so it belongs to the batch-fatal configuration bucket.
    expect(usage.attemptsByOutcome.configError).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
  });

  it("counts a malformed body as an attempt", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.invalidEnvelope).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
  });

  it("counts an unexpected shape as an attempt, distinct from invalidEnvelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.invalidOutput).toBe(1);
  });

  it("counts a network failure (fetch throws) as an attempt", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.networkError).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
  });

  it("counts a timeout as its own outcome, distinct from a generic network error", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("This operation was aborted"));
          });
        }),
    );
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    });
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.timeout).toBe(1);
    expect(usage.attemptsByOutcome.networkError).toBe(0);
  });

  it("captures usage from a 2xx envelope even when the chat shape is invalid (AC-015)", async () => {
    // The regression this guards: a response that is valid JSON and even
    // has a real `usage` block, but happens to have no choices — the
    // provider still reported (and presumably billed) real usage, which
    // must not be thrown away just because Stage A/B's shape check fails.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 0, cost: 0.002 },
      }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow(/unexpected/i);

    const usage = c.getUsage();
    expect(usage.calls).toBe(0);
    expect(usage.promptTokens).toBe(20);
    expect(usage.costUsd).toBeCloseTo(0.002);
    expect(usage.attemptsWithoutUsage).toBe(0);
  });

  it("counts a successful response with no usage field as attemptsWithoutUsage", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const c = client(fetchImpl);
    await c.complete("prompt");

    const usage = c.getUsage();
    expect(usage.calls).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
    expect(usage.costUsd).toBe(0);
  });

  it("does not let malformed negative usage decrement accounting totals", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "x" } }],
        usage: { prompt_tokens: -10, completion_tokens: -5, cost: -1 },
      }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).resolves.toBe("x");

    const usage = c.getUsage();
    expect(usage.calls).toBe(1);
    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
    expect(usage.costUsd).toBe(0);
    expect(usage.attemptsWithoutUsage).toBe(1);
    expect(usage.attemptsByOutcome.success).toBe(1);
  });

  it("accumulates attempts and outcomes across multiple calls on the same client", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response("boom", { status: 500 })
        : jsonResponse({
            choices: [{ message: { content: "x" } }],
            usage: { cost: 0.001 },
          });
    });
    const c = client(fetchImpl);

    await expect(c.complete("p1")).rejects.toThrow();
    await c.complete("p2");

    const usage = c.getUsage();
    expect(usage.attempts).toBe(2);
    expect(usage.calls).toBe(1);
    expect(usage.attemptsByOutcome).toEqual({
      ...ZERO_OUTCOMES,
      success: 1,
      serverError: 1,
    });
    expect(usage.attemptsWithoutUsage).toBe(1);
  });
});

describe("OpenRouterClient.complete — HTTP status taxonomy (docs/audit AC-016)", () => {
  it.each([
    [401, "authError"],
    [403, "authError"],
    [408, "timeout"],
    [429, "rateLimited"],
    [400, "requestError"],
    [402, "configError"],
    [404, "configError"],
    [422, "requestError"],
    [500, "serverError"],
    [507, "serverError"],
    [502, "providerError"],
    [503, "providerError"],
    [504, "providerError"],
  ] as const)("classifies status %i as %s", async (status, category) => {
    const fetchImpl = vi.fn(async () => new Response("x", { status }));
    const c = client(fetchImpl);
    const error = await c.complete("prompt").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).category).toBe(category);
    expect(c.getUsage().attemptsByOutcome[category]).toBe(1);
  });

  it("parses a numeric Retry-After header into milliseconds, clamped to a sane ceiling", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
    );
    const error = await client(fetchImpl)
      .complete("prompt")
      .catch((e: unknown) => e);

    expect((error as LlmTransportError).retryAfterMs).toBe(2000);
  });

  it("clamps an unreasonably large Retry-After rather than obeying it verbatim", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "3600" },
        }),
    );
    const error = await client(fetchImpl)
      .complete("prompt")
      .catch((e: unknown) => e);

    expect((error as LlmTransportError).retryAfterMs).toBe(30_000);
  });

  it("parses an HTTP-date Retry-After header relative to now", async () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const fetchImpl = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": future },
        }),
    );
    const error = await client(fetchImpl)
      .complete("prompt")
      .catch((e: unknown) => e);

    const retryAfterMs = (error as LlmTransportError).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(3_000);
    expect(retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it("leaves retryAfterMs undefined when the header is absent or unparseable", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "not a date or a number" },
        }),
    );
    const error = await client(fetchImpl)
      .complete("prompt")
      .catch((e: unknown) => e);

    expect((error as LlmTransportError).retryAfterMs).toBeUndefined();
  });
});

describe("OpenRouterClient.complete — circuit breaker (docs/audit AC-016)", () => {
  it("blocks calls without reaching fetch once the breaker is open", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => clock,
    });
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      circuitBreaker: breaker,
    });

    await expect(c.complete("p1")).rejects.toThrow();
    await expect(c.complete("p2")).rejects.toThrow();
    await expect(c.complete("p3")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const error = await c.complete("p4").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).category).toBe("circuitOpen");
    expect(fetchImpl).toHaveBeenCalledTimes(3); // blocked, not a 4th network call

    const usage = c.getUsage();
    expect(usage.attempts).toBe(3);
    expect(usage.blockedByCircuit).toBe(1);
  });

  it("allows one trial call through after the cooldown, and closes again on success", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call <= 2
        ? new Response("boom", { status: 500 })
        : jsonResponse({ choices: [{ message: { content: "recovered" } }] });
    });
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      circuitBreaker: breaker,
    });

    await expect(c.complete("p1")).rejects.toThrow();
    await expect(c.complete("p2")).rejects.toThrow();
    // Breaker is open now -- blocked without reaching fetch.
    await expect(c.complete("p3")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock += 10_000; // cooldown elapsed
    await expect(c.complete("p4")).resolves.toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // Closed again -- a subsequent failure needs the full threshold once more.
    await expect(c.complete("p5")).resolves.toBe("recovered");
  });

  it("does not count a permanent failure (auth/config) toward opening the breaker", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      circuitBreaker: breaker,
    });

    await expect(c.complete("p1")).rejects.toThrow();
    await expect(c.complete("p2")).rejects.toThrow();
    await expect(c.complete("p3")).rejects.toThrow();

    // Still closed -- every failure reached fetch, none were blocked.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(c.getUsage().blockedByCircuit).toBe(0);
  });

  it("does not open the breaker on repeated content-local failures (invalidOutput, docs/audit PR-009)", async () => {
    // Five content-filtered/empty-choices responses across five different
    // postings say nothing about whether the provider itself is up -- the
    // real-world scenario PR-009 names: before this, exactly this pattern
    // tripped the shared breaker and blocked every other posting's calls.
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    const clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      circuitBreaker: breaker,
    });

    await expect(c.complete("p1")).rejects.toThrow();
    await expect(c.complete("p2")).rejects.toThrow();
    await expect(c.complete("p3")).rejects.toThrow();

    // Still closed -- an unrelated posting's call must not be blocked.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(c.getUsage().blockedByCircuit).toBe(0);
  });

  it("does not open the breaker on repeated content-local failures (invalidEnvelope)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200 }),
    );
    const clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      circuitBreaker: breaker,
    });

    await expect(c.complete("p1")).rejects.toThrow();
    await expect(c.complete("p2")).rejects.toThrow();
    await expect(c.complete("p3")).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(c.getUsage().blockedByCircuit).toBe(0);
  });

  it("still opens the breaker on repeated transport-level failures (serverError)", async () => {
    // The other half of PR-009's distinction: a real 5xx run IS evidence
    // the provider is degraded, and must still trip the breaker.
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl,
      circuitBreaker: breaker,
    });

    await expect(c.complete("p1")).rejects.toThrow();
    await expect(c.complete("p2")).rejects.toThrow();

    const error = await c.complete("p3").catch((e: unknown) => e);
    expect((error as LlmTransportError).category).toBe("circuitOpen");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

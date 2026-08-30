import { describe, expect, it, vi } from "vitest";
import {
  fetchWithDeadline,
  ResponseTooLargeError,
} from "../../../src/posting/infrastructure/fetch-with-deadline";

const UA = "ArgosCareer/test";

function options(overrides: Partial<Parameters<typeof fetchWithDeadline>[1]>) {
  return {
    fetchImpl: vi.fn() as unknown as typeof fetch,
    timeoutMs: 50,
    backoffDelaysMs: [],
    userAgent: UA,
    source: "TestSource",
    ...overrides,
  };
}

/**
 * A response whose headers arrive immediately and whose body then stalls —
 * the exact shape the old per-collector copy could not bound, because it
 * cleared its `AbortController` timer the moment `fetch` resolved.
 */
function stallingBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'));
      // ...and never another chunk, never a close.
    },
  });
  return new Response(body, { status: 200 });
}

describe("fetchWithDeadline", () => {
  it("returns the body of a successful response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"data":[1,2]}', { status: 200 }),
    );
    const result = await fetchWithDeadline(
      "https://example.test/jobs",
      options({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ data: [1, 2] });
  });

  it("sends the honest User-Agent CLAUDE.md §6 requires", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    });
    await fetchWithDeadline(
      "https://example.test/jobs",
      options({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(UA);
  });

  // The defect this module exists for. Before it, `clearTimeout(timer)` ran
  // in a `finally` triggered by the headers arriving, so the body read had no
  // deadline at all and fell back to undici's 300s default — per request and
  // per retry, on a collector configured for 10s.
  it("aborts a response whose body stalls after the headers arrive", async () => {
    const fetchImpl = vi.fn(async () => stallingBodyResponse());

    await expect(
      fetchWithDeadline(
        "https://example.test/jobs",
        options({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          timeoutMs: 40,
        }),
      ),
    ).rejects.toThrow(/abort/i);
  });

  it("does not spend longer than the timeout on a stalled body", async () => {
    const fetchImpl = vi.fn(async () => stallingBodyResponse());
    const startedAt = Date.now();

    await fetchWithDeadline(
      "https://example.test/jobs",
      options({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 40,
      }),
    ).catch(() => undefined);

    // Generous ceiling: the point is that it is bounded at all, not the exact
    // figure. Unbounded, this test would sit here for undici's 300s.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("refuses a body over the size cap without retrying it", async () => {
    const huge = "x".repeat(4096);
    const fetchImpl = vi.fn(async () => new Response(huge, { status: 200 }));

    await expect(
      fetchWithDeadline(
        "https://example.test/jobs",
        options({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          maxResponseBytes: 1024,
          backoffDelaysMs: [1, 1],
        }),
      ),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);

    // Deterministic: a second attempt produces the same oversized response.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and returns the eventual success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchWithDeadline(
      "https://example.test/jobs",
      options({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffDelaysMs: [1],
      }),
    );

    expect(result.body).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns a 4xx as-is rather than retrying it", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    );

    const result = await fetchWithDeadline(
      "https://example.test/jobs",
      options({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffDelaysMs: [1, 1],
      }),
    );

    // Collector etiquette (CLAUDE.md §6): the request itself is wrong, so
    // repeating it wastes the source's time for no different outcome.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown transport failure and throws the last one when exhausted", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(
      fetchWithDeadline(
        "https://example.test/jobs",
        options({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          backoffDelaysMs: [1, 1],
        }),
      ),
    ).rejects.toThrow("ECONNRESET");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // A body-read failure used to happen outside the retry loop entirely,
  // because the read was in the caller. It is a transport failure like any
  // other, and the page should not be lost to one.
  it("retries a body that fails mid-read", async () => {
    const failing = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("socket hang up"));
          },
        }),
        { status: 200 },
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failing())
      .mockResolvedValueOnce(new Response("recovered", { status: 200 }));

    const result = await fetchWithDeadline(
      "https://example.test/jobs",
      options({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffDelaysMs: [1],
      }),
    );

    expect(result.body).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("carries statusText through, which four collectors print", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 404, statusText: "Not Found" }),
    );
    const result = await fetchWithDeadline(
      "https://example.test/jobs",
      options({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(result.statusText).toBe("Not Found");
  });
});

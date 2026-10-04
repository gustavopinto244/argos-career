import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GupyCollector } from "../../../src/posting/infrastructure/gupy-collector";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function curatedFixture(): unknown {
  const path = join(process.cwd(), "test", "fixtures", "gupy-jobs.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

// Test-only overrides so contract tests don't sit through real backoff
// delays or the 1.5s inter-page interval.
const FAST_OPTIONS = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1, 1],
};

describe("GupyCollector — never throws", () => {
  it("returns an error result on a non-200 response, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("500");
  });

  it("returns an error result on a 4xx without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an error result when the request times out, never throwing", async () => {
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
    const collector = new GupyCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on a malformed (non-JSON) body, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("Malformed");
  });

  it("returns an error result on an empty body, never throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on a response shaped without a data array, never throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notData: [] }));
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("shape");
  });

  it("returns an error result when the connection is reset, never throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on invalid criteria, never throwing", async () => {
    const fetchImpl = vi.fn();
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: "not a number" });

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("Invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps postings from a successful first page when the second page fails (docs/audit AC-004)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          data: Array.from({ length: 10 }, (_, i) => ({
            id: i,
            name: "Estágio",
          })),
        });
      }
      return new Response("Server Error", { status: 500 });
    });
    const collector = new GupyCollector({
      fetchImpl,
      timeoutMs: 50,
      requestIntervalMs: 0,
      backoffDelaysMs: [1, 1],
    });

    const result = await collector.collect({ maxResults: 20, pageSize: 10 });

    expect(result.postings).toHaveLength(10);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("Gupy request failed");
  });
});

describe("GupyCollector — retry and backoff", () => {
  it("retries a 5xx and succeeds once the server recovers", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return new Response("Server Error", { status: 503 });
      return jsonResponse(curatedFixture());
    });
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 4 });

    expect(result.error).toBeUndefined();
    expect(result.postings.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  it("gives up and reports an error after exhausting all backoff attempts", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 503 }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(
      FAST_OPTIONS.backoffDelaysMs.length + 1,
    );
  });
});

describe("GupyCollector — successful collection", () => {
  it("wraps every valid item from the curated fixture as a RawPosting", async () => {
    const fixture = curatedFixture() as { data: { id: number }[] };
    const fetchImpl = vi.fn(async () => jsonResponse(fixture));
    const collector = new GupyCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    const result = await collector.collect({ maxResults: fixture.data.length });

    expect(result.error).toBeUndefined();
    expect(result.source).toBe("gupy");
    expect(result.postings).toHaveLength(fixture.data.length);
    expect(result.postings.map((p) => p.sourceId).sort()).toEqual(
      fixture.data.map((j) => String(j.id)).sort(),
    );
    for (const posting of result.postings) {
      expect(posting.source).toBe("gupy");
      expect(posting.payload).toBeDefined();
    }
  });

  it("sends the honest User-Agent header, never a forged browser one", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: [] }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({});

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was not called");
    const [, init] = call as [string, RequestInit];
    const userAgent = (init.headers as Record<string, string>)["User-Agent"];
    expect(userAgent).toContain("ArgosCareer");
    expect(userAgent).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("uses the current public portal endpoint and preserves its query contract", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: [] }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({
      jobName: "estágio backend",
      city: "Rio de Janeiro",
      type: "vacancy_type_internship",
      isRemoteWork: true,
      pageSize: 7,
      maxResults: 7,
    });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was not called");
    const url = new URL(String(call[0]));
    expect(url.origin).toBe("https://portal.gupy.io");
    expect(url.pathname).toBe("/api/job-search/jobs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      jobName: "estágio backend",
      city: "Rio de Janeiro",
      type: "vacancy_type_internship",
      isRemoteWork: "true",
      limit: "7",
      offset: "0",
    });
  });

  it("stops paginating once a short page signals the last page", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 1, name: "Estágio X" }] }),
    );
    const collector = new GupyCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    const result = await collector.collect({ maxResults: 50, pageSize: 10 });

    expect(result.postings).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });

  it("reports truncated: true when the cap is hit on a full page (docs/audit AC-013)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: Array.from({ length: 10 }, (_, i) => ({ id: i, name: "x" })),
      }),
    );
    const collector = new GupyCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    // maxResults exactly matches one full page — the source could still
    // have more, but the collector's own cap stops it from asking.
    const result = await collector.collect({ maxResults: 10, pageSize: 10 });

    expect(result.postings).toHaveLength(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
  });

  it("skips an individual malformed item without failing the whole collection", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ id: 1, name: "Estágio válido" }, { missingIdAndName: true }],
      }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 2 });

    expect(result.error).toBeUndefined();
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("1");
  });

  it("reports receivedCount and schemaRejectedCount (docs/audit AC-012)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ id: 1, name: "Estágio válido" }, { missingIdAndName: true }],
      }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 2 });

    expect(result.receivedCount).toBe(2);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("reports zero schemaRejectedCount when every item is valid", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 1, name: "x" }] }),
    );
    const collector = new GupyCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 1 });

    expect(result.receivedCount).toBe(1);
    expect(result.schemaRejectedCount).toBe(0);
  });
});

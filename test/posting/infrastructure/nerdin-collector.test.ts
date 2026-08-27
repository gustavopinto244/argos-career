import { describe, expect, it, vi } from "vitest";
import { NerdinCollector } from "../../../src/posting/infrastructure/nerdin-collector";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch
// is injected and faked for every scenario below.
const FAST = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1, 1],
};

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function listing(ids: string[]): string {
  return ids
    .map(
      (id) =>
        `<div class="vaga-card" data-href="vaga_emprego/vaga-estagio-${id}.php"></div>`,
    )
    .join("");
}

function detailHtml(overrides: Record<string, unknown> = {}): string {
  const job = {
    "@type": "JobPosting",
    title: "Estágio em TI",
    description: "Atividades.",
    datePosted: "2026-08-24T00:00:00",
    hiringOrganization: { name: "SystemHaus" },
    jobLocation: {
      address: { addressLocality: "Curitiba", addressCountry: "BR" },
    },
    ...overrides,
  };
  return `<html><script type="application/ld+json">${JSON.stringify(job)}</script></html>`;
}

/** Routes listing vs detail the way the real site does. */
function router(
  pages: Record<string, string>,
  detail: () => Response,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("vaga_emprego/")) return detail();
    const page = /pagina=(\d+)/.exec(url)?.[1] ?? "1";
    return html(pages[page] ?? pages["1"] ?? "");
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("NerdinCollector (ADR-071)", () => {
  it("never throws when the listing request fails outright", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toBe("NerdIn listing request failed");
  });

  it("does not retry a 4xx listing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });

    expect(result.error?.message).toContain("404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid criteria as a result, not a throw", async () => {
    const result = await new NerdinCollector(FAST).collect({ maxResults: -5 });
    expect(result.postings).toEqual([]);
    expect(result.error?.message).toBe("Invalid NerdIn collector criteria");
  });

  it("fetches listing then detail and builds a posting per card", async () => {
    const { fetchImpl, urls } = router({ "1": listing(["98167"]) }, () =>
      html(detailHtml()),
    );

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });

    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("98167");
    expect(result.receivedCount).toBe(1);
    expect(result.schemaRejectedCount).toBe(0);
    expect(urls).toHaveLength(2);
  });

  it("always sends busca=1, which is what applies the filter at all", async () => {
    const { fetchImpl, urls } = router({ "1": "" }, () => html(detailHtml()));
    await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });
    expect(urls[0]).toContain("busca=1");
    expect(urls[0]).toContain("busca_vaga=estagi");
  });

  it("uses the home-office facet page for a remote query", async () => {
    const { fetchImpl, urls } = router({ "1": listing(["1"]) }, () =>
      html(detailHtml()),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      isRemoteWork: true,
    });

    expect(urls[0]).toContain("vagas-home-office.php");
    // The facet annotation the normalizer falls back on (B18 defence).
    expect(
      (result.postings[0]?.payload as { isRemoteQuery?: boolean })
        ?.isRemoteQuery,
    ).toBe(true);
  });

  it("sends busca_local when a city is given", async () => {
    const { fetchImpl, urls } = router({ "1": "" }, () => html(detailHtml()));
    await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      city: "Rio de Janeiro",
    });
    expect(urls[0]).toContain("busca_local=Rio+de+Janeiro");
  });

  it("paginates with `pagina` and accumulates across pages", async () => {
    const full = Array.from(
      { length: 20 },
      (_, i) => `1${i.toString().padStart(2, "0")}`,
    );
    const second = Array.from({ length: 5 }, (_, i) => `2${i}`);
    const { fetchImpl, urls } = router(
      { "1": listing(full), "2": listing(second) },
      () => html(detailHtml()),
    );

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      maxResults: 40,
    });

    expect(urls.some((u) => u.includes("pagina=2"))).toBe(true);
    expect(result.postings).toHaveLength(25);
    expect(result.truncated).toBe(false);
  });

  it("stops when a later page repeats the first, instead of looping (ADR-071)", async () => {
    // NerdIn returns page one when `pagina` overruns the real page count —
    // verified live on a 9-result search. Without this guard a large
    // maxResults would re-fetch and re-detail the same postings up to the
    // page cap, multiplying request volume against the source for nothing.
    const full = Array.from({ length: 20 }, (_, i) => `${i}`);
    const same = listing(full);
    const { fetchImpl, urls } = router({ "1": same, "2": same }, () =>
      html(detailHtml()),
    );

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      maxResults: 100,
    });

    expect(result.postings).toHaveLength(20);
    const listingRequests = urls.filter((u) => !u.includes("vaga_emprego/"));
    expect(listingRequests).toHaveLength(2);
    const detailRequests = urls.filter((u) => u.includes("vaga_emprego/"));
    expect(detailRequests).toHaveLength(20);
  });

  it("marks a short final page as exhausted, not truncated", async () => {
    const { fetchImpl } = router({ "1": listing(["1", "2", "3"]) }, () =>
      html(detailHtml()),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      maxResults: 50,
    });
    expect(result.truncated).toBe(false);
  });

  it("truncates at maxResults and fetches no more details than that", async () => {
    const full = Array.from({ length: 20 }, (_, i) => `${i}`);
    const { fetchImpl, urls } = router({ "1": listing(full) }, () =>
      html(detailHtml()),
    );

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      maxResults: 5,
    });

    expect(result.truncated).toBe(true);
    expect(result.postings).toHaveLength(5);
    // receivedCount counts what was fetched, not what was seen — the
    // AC-012 reconciliation identity.
    expect(result.receivedCount).toBe(5);
    expect(urls.filter((u) => u.includes("vaga_emprego/"))).toHaveLength(5);
  });

  it("loses only the broken card when one detail page fails", async () => {
    let call = 0;
    const { fetchImpl } = router({ "1": listing(["1", "2"]) }, () => {
      call += 1;
      return call === 1
        ? new Response("boom", { status: 404 })
        : html(detailHtml());
    });

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });

    expect(result.postings).toHaveLength(1);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("counts a detail page with no JobPosting rather than failing", async () => {
    const { fetchImpl } = router({ "1": listing(["1"]) }, () =>
      html(`<script type="application/ld+json">{"@type":"WebSite"}</script>`),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });
    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("finds the JobPosting when it is not the first ld+json block", async () => {
    const { fetchImpl } = router({ "1": listing(["1"]) }, () =>
      html(
        `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>` +
          detailHtml(),
      ),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });
    expect(result.postings).toHaveLength(1);
  });

  it("finds the block even with extra attributes or single quotes", async () => {
    // InfoJobs's narrower regex would match nothing here, and a source
    // returning zero looks empty rather than broken (docs/11 B13).
    const job = JSON.stringify({
      "@type": "JobPosting",
      title: "Estágio",
      hiringOrganization: { name: "X" },
    });
    const { fetchImpl } = router({ "1": listing(["1"]) }, () =>
      html(`<script id="jp" type='application/ld+json' >${job}</script>`),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });
    expect(result.postings).toHaveLength(1);
  });

  it("recovers a JSON-LD block containing raw control characters", async () => {
    // A sibling Brazilian board emits these; JSON.parse rejects them
    // outright, so the recovery path is what keeps the posting.
    // A real C0 control character inside a JSON string — JSON.parse
    // throws on this, so without the recovery path the posting is lost.
    const control = String.fromCharCode(1);
    const job =
      `{"@type":"JobPosting","title":"Est${control}agio",` +
      `"hiringOrganization":{"name":"X"}}`;
    expect(() => JSON.parse(job)).toThrow();
    const { fetchImpl } = router({ "1": listing(["1"]) }, () =>
      html(`<script type="application/ld+json">${job}</script>`),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });
    expect(result.postings).toHaveLength(1);
  });

  it("keeps earlier pages when a later listing page fails (AC-004)", async () => {
    const full = Array.from({ length: 20 }, (_, i) => `${i}`);
    let listingCall = 0;
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("vaga_emprego/")) return html(detailHtml());
      listingCall += 1;
      if (listingCall === 1) return html(listing(full));
      return new Response("err", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
      maxResults: 40,
    });

    expect(result.error).toBeDefined();
    expect(result.postings).toHaveLength(20);
  });

  it("returns empty and untruncated for a listing with no cards", async () => {
    const { fetchImpl } = router({ "1": "<html>nada</html>" }, () =>
      html(detailHtml()),
    );
    const result = await new NerdinCollector({ ...FAST, fetchImpl }).collect({
      jobName: "estagi",
    });
    expect(result.postings).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeUndefined();
  });
});

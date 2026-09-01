import { describe, expect, it, vi } from "vitest";
import { InfoJobsCollector } from "../../../src/posting/infrastructure/infojobs-collector";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

const FAST_OPTIONS = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1, 1],
};

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { "content-type": "text/html", ...init.headers },
  });
}

function listingCard(id: string, href: string): string {
  return `<div id="vacancy${id}" data-id="${id}" data-href="${href}" class="js_vacancyLoad"><h2 class="js_vacancyTitle">Estágio de TI</h2></div>`;
}

function listingHtml(cards: string): string {
  return `<html><body>${cards}</body></html>`;
}

function detailHtml(jobPosting: Record<string, unknown>): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(jobPosting)}</script></head><body></body></html>`;
}

function jobPosting(title: string, company: string): Record<string, unknown> {
  return {
    "@context": "http://schema.org",
    "@type": "JobPosting",
    title,
    description: "Descrição fictícia<br>Segunda linha.",
    datePosted: "2026-08-10T12:00:00.0000000",
    hiringOrganization: { "@type": "Organization", name: company },
    jobLocation: {
      "@type": "Place",
      address: { addressLocality: "Rio de Janeiro", addressRegion: "RJ" },
    },
  };
}

describe("InfoJobsCollector — never throws", () => {
  it("returns an error result when the listing request fails, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ jobName: "estagio ti" });

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("500");
  });

  it("returns an error result on a 4xx without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an error result when the listing request times out, never throwing", async () => {
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
    const collector = new InfoJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });
});

describe("InfoJobsCollector — listing + detail fetch", () => {
  it("fetches the listing, then each card's detail page, and normalizes both into one payload", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vaga-de-estagio-ti__111.aspx")),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      city: "Rio de Janeiro",
    });

    expect(result.error).toBeUndefined();
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("111");
    const payload = result.postings[0]?.payload as {
      title: string;
      id: string;
    };
    expect(payload.title).toBe("Estágio de TI");
    expect(payload.id).toBe("111");
    // Two requests total: one listing, one detail.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("builds the friendly-URL location suffix from criteria.city", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (url.toString().includes("vagas-de-emprego"))
        return htmlResponse(listingHtml(""));
      return htmlResponse("");
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({ jobName: "estagio ti", city: "Rio de Janeiro" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.infojobs.com.br/vagas-de-emprego-estagio+ti-rio-de-janeiro.aspx",
      expect.anything(),
    );
  });

  it("builds the remote-work suffix from criteria.isRemoteWork", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(listingHtml("")));
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({ jobName: "estagio ti", isRemoteWork: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.infojobs.com.br/vagas-de-emprego-estagio+ti-trabalho-home-office.aspx",
      expect.anything(),
    );
  });

  it("counts a detail page that fails as unnormalizable, not a whole-collection failure", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(
            listingCard("111", "/vaga-de-a__111.aspx") +
              listingCard("222", "/vaga-de-b__222.aspx"),
          ),
        );
      }
      if (href.includes("111")) {
        return new Response("Server Error", { status: 500 });
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de Dados", "Empresa Fictícia B")),
      );
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ jobName: "estagio ti" });

    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("222");
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("counts a detail page with no application/ld+json block as unnormalizable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vaga-de-a__111.aspx")),
        );
      }
      return htmlResponse("<html><body>no json-ld here</body></html>");
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ jobName: "estagio ti" });

    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("marks truncated when the listing returns more cards than maxResults", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(
            listingCard("111", "/vaga-de-a__111.aspx") +
              listingCard("222", "/vaga-de-b__222.aspx"),
          ),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      maxResults: 1,
    });

    expect(result.postings).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // Only the first card's detail page should have been fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("tags postings from the remote facet with isRemoteQuery, and others not", async () => {
    // The collector is the only layer that knows which listing facet was
    // queried; the detail page's JSON-LD states no remote signal at all.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vaga-de-a__111.aspx")),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });

    const remote = await new InfoJobsCollector({
      fetchImpl,
      ...FAST_OPTIONS,
    }).collect({ jobName: "estagio ti", isRemoteWork: true });
    expect(
      (remote.postings[0]?.payload as { isRemoteQuery: boolean }).isRemoteQuery,
    ).toBe(true);

    const byCity = await new InfoJobsCollector({
      fetchImpl,
      ...FAST_OPTIONS,
    }).collect({ jobName: "estagio ti", city: "Rio de Janeiro" });
    expect(
      (byCity.postings[0]?.payload as { isRemoteQuery: boolean }).isRemoteQuery,
    ).toBe(false);
  });

  it("picks the JobPosting block, not merely the first application/ld+json script", async () => {
    // Job sites commonly render BreadcrumbList/Organization blocks before
    // the posting one. Taking the first block worked against every page
    // sampled during discovery and would break silently the day that
    // changed -- every posting rejected, source looking empty rather than
    // broken (the docs/11 B13 failure shape).
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vaga-de-a__111.aspx")),
        );
      }
      const breadcrumb = `<script type="application/ld+json">${JSON.stringify({
        "@context": "http://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [],
      })}</script>`;
      const posting = `<script type="application/ld+json">${JSON.stringify(
        jobPosting("Estágio de TI", "Empresa Fictícia"),
      )}</script>`;
      return htmlResponse(`<html><head>${breadcrumb}${posting}</head></html>`);
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ jobName: "estagio ti" });

    expect(result.postings).toHaveLength(1);
    expect((result.postings[0]?.payload as { title: string }).title).toBe(
      "Estágio de TI",
    );
  });

  it("counts a detail page whose only ld+json block is not a JobPosting as unnormalizable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-emprego")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vaga-de-a__111.aspx")),
        );
      }
      return htmlResponse(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          "@type": "BreadcrumbList",
        })}</script></head></html>`,
      );
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ jobName: "estagio ti" });

    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("returns an empty, non-truncated result when the listing has no cards", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(listingHtml("")));
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ jobName: "estagio ti" });

    expect(result.postings).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeUndefined();
  });
});

/**
 * The `Antiguedad` age facet (ADR-079). The behaviour under test is not
 * "the URL gains a query parameter" but the reason it does: without a
 * window, every card on the listing costs a detail-page fetch before
 * anything can judge its age, which measured at 2,027 detail fetches over
 * eight production days for nine postings.
 */
describe("InfoJobsCollector — Antiguedad age buckets", () => {
  /** Records every listing URL requested, and answers each one with `cards`
   * keyed by the bucket it asked for. */
  function listingSpy(cardsByBucket: Record<string, string>) {
    const listingUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (!href.includes("vagas-de-emprego")) {
        return htmlResponse(
          detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
        );
      }
      listingUrls.push(href);
      const bucket = /Antiguedad=(\d)/.exec(href)?.[1] ?? "none";
      return htmlResponse(listingHtml(cardsByBucket[bucket] ?? ""));
    });
    return { fetchImpl, listingUrls };
  }

  it("requests no Antiguedad facet when the query states no window", async () => {
    const { fetchImpl, listingUrls } = listingSpy({ none: "" });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({ jobName: "estagio ti", city: "Rio de Janeiro" });

    expect(listingUrls).toEqual([
      "https://www.infojobs.com.br/vagas-de-emprego-estagio+ti-rio-de-janeiro.aspx",
    ]);
  });

  it("requests only bucket 1 for a one-day window", async () => {
    const { fetchImpl, listingUrls } = listingSpy({ "1": "" });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      city: "Rio de Janeiro",
      maxAgeDays: 1,
    });

    expect(listingUrls).toEqual([
      "https://www.infojobs.com.br/vagas-de-emprego-estagio+ti-rio-de-janeiro.aspx?Antiguedad=1",
    ]);
    // The whole point: an empty "Hoje" bucket costs one request and zero
    // detail fetches, where the unfiltered listing cost one plus one per card.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.postings).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  /**
   * The disjointness measurement in `ANTIGUEDAD_BUCKET_MAX_AGE_DAYS`'s own
   * doc comment, pinned: a seven-day window must fetch buckets 1, 2 AND 3,
   * because bucket 3 alone holds only postings older than three days.
   * Reading the labels as cumulative and requesting bucket 3 alone would
   * silently lose everything published this week.
   */
  it("requests buckets 1..3 for a seven-day window and unions their cards", async () => {
    const { fetchImpl, listingUrls } = listingSpy({
      "1": listingCard("111", "/vaga-de-estagio-ti__111.aspx"),
      "2": listingCard("222", "/vaga-de-estagio-ti__222.aspx"),
      "3": listingCard("333", "/vaga-de-estagio-ti__333.aspx"),
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      maxAgeDays: 7,
    });

    expect(listingUrls.map((u) => /Antiguedad=(\d)/.exec(u)?.[1])).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(result.postings.map((p) => p.sourceId).sort()).toEqual([
      "111",
      "222",
      "333",
    ]);
    expect(result.receivedCount).toBe(3);
  });

  it("falls back to one unfiltered listing when no bucket covers the window", async () => {
    const { fetchImpl, listingUrls } = listingSpy({ none: "" });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    // 60 days is past the oldest bucket ("Último mês"), so filtering would
    // silently cap the window rather than widen it.
    await collector.collect({ jobName: "estagio ti", maxAgeDays: 60 });

    expect(listingUrls).toEqual([
      "https://www.infojobs.com.br/vagas-de-emprego-estagio+ti.aspx",
    ]);
  });

  it("counts a card appearing in two buckets once, not twice", async () => {
    const duplicated = listingCard("111", "/vaga-de-estagio-ti__111.aspx");
    const { fetchImpl } = listingSpy({ "1": duplicated, "2": duplicated });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      maxAgeDays: 3,
    });

    expect(result.postings).toHaveLength(1);
    expect(result.receivedCount).toBe(1);
  });

  it("keeps the cards from healthy buckets when one bucket fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (!href.includes("vagas-de-emprego")) {
        return htmlResponse(
          detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
        );
      }
      if (href.includes("Antiguedad=2")) {
        return new Response("Server Error", { status: 500 });
      }
      return htmlResponse(
        listingHtml(listingCard("111", "/vaga-de-estagio-ti__111.aspx")),
      );
    });
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      maxAgeDays: 3,
    });

    // Bucket 1's posting survives; the run still reports the failure so the
    // recency window widens on the next pass (AC-004's reasoning).
    expect(result.postings.map((p) => p.sourceId)).toEqual(["111"]);
    expect(result.error?.message).toContain("500");
  });

  it("returns an empty error result when every bucket fails", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const collector = new InfoJobsCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({
      jobName: "estagio ti",
      maxAgeDays: 3,
    });

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("500");
  });
});

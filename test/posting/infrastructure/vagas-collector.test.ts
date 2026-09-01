import { describe, expect, it, vi } from "vitest";
import {
  VagasCollector,
  parsePublishedLabel,
} from "../../../src/posting/infrastructure/vagas-collector";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

const FAST_OPTIONS = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1, 1],
};

const NOW = new Date("2026-09-01T12:00:00Z");

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { "content-type": "text/html", ...init.headers },
  });
}

function listingCard(
  id: string,
  href: string,
  publishedLabel = "Hoje",
): string {
  return `
<li class="vaga even ">
  <a class="link-detalhes-vaga" data-id-vaga="${id}" title="Estágio de TI" id="v${id}" href="${href}">Estágio de TI</a>
  <footer>
    <span class="data-publicacao"><i class="bx bx-time-five"></i>${publishedLabel}</span>
  </footer>
</li>`;
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
    description: "Descrição fictícia.",
    datePosted: "2026-08-25",
    hiringOrganization: { "@type": "Organization", name: company },
    jobLocation: {
      "@type": "Place",
      address: { addressLocality: "Rio de Janeiro", addressRegion: "RJ" },
    },
  };
}

describe("VagasCollector — never throws", () => {
  it("returns an error result when the listing request fails, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("500");
  });

  it("returns an error result on a 4xx without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    await collector.collect({});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("VagasCollector — listing URL", () => {
  it("always applies the area (Informática/T.I.) and level (Estágio) facets", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(listingHtml("")));
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    await collector.collect({});

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.vagas.com.br/vagas-de-estagio?a%5B%5D=24&h%5B%5D=28&ordenar_por=mais_recentes",
      expect.anything(),
    );
  });

  it("builds the city suffix from criteria.city", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(listingHtml("")));
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    await collector.collect({ city: "Rio de Janeiro" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.vagas.com.br/vagas-de-estagio-rio-de-janeiro?a%5B%5D=24&h%5B%5D=28&ordenar_por=mais_recentes",
      expect.anything(),
    );
  });

  it("adds the 100% Home Office facet from criteria.isRemoteWork", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(listingHtml("")));
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    await collector.collect({ isRemoteWork: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.vagas.com.br/vagas-de-estagio?a%5B%5D=24&h%5B%5D=28&m%5B%5D=100%25+Home+Office&ordenar_por=mais_recentes",
      expect.anything(),
    );
  });
});

describe("VagasCollector — fetching and normalizing", () => {
  it("fetches the listing, then each card's detail page, and normalizes both into one payload", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vagas/v111/estagio-ti")),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({ city: "Rio de Janeiro" });

    expect(result.error).toBeUndefined();
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("111");
    const payload = result.postings[0]?.payload as {
      title: string;
      id: string;
    };
    expect(payload.title).toBe("Estágio de TI");
    expect(payload.id).toBe("111");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("counts a detail page that fails as unnormalizable, not a whole-collection failure", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vagas/v111/estagio-ti")),
        );
      }
      return new Response("Server Error", { status: 500 });
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({});

    expect(result.error).toBeUndefined();
    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("counts a detail page with no application/ld+json block as unnormalizable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vagas/v111/estagio-ti")),
        );
      }
      return htmlResponse("<html><body>No structured data</body></html>");
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("picks the JobPosting block, not merely the first application/ld+json script", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(listingCard("111", "/vagas/v111/estagio-ti")),
        );
      }
      const other = JSON.stringify({
        "@context": "http://schema.org",
        "@type": "BreadcrumbList",
      });
      const job = JSON.stringify(
        jobPosting("Estágio de TI", "Empresa Fictícia"),
      );
      return htmlResponse(
        `<html><head><script type="application/ld+json">${other}</script><script type="application/ld+json">${job}</script></head></html>`,
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({});

    expect(result.postings).toHaveLength(1);
  });

  it("returns an empty, non-truncated result when the listing has no cards", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(listingHtml("")));
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeUndefined();
  });
});

describe("VagasCollector — pagination", () => {
  it("fetches a second page when the first is exactly full-size, and stops on a short page", async () => {
    const fullPage = Array.from({ length: 40 }, (_, i) =>
      listingCard(String(i), `/vagas/v${i}/estagio-ti`),
    ).join("");
    const shortPage = listingCard("999", "/vagas/v999/estagio-ti");

    let listingCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        listingCalls += 1;
        return htmlResponse(
          listingHtml(listingCalls === 1 ? fullPage : shortPage),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({ maxResults: 100 });

    expect(listingCalls).toBe(2);
    expect(result.receivedCount).toBe(41);
    expect(fetchImpl.mock.calls[1]![0]!.toString()).toContain("pagina=2");
  });

  it("marks truncated when maxResults caps a page that was still full", async () => {
    const fullPage = Array.from({ length: 40 }, (_, i) =>
      listingCard(String(i), `/vagas/v${i}/estagio-ti`),
    ).join("");
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(listingHtml(fullPage));
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({ maxResults: 40 });

    expect(result.truncated).toBe(true);
    expect(result.receivedCount).toBe(40);
  });
});

describe("VagasCollector — maxAgeDays business filter", () => {
  it("skips the detail fetch for a card older than the window, counting it as businessRejected", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(
            listingCard("111", "/vagas/v111/estagio-ti", "Hoje") +
              listingCard("222", "/vagas/v222/estagio-ti", "12/08/2026"),
          ),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({ maxAgeDays: 7 });

    // One listing request + one detail request (only for "111" — "222" is
    // three weeks before NOW, well past a 7-day window).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("111");
    expect(result.receivedCount).toBe(2);
    expect(result.businessRejectedCount).toBe(1);
  });

  it("keeps a card with an unparseable date badge — absence of a date is not evidence of an old posting", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(
            listingCard("111", "/vagas/v111/estagio-ti", "algo estranho"),
          ),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({ maxAgeDays: 7 });

    expect(result.postings).toHaveLength(1);
    expect(result.businessRejectedCount).toBe(0);
  });

  it("fetches every card's detail page when maxAgeDays is not set, regardless of age", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = url.toString();
      if (href.includes("vagas-de-estagio") && !href.includes("/vagas/v")) {
        return htmlResponse(
          listingHtml(
            listingCard("111", "/vagas/v111/estagio-ti", "12/08/2026"),
          ),
        );
      }
      return htmlResponse(
        detailHtml(jobPosting("Estágio de TI", "Empresa Fictícia")),
      );
    });
    const collector = new VagasCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      now: () => NOW,
    });

    const result = await collector.collect({});

    expect(result.postings).toHaveLength(1);
    expect(result.businessRejectedCount).toBe(0);
  });
});

describe("parsePublishedLabel", () => {
  it('resolves "Hoje" to now', () => {
    expect(parsePublishedLabel("Hoje", NOW)).toEqual(NOW);
  });

  it('resolves "Ontem" to one day before now', () => {
    expect(parsePublishedLabel("Ontem", NOW)).toEqual(
      new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    );
  });

  it('resolves "Há N dias" to N days before now', () => {
    expect(parsePublishedLabel("Há 5 dias", NOW)).toEqual(
      new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
    );
  });

  it("resolves an absolute DD/MM/YYYY date", () => {
    expect(parsePublishedLabel("12/08/2026", NOW)).toEqual(
      new Date(2026, 7, 12),
    );
  });

  it("is null for an unrecognized label", () => {
    expect(parsePublishedLabel("semana passada", NOW)).toBeNull();
  });

  it("is null for a null label", () => {
    expect(parsePublishedLabel(null, NOW)).toBeNull();
  });
});

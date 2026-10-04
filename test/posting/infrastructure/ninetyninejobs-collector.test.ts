import { describe, expect, it, vi } from "vitest";
import { NinetyNineJobsCollector } from "../../../src/posting/infrastructure/ninetyninejobs-collector";
import {
  collectableSources,
  collectorFor,
} from "../../../src/posting/infrastructure/collector-registry";

const FAST_OPTIONS = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1],
};

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function card(
  id: string,
  href = `https://99jobs.com/acme/jobs/${id}-estagio-backend`,
  mode = "Remota",
): string {
  return `<input type="hidden" name="count_opportunities" value="1">
<a class="opportunity-card" href="${href}">
 <h1>Estágio em Desenvolvimento</h1>
 <span class="opportunity-label opportunity-label-acting-mode">${mode}</span>
 <div class="opportunity-address"><p>Rio de Janeiro, RJ</p></div>
 <div class="opportunity-company-infos"><h2>Empresa Fictícia</h2></div>
</a>`;
}

function jsonLd(id: string): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Estágio em Desenvolvimento Backend",
    description: "&lt;p&gt;Desenvolva APIs.&lt;/p&gt;",
    datePosted: "2026-10-01",
    hiringOrganization: { name: "Empresa Fictícia" },
    jobLocation: {
      address: { addressLocality: "Rio de Janeiro", addressCountry: "BR" },
    },
    identifier: { value: `company-${id}` },
  })}</script>`;
}

describe("NinetyNineJobsCollector", () => {
  it("is registered as a collectable source", () => {
    expect(collectorFor("99jobs")).toBeInstanceOf(NinetyNineJobsCollector);
    expect(collectableSources()).toContain("99jobs");
  });

  it("builds the exact internship, Rio and remote filters", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(input.toString());
      return response("");
    });
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });

    await collector.collect({
      jobName: "estágio",
      city: "Rio de Janeiro",
      isRemoteWork: true,
    });

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe(
      "/opportunities/filtered_search/search_opportunities",
    );
    expect(url.searchParams.get("search[term]")).toBe("estágio");
    expect(url.searchParams.getAll("search[opportunity_level_ids][]")).toEqual([
      "3",
    ]);
    expect(url.searchParams.get("search[state]")).toBe("20");
    expect(url.searchParams.getAll("search[city][]")).toEqual([
      "Rio de Janeiro",
    ]);
    expect(url.searchParams.getAll("search[acting_mode][]")).toEqual([
      "remote",
    ]);
  });

  it("collects a server-rendered JSON-LD detail using the URL id", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      input.toString().includes("filtered_search")
        ? response(card("900001"))
        : response(jsonLd("900001")),
    );
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({ isRemoteWork: true });

    expect(result.error).toBeUndefined();
    expect(result.receivedCount).toBe(1);
    expect(result.schemaRejectedCount).toBe(0);
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("900001");
    expect(result.postings[0]?.payload).toEqual(
      expect.objectContaining({
        id: "900001",
        title: "Estágio em Desenvolvimento Backend",
        workMode: "remote",
      }),
    );
  });

  it("uses the public browser token for SPA details and preserves the card mode", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("filtered_search")) {
          return response(
            card(
              "900002",
              "https://acme.99jobs.com/vagas/900002-estagio-seguranca?utm_id=1",
            ),
          );
        }
        if (url.includes("acme.99jobs.com"))
          return response("<div id=app></div>");
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Authorization: "Bearer public-client-token",
          }),
        );
        return response(
          JSON.stringify({
            opportunity: [
              {
                id: 900002,
                title: "Estágio em Segurança da Informação",
                company_name: "Empresa Fictícia",
                responsability: "Apoiar o SOC.",
                requirement: "Conhecimento de redes.",
                created_at: "2026-10-02T10:00:00Z",
                acting_mode: "remote",
              },
            ],
          }),
        );
      },
    );
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      publicApiToken: "public-client-token",
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({ isRemoteWork: true });

    expect(result.error).toBeUndefined();
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.payload).toEqual(
      expect.objectContaining({
        title: "Estágio em Segurança da Informação",
        description: "Apoiar o SOC.\n\nConhecimento de redes.",
        jobUrl: "https://acme.99jobs.com/vagas/900002-estagio-seguranca",
        workMode: "remote",
      }),
    );
  });

  it("makes a missing SPA token visible as a partial source error", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      input.toString().includes("filtered_search")
        ? response(
            card(
              "900002",
              "https://acme.99jobs.com/vagas/900002-estagio-seguranca",
            ),
          )
        : response("<div id=app></div>"),
    );
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      publicApiToken: "",
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
    expect(result.error?.message).toContain("NINETYNINEJOBS_PUBLIC_API_TOKEN");
  });

  it("treats an orphaned search card with no API detail as one rejected item", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("filtered_search")) {
        return response(
          card("900004", "https://acme.99jobs.com/vagas/900004-vaga-antiga"),
        );
      }
      if (url.includes("acme.99jobs.com"))
        return response("<div id=app></div>");
      return response(JSON.stringify({ opportunity: [] }));
    });
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      publicApiToken: "public-client-token",
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({});

    expect(result.error).toBeUndefined();
    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
  });

  it("rejects unsupported cities as criteria errors without a request", async () => {
    const fetchImpl = vi.fn();
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });
    const result = await collector.collect({ city: "São Paulo" });
    expect(result.error?.message).toContain("Invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns listing failures as values and never throws", async () => {
    const fetchImpl = vi.fn(async () => response("Server Error", 500));
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffDelaysMs: [],
      timeoutMs: 50,
      requestIntervalMs: 0,
    });
    const result = await collector.collect({});
    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("listing request failed");
  });

  it("refuses detail links outside 99jobs without fetching them", async () => {
    const fetchImpl = vi.fn(async () =>
      response(card("900003", "https://evil.test/jobs/900003-estagio")),
    );
    const collector = new NinetyNineJobsCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });
    const result = await collector.collect({});
    expect(result.postings).toEqual([]);
    expect(result.schemaRejectedCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

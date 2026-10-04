import { z } from "zod";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { FetchedBody, fetchWithDeadline } from "./fetch-with-deadline";
import {
  NinetyNineJobsListingCard,
  parseNinetyNineJobsListing,
  parseNinetyNineJobsTotal,
} from "./ninetyninejobs-listing-parser";
import { NinetyNineJobsJobSchema } from "./ninetyninejobs-schema";

const SOURCE = "99jobs";
const SEARCH_URL =
  "https://www.99jobs.com/opportunities/filtered_search/search_opportunities";
const API_BASE_URL = "https://api-oportunidades.99jobs.com/v1/opportunities";
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/argos-career; personal internship search bot)";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];
const PAGE_SIZE = 20;
const MAX_PAGES = 10;
const INTERNSHIP_LEVEL_ID = "3";
const RIO_STATE_ID = "20";

const RJ_METRO_CITIES = new Set([
  "Rio de Janeiro",
  "Niterói",
  "São Gonçalo",
  "Duque de Caxias",
  "Nova Iguaçu",
  "Belford Roxo",
  "São João de Meriti",
  "Itaboraí",
  "Maricá",
  "Mesquita",
]);

const CriteriaSchema = z
  .object({
    jobName: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    isRemoteWork: z.boolean().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .superRefine((value, context) => {
    if (value.city && !RJ_METRO_CITIES.has(value.city)) {
      context.addIssue({
        code: "custom",
        path: ["city"],
        message: "99jobs currently supports only configured Rio metro cities",
      });
    }
  });

type Criteria = z.infer<typeof CriteriaSchema>;
type FetchLike = typeof fetch;

export interface NinetyNineJobsCollectorOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  requestIntervalMs?: number;
  backoffDelaysMs?: number[];
  /** Public browser-client token used only to read company SPA detail pages.
   * Never a personal account token. */
  publicApiToken?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function nestedString(
  record: JsonRecord | null,
  ...path: string[]
): string | null {
  let current: unknown = record;
  for (const key of path) {
    const object = asRecord(current);
    if (!object) return null;
    current = object[key];
  }
  return asString(current);
}

function buildListingUrl(criteria: Criteria, page: number): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("search[term]", criteria.jobName ?? "estágio");
  url.searchParams.append(
    "search[opportunity_level_ids][]",
    INTERNSHIP_LEVEL_ID,
  );
  if (criteria.city) {
    url.searchParams.set("search[state]", RIO_STATE_ID);
    url.searchParams.append("search[city][]", criteria.city);
  }
  if (criteria.isRemoteWork) {
    url.searchParams.append("search[acting_mode][]", "remote");
  }
  return url.toString();
}

function canonicalDetailUrl(raw: string): string | null {
  try {
    const url = new URL(raw, "https://www.99jobs.com/");
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (host !== "99jobs.com" && !host.endsWith(".99jobs.com"))
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractJobPostingJsonLd(html: string): JsonRecord | null {
  const blocks = html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    try {
      const value = JSON.parse(block[1]!) as unknown;
      const record = asRecord(value);
      if (record?.["@type"] === "JobPosting") return record;
    } catch {
      // One malformed structured-data block does not hide a later valid one.
    }
  }
  return null;
}

function descriptionFromApi(opportunity: JsonRecord): string | null {
  const parts = [
    asString(opportunity.responsability),
    asString(opportunity.responsibility),
    asString(opportunity.requirement),
    asString(opportunity.description),
  ].filter((value): value is string => value !== null);
  const descriptions = opportunity.descriptions;
  if (Array.isArray(descriptions)) {
    for (const entry of descriptions) {
      const data = nestedString(asRecord(entry), "data");
      if (data) parts.push(data);
    }
  }
  return parts.length > 0 ? [...new Set(parts)].join("\n\n") : null;
}

function mapApiWorkMode(
  opportunity: JsonRecord,
  fallback: NinetyNineJobsListingCard["workMode"],
): NinetyNineJobsListingCard["workMode"] {
  const mode =
    asString(opportunity.acting_mode) ?? asString(opportunity.actingMode);
  if (!mode) return fallback;
  const normalized = mode.toLowerCase();
  if (normalized.includes("remote") || normalized.includes("remot"))
    return "remote";
  if (normalized.includes("hybrid") || normalized.includes("hibr"))
    return "hybrid";
  if (normalized.includes("presential") || normalized.includes("presencial"))
    return "onsite";
  return fallback;
}

function jobFromJsonLd(
  card: NinetyNineJobsListingCard,
  detailUrl: string,
  job: JsonRecord,
): unknown {
  return {
    id: card.id,
    title: asString(job.title) ?? card.title,
    company:
      nestedString(asRecord(job.hiringOrganization), "name") ?? card.company,
    description: asString(job.description),
    datePosted: asString(job.datePosted),
    validThrough: asString(job.validThrough),
    jobUrl: detailUrl,
    city:
      nestedString(asRecord(job.jobLocation), "address", "addressLocality") ??
      card.city,
    country: asRecord(job.jobLocation)?.address
      ? asRecord(asRecord(job.jobLocation)?.address)?.addressCountry
      : null,
    workMode: card.workMode,
    upstream: job,
  };
}

function jobFromApi(
  card: NinetyNineJobsListingCard,
  detailUrl: string,
  opportunity: JsonRecord,
): unknown {
  const company = asRecord(opportunity.company);
  const address = asRecord(opportunity.address);
  return {
    id: card.id,
    title: asString(opportunity.title) ?? card.title,
    company:
      asString(opportunity.company_name) ??
      asString(opportunity.companyName) ??
      asString(company?.name) ??
      card.company,
    description: descriptionFromApi(opportunity),
    datePosted:
      asString(opportunity.date_posted) ??
      asString(opportunity.datePosted) ??
      asString(opportunity.created_at) ??
      asString(opportunity.createdAt),
    validThrough:
      asString(opportunity.expired_at) ?? asString(opportunity.expiredAt),
    jobUrl: detailUrl,
    city: asString(address?.city) ?? card.city,
    country: address?.country ?? null,
    workMode: mapApiWorkMode(opportunity, card.workMode),
    upstream: opportunity,
  };
}

export class NinetyNineJobsCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: readonly number[];
  private readonly publicApiToken: string | undefined;
  private lastRequestAt = 0;

  constructor(options: NinetyNineJobsCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
    this.publicApiToken =
      options.publicApiToken ?? process.env.NINETYNINEJOBS_PUBLIC_API_TOKEN;
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();
    const criteriaResult = CriteriaSchema.safeParse(rawCriteria ?? {});
    if (!criteriaResult.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid 99jobs collection criteria",
          cause: criteriaResult.error,
        },
      };
    }

    const criteria = criteriaResult.data;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;
    const cards: NinetyNineJobsListingCard[] = [];
    const seen = new Set<string>();
    let total: number | null = null;
    let exhausted = false;
    let listingError: CollectionResult["error"];

    for (let page = 1; page <= MAX_PAGES && cards.length < maxResults; page++) {
      try {
        const response = await this.fetchPage(buildListingUrl(criteria, page));
        if (!response.ok) {
          listingError = {
            message: `99jobs listing responded ${response.status} ${response.statusText}`,
          };
          break;
        }
        total ??= parseNinetyNineJobsTotal(response.body);
        const parsed = parseNinetyNineJobsListing(response.body);
        const fresh = parsed.filter((card) => !seen.has(card.id));
        if (fresh.length === 0) {
          exhausted = true;
          break;
        }
        for (const card of fresh) seen.add(card.id);
        cards.push(...fresh);
        if (
          parsed.length < PAGE_SIZE ||
          (total !== null && seen.size >= total)
        ) {
          exhausted = true;
          break;
        }
      } catch (cause) {
        listingError = {
          message: "99jobs listing request failed",
          cause,
        };
        break;
      }
    }

    if (listingError && cards.length === 0) {
      return { source: SOURCE, postings: [], collectedAt, error: listingError };
    }

    const cardsToFetch = cards.slice(0, maxResults);
    const truncated =
      (total !== null && total > cardsToFetch.length) ||
      (!exhausted && cards.length >= maxResults);
    let schemaRejectedCount = 0;
    let detailError: CollectionResult["error"];
    const postings: RawPosting[] = [];

    for (const card of cardsToFetch) {
      const detailUrl = canonicalDetailUrl(card.href);
      if (!detailUrl) {
        schemaRejectedCount += 1;
        continue;
      }
      try {
        const detail = await this.fetchPage(detailUrl);
        if (!detail.ok) {
          schemaRejectedCount += 1;
          continue;
        }
        const jsonLd = extractJobPostingJsonLd(detail.body);
        let candidate: unknown;
        if (jsonLd) {
          candidate = jobFromJsonLd(card, detailUrl, jsonLd);
        } else {
          if (!this.publicApiToken) {
            schemaRejectedCount += 1;
            detailError ??= {
              message:
                "99jobs SPA detail requires NINETYNINEJOBS_PUBLIC_API_TOKEN",
            };
            continue;
          }
          const opportunity = await this.fetchApiOpportunity(card.id);
          if (!opportunity) {
            schemaRejectedCount += 1;
            continue;
          }
          candidate = jobFromApi(card, detailUrl, opportunity);
        }

        const parsed = NinetyNineJobsJobSchema.safeParse(candidate);
        if (!parsed.success) {
          schemaRejectedCount += 1;
          continue;
        }
        postings.push({
          source: SOURCE,
          sourceId: parsed.data.id,
          payload: parsed.data,
        });
      } catch (cause) {
        schemaRejectedCount += 1;
        detailError ??= {
          message: `99jobs detail request failed for ${card.id}`,
          cause,
        };
      }
    }

    return {
      source: SOURCE,
      postings,
      collectedAt,
      receivedCount: cardsToFetch.length,
      schemaRejectedCount,
      truncated,
      ...(listingError ? { error: listingError } : {}),
      ...(!listingError && detailError ? { error: detailError } : {}),
    };
  }

  private async fetchApiOpportunity(id: string): Promise<JsonRecord | null> {
    const response = await this.fetchPage(`${API_BASE_URL}/${id}`, {
      Authorization: `Bearer ${this.publicApiToken!}`,
    });
    if (!response.ok) {
      throw new Error(`99jobs opportunity API responded ${response.status}`);
    }
    const body = asRecord(JSON.parse(response.body) as unknown);
    const value = body?.opportunity;
    if (Array.isArray(value)) return asRecord(value[0]);
    return asRecord(value);
  }

  private async fetchPage(
    url: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<FetchedBody> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < this.requestIntervalMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.requestIntervalMs - elapsed),
      );
    }
    this.lastRequestAt = Date.now();
    return fetchWithDeadline(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      backoffDelaysMs: this.backoffDelaysMs,
      userAgent: USER_AGENT,
      source: "99jobs",
      ...(headers ? { headers } : {}),
    });
  }
}

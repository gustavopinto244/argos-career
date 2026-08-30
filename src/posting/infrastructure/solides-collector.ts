import { z } from "zod";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { FetchedBody, fetchWithDeadline } from "./fetch-with-deadline";
import {
  SolidesJobSchema,
  SolidesResponseEnvelopeSchema,
} from "./solides-schema";

const SOURCE = "solides";
const ENDPOINT = "https://apigw.solides.com.br/jobs/v3/portal-vacancies-new";

/**
 * Identifies what this is, honestly — never forged to imitate a browser
 * (CLAUDE.md §6, docs/02-architecture.md collector etiquette).
 */
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

/**
 * Not configurable. Verified against the live API before this collector was
 * written: `take` values other than 10 silently return `{ count: 0 }` rather
 * than an error or a clamp, so pagination is fixed at the one page size that
 * actually works.
 */
const PAGE_SIZE = 10;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];

const SolidesCollectorCriteriaSchema = z.object({
  jobName: z.string().optional(),
  city: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
});

export type SolidesCollectorCriteria = z.infer<
  typeof SolidesCollectorCriteriaSchema
>;

type FetchLike = typeof fetch;

export interface SolidesCollectorOptions {
  /** Injected for tests — no test ever makes a real network call
   * (docs/07-testing-strategy.md). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  requestIntervalMs?: number;
  backoffDelaysMs?: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `criteria.city` is a bare city name ("Rio de Janeiro"), matching how every
 * other source's query is written in `config/criteria.yaml`. Sólides's own
 * `locations` parameter wants `"Cidade - UF"` — this collector owns that
 * translation so criteria.yaml stays source-agnostic. Only the Rio de
 * Janeiro metro (this project's search profile, CLAUDE.md §1) is mapped;
 * an unmapped city is sent to Sólides unsuffixed, which returns zero results
 * rather than failing — a config typo degrades to an empty page, not a crash.
 */
const RJ_METRO_STATE_SUFFIX: ReadonlyMap<string, string> = new Map([
  ["Rio de Janeiro", "Rio de Janeiro - RJ"],
  ["Niterói", "Niterói - RJ"],
  ["São Gonçalo", "São Gonçalo - RJ"],
]);

function buildUrl(criteria: SolidesCollectorCriteria, page: number): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set("title", criteria.jobName ?? "");
  if (criteria.city) {
    const location = RJ_METRO_STATE_SUFFIX.get(criteria.city) ?? criteria.city;
    url.searchParams.set("locations", location);
  }
  url.searchParams.set("take", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  return url.toString();
}

/**
 * `SolidesCollector` never throws — every failure path returns a
 * `CollectionResult` with `error` set, matching `CollectorPort`'s contract
 * (docs/05-domain-model.md, principle 1). `postings` carries whatever pages
 * already succeeded before the failing one, not `[]` unconditionally
 * (docs/audit AC-004). A single malformed item within an otherwise-successful
 * page is a different, milder case: it is skipped, not treated as a
 * collection failure at all, same as `GupyCollector`.
 */
export class SolidesCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: number[];

  constructor(options: SolidesCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();

    const criteriaResult = SolidesCollectorCriteriaSchema.safeParse(
      rawCriteria ?? {},
    );
    if (!criteriaResult.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid Sólides collection criteria",
          cause: criteriaResult.error,
        },
      };
    }
    const criteria = criteriaResult.data;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;

    const postings: RawPosting[] = [];
    let page = 1;
    let receivedCount = 0;
    let schemaRejectedCount = 0;
    let truncated = false;

    try {
      // Bounds the number of raw items scanned, not the number of valid
      // postings collected — same reasoning as GupyCollector. The old
      // `postings.length < maxResults` condition bounded kept postings
      // instead, contradicting this comment (docs/audit PR-015): with
      // `take` fixed at 10, `maxResults: 15` fetched two full pages
      // because the second page's own pre-check compared page count against
      // `maxResults`, not the running scanned total, and returned 20.
      while (receivedCount < maxResults) {
        if (page > 1) await sleep(this.requestIntervalMs);

        const url = buildUrl(criteria, page);
        const response = await this.fetchPage(url);

        if (!response.ok) {
          return {
            source: SOURCE,
            postings,
            collectedAt,
            receivedCount,
            schemaRejectedCount,
            error: {
              message: `Sólides responded ${response.status} ${response.statusText}`,
            },
          };
        }

        let body: unknown;
        try {
          body = JSON.parse(response.body) as unknown;
        } catch (cause) {
          return {
            source: SOURCE,
            postings,
            collectedAt,
            receivedCount,
            schemaRejectedCount,
            error: { message: "Malformed Sólides response body", cause },
          };
        }

        const envelope = SolidesResponseEnvelopeSchema.safeParse(body);
        if (!envelope.success) {
          return {
            source: SOURCE,
            postings,
            collectedAt,
            receivedCount,
            schemaRejectedCount,
            error: {
              message: "Unexpected Sólides response shape",
              cause: envelope.error,
            },
          };
        }

        const items = envelope.data.data.data;
        if (items.length === 0) break;

        // `take` is fixed at 10 (verified live — see the constant's own
        // comment) and cannot be requested smaller for a partial final
        // page, so the exact bound (docs/audit PR-015) is enforced
        // client-side instead: only the items still needed to reach
        // `maxResults` are scanned/kept from this page, even though the
        // full page was already downloaded.
        const remaining = maxResults - receivedCount;
        if (items.length > remaining) truncated = true;
        const itemsToProcess =
          items.length > remaining ? items.slice(0, remaining) : items;

        for (const item of itemsToProcess) {
          const parsed = SolidesJobSchema.safeParse(item);
          if (parsed.success) {
            postings.push({
              source: SOURCE,
              sourceId: String(parsed.data.id),
              payload: parsed.data,
            });
          } else {
            schemaRejectedCount += 1;
          }
        }
        receivedCount += itemsToProcess.length;

        if (items.length < PAGE_SIZE) break;
        // A full page, but the loop's own bound will stop the next
        // iteration — the source's page was not short, so more results were
        // plausibly there and never asked for (docs/audit AC-013).
        if (receivedCount >= maxResults) truncated = true;
        page += 1;
      }
    } catch (cause) {
      // Reached once fetchPage exhausts every attempt (a persistent
      // 5xx or network failure) — the underlying message is folded in so a
      // final "responded 500" or "fetch failed" isn't reduced to a generic
      // "request failed" with the detail buried only in `cause`.
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        source: SOURCE,
        postings,
        collectedAt,
        receivedCount,
        schemaRejectedCount,
        error: { message: `Sólides request failed: ${detail}`, cause },
      };
    }

    return {
      source: SOURCE,
      postings,
      collectedAt,
      receivedCount,
      schemaRejectedCount,
      truncated,
    };
  }

  /**
   * Explicit timeout per request via AbortController, exponential backoff
   * across attempts. Only 5xx and network-level failures are retried — a 4xx
   * means the request itself is wrong, and retrying it wastes the source's
   * time for no different outcome (collector etiquette, CLAUDE.md §6).
   */
  /** Delegates to the shared `fetchWithDeadline` (`fetch-with-deadline.ts`),
   * which holds the timeout across the body read and bounds its size. This
   * collector used to carry its own copy that did neither. */
  private fetchPage(url: string): Promise<FetchedBody> {
    return fetchWithDeadline(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      backoffDelaysMs: this.backoffDelaysMs,
      userAgent: USER_AGENT,
      source: "Sólides",
    });
  }
}

import { z } from "zod";
import { normalize } from "../domain/fingerprint";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { FetchedBody, fetchWithDeadline } from "./fetch-with-deadline";
import {
  CieeResponseEnvelopeSchema,
  CieeVaga,
  CieeVagaSchema,
} from "./ciee-schema";

const SOURCE = "ciee";
const ENDPOINT = "https://api.ciee.org.br/vagas/vitrine-vaga/publicadas";

/** Identifies what this is, honestly (CLAUDE.md §6). */
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RESULTS = 6_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Education levels this collector keeps. `SU` is *superior* — a university
 * course, which is what `config/profile.yaml` describes. `EM` (ensino médio)
 * and `TE` (técnico) postings are not a worse fit, they are an ineligible
 * one: the candidate cannot hold them at all.
 *
 * Filtered here rather than in the pre-filter because the pre-filter has no
 * education-level rule and `Posting` has no field to carry one — and because
 * CIEE states it as a clean enum, so the cheapest correct place to act on it
 * is where that enum still exists.
 */
const DEFAULT_EDUCATION_LEVELS = ["SU"];

const CieeCollectorCriteriaSchema = z.object({
  /**
   * Matched against `areaProfissional`, CIEE's own role taxonomy
   * ("Informática", "Administrativa"). Reuses the same config field
   * `GupyCollector` uses for its server-side `jobName`, so one
   * `collection.queries` entry means the same thing to both sources even
   * though one filters at the source and the other cannot.
   */
  jobName: z.string().optional(),
  city: z.string().optional(),
  /**
   * Accepted and ignored, deliberately. CIEE publishes no remote/work-mode
   * flag at all, so honouring this would mean inventing an answer — and
   * `workMode` normalizes to `unknown`, which ADR-011's leniency rule
   * already handles correctly.
   */
  isRemoteWork: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  educationLevels: z.array(z.string()).optional(),
});

export type CieeCollectorCriteria = z.infer<typeof CieeCollectorCriteriaSchema>;

type FetchLike = typeof fetch;

export interface CieeCollectorOptions {
  /** Injected for tests — no test makes a real network call
   * (docs/07-testing-strategy.md). */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  requestIntervalMs?: number;
  backoffDelaysMs?: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(page: number, size: number): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set("size", String(size));
  url.searchParams.set("page", String(page));
  return url.toString();
}

/** Substring match on normalized text — deliberately looser than the
 * pre-filter's whole-word rule, because these are broad category names
 * ("Informática") being matched against a configured term, not short tokens
 * being matched against free text. */
function matchesText(value: string | null | undefined, term: string): boolean {
  if (!value) return false;
  return normalize(value).includes(normalize(term));
}

function keep(vaga: CieeVaga, criteria: CieeCollectorCriteria): boolean {
  const levels = criteria.educationLevels ?? DEFAULT_EDUCATION_LEVELS;
  if (levels.length > 0 && !levels.includes(vaga.nivelEscolar ?? "")) {
    return false;
  }
  if (criteria.city && !matchesText(vaga.local?.cidade, criteria.city)) {
    return false;
  }
  if (
    criteria.jobName &&
    !matchesText(vaga.areaProfissional, criteria.jobName)
  ) {
    return false;
  }
  return true;
}

/**
 * CIEE — Brazil's largest internship agency (M11). Never throws: every
 * failure path returns a `CollectionResult` with `error` set, matching
 * `CollectorPort` (principle 1). `postings` carries whatever pages already
 * succeeded before the failing one, not `[]` unconditionally (docs/audit
 * AC-004).
 *
 * **Fetches the whole board, then filters in memory**, which is not how
 * `GupyCollector` works and is not a preference. Every filter parameter
 * tried against this endpoint — `uf`, `cidade`, `nivelEscolar`, `descricao`,
 * `palavraChave` — is silently ignored and returns the same total, so
 * narrowing at the source is simply not on offer. `size=100` *is* honoured,
 * which keeps a full sweep at ~58 requests.
 *
 * That makes this collector expensive in requests where Gupy is cheap:
 * roughly a minute and a half of paging, spaced by the same ~1.5 s the
 * etiquette requires. Acceptable against a cycle that runs every four hours;
 * worth revisiting if CIEE ever starts honouring a filter.
 *
 * `robots.txt` permits it explicitly — the file's only rule is
 * `Disallow:` (empty), which allows everything, checked 2026-08-16.
 */
export class CieeCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: number[];

  constructor(options: CieeCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();

    const parsed = CieeCollectorCriteriaSchema.safeParse(rawCriteria ?? {});
    if (!parsed.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid CIEE collection criteria",
          cause: parsed.error,
        },
      };
    }
    const criteria = parsed.data;
    const pageSize = criteria.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;

    const postings: RawPosting[] = [];
    let scanned = 0;
    let schemaRejectedCount = 0;
    let businessRejectedCount = 0;
    let truncated = false;
    let page = 0;

    try {
      // Bounds raw items scanned, not postings kept — the same reasoning
      // GupyCollector documents: bounding on kept count would make the
      // collector page harder exactly when the source starts degrading.
      while (scanned < maxResults) {
        if (page > 0) await sleep(this.requestIntervalMs);

        const response = await this.fetchPage(buildUrl(page, pageSize));
        if (!response.ok) {
          return {
            source: SOURCE,
            postings,
            collectedAt,
            receivedCount: scanned,
            schemaRejectedCount,
            businessRejectedCount,
            error: {
              message: `CIEE responded ${response.status} ${response.statusText}`,
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
            receivedCount: scanned,
            schemaRejectedCount,
            businessRejectedCount,
            error: { message: "Malformed CIEE response body", cause },
          };
        }

        const envelope = CieeResponseEnvelopeSchema.safeParse(body);
        if (!envelope.success) {
          return {
            source: SOURCE,
            postings,
            collectedAt,
            receivedCount: scanned,
            schemaRejectedCount,
            businessRejectedCount,
            error: {
              message: "Unexpected CIEE response shape",
              cause: envelope.error,
            },
          };
        }

        const items = envelope.data.content;
        if (items.length === 0) break;

        // CIEE paginates by page number, not offset, so the request itself
        // cannot ask for fewer than a full `pageSize` on the final page
        // without risking a different `page * size` cursor than every
        // earlier request used. Bounding `maxResults` exactly (docs/audit
        // PR-015) instead happens here, client-side: only the items still
        // needed to reach the cap are scanned/kept from this page, even
        // though the full page was already downloaded.
        const remaining = maxResults - scanned;
        if (items.length > remaining) truncated = true;
        const itemsToProcess =
          items.length > remaining ? items.slice(0, remaining) : items;

        for (const item of itemsToProcess) {
          const vaga = CieeVagaSchema.safeParse(item);
          // A single malformed posting is skipped, never fatal — the schema
          // is deliberately tolerant, so only a pathological item fails it.
          if (!vaga.success) {
            schemaRejectedCount += 1;
            continue;
          }
          // Not a schema rejection — CIEE's own education-level/area filter,
          // an intentional, already-controlled drop, counted separately from
          // AC-012's "silent schema drift" concern.
          if (!keep(vaga.data, criteria)) {
            businessRejectedCount += 1;
            continue;
          }
          postings.push({
            source: SOURCE,
            sourceId: String(vaga.data.codigoVaga),
            payload: vaga.data,
          });
        }

        scanned += itemsToProcess.length;
        if (envelope.data.last === true || items.length < pageSize) break;
        // A full page and the source's own `last` flag says there is more —
        // if the cap stops the next iteration, that is a real truncation,
        // not the source running out (docs/audit AC-013).
        if (scanned >= maxResults) truncated = true;
        page += 1;
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        source: SOURCE,
        postings,
        collectedAt,
        receivedCount: scanned,
        schemaRejectedCount,
        businessRejectedCount,
        error: { message: `CIEE request failed: ${detail}`, cause },
      };
    }

    return {
      source: SOURCE,
      postings,
      collectedAt,
      receivedCount: scanned,
      schemaRejectedCount,
      businessRejectedCount,
      truncated,
    };
  }

  /** Timeout per request, exponential backoff across attempts, and only
   * 5xx/network failures retried — a 4xx means the request is wrong and
   * retrying wastes the source's time (CLAUDE.md §6). */
  /** Delegates to the shared `fetchWithDeadline` (`fetch-with-deadline.ts`),
   * which holds the timeout across the body read and bounds its size. This
   * collector used to carry its own copy that did neither. */
  private fetchPage(url: string): Promise<FetchedBody> {
    return fetchWithDeadline(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      backoffDelaysMs: this.backoffDelaysMs,
      userAgent: USER_AGENT,
      source: "CIEE",
    });
  }
}

import { z } from "zod";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { FetchedBody, fetchWithDeadline } from "./fetch-with-deadline";
import { NerdinJobSchema } from "./nerdin-schema";
import { parseNerdinListing } from "./nerdin-listing-parser";

const SOURCE = "nerdin";
const BASE_URL = "https://www.nerdin.com.br";

/**
 * Identifies what this is, honestly — never forged to imitate a browser
 * (CLAUDE.md §6, docs/02-architecture.md collector etiquette).
 */
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

/** Each posting costs a second request (listing → detail), so this is the
 * lever that bounds a broad query's real cost — the same reasoning
 * InfoJobs's identical default carries. */
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];

/** Observed page size on the real site (2026-08-27). Used only to notice a
 * short final page, never to assume a full one. */
const EXPECTED_PAGE_SIZE = 20;

/** Defence in depth: bounds the loop even if both the freshness guard and
 * the short-page check somehow fail. */
const MAX_PAGES = 10;

const NerdinCollectorCriteriaSchema = z.object({
  jobName: z.string().optional(),
  city: z.string().optional(),
  isRemoteWork: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});

export type NerdinCollectorCriteria = z.infer<
  typeof NerdinCollectorCriteriaSchema
>;

type FetchLike = typeof fetch;

export interface NerdinCollectorOptions {
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
 * Deliberately wider than `infojobs-collector.ts`'s equivalent, which
 * requires the tag to be exactly `<script type="application/ld+json">`. A
 * single extra attribute or a single quote makes that one match nothing —
 * and a source returning zero postings *looks empty rather than broken*,
 * which is the failure shape docs/11 B13 took six days to notice.
 */
const JSON_LD_BLOCK =
  /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Raw C0 control characters inside a JSON string are illegal and make
 * `JSON.parse` throw. A sibling Brazilian board (Programathor) emits them,
 * so one recovery attempt is cheap insurance rather than speculation. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function extractJobPostingJsonLd(detailHtml: string): unknown | null {
  for (const match of detailHtml.matchAll(JSON_LD_BLOCK)) {
    const parsed = parseJsonLd(match[1]!);
    if (parsed === null) continue;
    // The JobPosting is not always the first block — NerdIn emits
    // Organization/WebSite/BreadcrumbList too, which is the same lesson
    // ADR-063 Amendment 1 records for InfoJobs.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (
        item !== null &&
        typeof item === "object" &&
        (item as { "@type"?: unknown })["@type"] === "JobPosting"
      ) {
        return item;
      }
    }
  }
  return null;
}

function parseJsonLd(block: string): unknown | null {
  try {
    return JSON.parse(block) as unknown;
  } catch {
    try {
      return JSON.parse(block.replace(CONTROL_CHARACTERS, "")) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * NerdIn's search facets are separate PHP pages, combined with the search
 * query string — verified live: `vagas-home-office.php` states "1053 vagas
 * disponíveis" while `vagas-home-office.php?busca_vaga=estagi&busca=1`
 * states "4 vagas disponíveis", so the filter is genuinely applied rather
 * than silently ignored (the trap ADR-063 documents for InfoJobs).
 *
 * The path comes from a **fixed allowlist**, never interpolated from
 * config. That is what structurally guarantees this collector cannot
 * construct one of the paths NerdIn's `robots.txt` disallows (`/nadm*`,
 * `/vaga_candidatura.php`, `/login_*`, …) even from a mistyped query.
 */
function buildListingUrl(
  criteria: NerdinCollectorCriteria,
  page: number,
): string {
  const path = criteria.isRemoteWork ? "vagas-home-office.php" : "vagas.php";
  const url = new URL(`${BASE_URL}/${path}`);
  if (criteria.jobName) url.searchParams.set("busca_vaga", criteria.jobName);
  if (criteria.city) url.searchParams.set("busca_local", criteria.city);
  // The submit flag. Without it NerdIn ignores the search terms entirely
  // and returns the unfiltered board.
  url.searchParams.set("busca", "1");
  if (page > 1) url.searchParams.set("pagina", String(page));
  return url.toString();
}

/**
 * NerdIn (www.nerdin.com.br), an IT-only Brazilian job board — ADR-071.
 *
 * Structurally the same two-request shape as `InfoJobsCollector`: the
 * listing is server-rendered HTML carrying only ids and links, and each
 * detail page carries a full `application/ld+json` `JobPosting`. The
 * difference in NerdIn's favour is that its JSON-LD states
 * `jobLocationType: "TELECOMMUTE"` and `addressCountry` outright, so
 * `workMode` and `country` are read rather than inferred.
 *
 * `robots.txt` is `Allow: /`, disallowing only admin and candidature paths
 * — none of which this collector can reach, by construction. Verified
 * 2026-08-27.
 */
export class NerdinCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: number[];

  constructor(options: NerdinCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();
    const parsedCriteria = NerdinCollectorCriteriaSchema.safeParse(rawCriteria);
    if (!parsedCriteria.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid NerdIn collector criteria",
          cause: parsedCriteria.error,
        },
      };
    }
    const criteria = parsedCriteria.data;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;

    const cards: { id: string; href: string }[] = [];
    const seenIds = new Set<string>();
    let exhausted = false;
    let listingError: CollectionResult["error"];

    for (let page = 1; page <= MAX_PAGES && cards.length < maxResults; page++) {
      if (page > 1) await sleep(this.requestIntervalMs);

      let listingHtml: string;
      try {
        const response = await this.fetchPage(buildListingUrl(criteria, page));
        if (!response.ok) {
          listingError = {
            message: `NerdIn listing responded ${response.status}`,
          };
          break;
        }
        listingHtml = response.body;
      } catch (cause) {
        listingError = { message: "NerdIn listing request failed", cause };
        break;
      }

      const pageCards = parseNerdinListing(listingHtml);
      const fresh = pageCards.filter((card) => !seenIds.has(card.id));

      // The guard that makes pagination safe. NerdIn honours `?pagina=`
      // when further pages exist and **silently returns page one when they
      // do not** — verified on the real site, where a 9-result search
      // returns those same 9 for `pagina=2`. (`?page=` and `?p=` are
      // ignored outright.) Without this, any `maxResults` above one page's
      // worth would re-fetch and re-detail the same postings up to the page
      // cap, multiplying request volume against the source for nothing.
      if (fresh.length === 0) {
        exhausted = true;
        break;
      }

      for (const card of fresh) seenIds.add(card.id);
      cards.push(...fresh);

      // Checked before the loop condition can exit on `maxResults`, not
      // after: a board holding exactly `maxResults` matches returns one
      // short-or-equal page and has dropped nothing, but the loop would
      // leave `exhausted` false and report `truncated` on every single run.
      if (pageCards.length < EXPECTED_PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }

    // A listing failure on page 2+ keeps the pages that already succeeded —
    // the port's own rule that `error` being set does not imply `postings`
    // is empty (docs/audit AC-004).
    if (listingError && cards.length === 0) {
      return { source: SOURCE, postings: [], collectedAt, error: listingError };
    }

    const cardsToFetch = cards.slice(0, maxResults);
    // Counts what was actually fetched, not what was seen. `CieeCollector`
    // does this correctly and `InfoJobsCollector` does not: reporting every
    // card seen while fetching only `maxResults` of them breaks AC-012's
    // reconciliation identity (collected = schemaRejected + normalized +
    // normalizationRejected) by exactly the truncated remainder.
    const receivedCount = cardsToFetch.length;
    const truncated = !exhausted && cards.length >= maxResults;

    let schemaRejectedCount = 0;
    const postings: RawPosting[] = [];
    for (const [index, card] of cardsToFetch.entries()) {
      if (index > 0) await sleep(this.requestIntervalMs);

      const detailUrl = new URL(card.href, `${BASE_URL}/`).toString();
      try {
        // Scoped to this card, deliberately: one posting's detail page
        // failing is a per-item loss (principle 1), not a whole-collection
        // failure. A loop-wide try/catch here is the exact bug ADR-063
        // records catching in its own tests.
        const response = await this.fetchPage(detailUrl);
        if (!response.ok) {
          schemaRejectedCount += 1;
          continue;
        }
        const jsonLd = extractJobPostingJsonLd(response.body);
        if (!jsonLd || typeof jsonLd !== "object") {
          schemaRejectedCount += 1;
          continue;
        }

        const parsed = NerdinJobSchema.safeParse({
          ...jsonLd,
          // From the listing href, never the JSON-LD `identifier` — see the
          // normalizer for why identity must not move.
          id: card.id,
          jobUrl: detailUrl,
          // Records that NerdIn's own home-office facet returned this
          // posting. Kept even though `jobLocationType` exists: a remote
          // posting missing that field would otherwise be judged on the
          // employer's physical address and rejected on location, which is
          // docs/11 B18 exactly.
          isRemoteQuery: criteria.isRemoteWork === true,
        });
        if (!parsed.success) {
          schemaRejectedCount += 1;
          continue;
        }
        postings.push({
          source: SOURCE,
          sourceId: parsed.data.id,
          payload: parsed.data,
        });
      } catch {
        schemaRejectedCount += 1;
      }
    }

    return {
      source: SOURCE,
      postings,
      collectedAt,
      receivedCount,
      schemaRejectedCount,
      truncated,
      ...(listingError ? { error: listingError } : {}),
    };
  }

  /**
   * Explicit timeout per request via AbortController, exponential backoff
   * across attempts. Only 5xx and network-level failures are retried — a
   * 4xx means the request itself is wrong, and retrying it wastes the
   * source's time for no different outcome (CLAUDE.md §6).
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
      source: "NerdIn",
    });
  }
}

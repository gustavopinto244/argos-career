import { z } from "zod";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { FetchedBody, fetchWithDeadline } from "./fetch-with-deadline";
import { InfoJobsJobSchema } from "./infojobs-schema";
import { parseInfoJobsListing } from "./infojobs-listing-parser";

const SOURCE = "infojobs";
const BASE_URL = "https://www.infojobs.com.br";

/**
 * Identifies what this is, honestly — never forged to imitate a browser
 * (CLAUDE.md §6, docs/02-architecture.md collector etiquette).
 */
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];

const InfoJobsCollectorCriteriaSchema = z.object({
  jobName: z.string().optional(),
  city: z.string().optional(),
  isRemoteWork: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});

export type InfoJobsCollectorCriteria = z.infer<
  typeof InfoJobsCollectorCriteriaSchema
>;

type FetchLike = typeof fetch;

export interface InfoJobsCollectorOptions {
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
 * Only the Rio de Janeiro metro this project's search profile covers
 * (CLAUDE.md §1) is mapped, matching `SolidesCollector`'s own
 * `RJ_METRO_STATE_SUFFIX` precedent — an unmapped city falls back to a
 * generic slugify rather than failing, so a config typo degrades to
 * "probably wrong URL, zero results" rather than a crash.
 */
const RJ_METRO_SLUG: ReadonlyMap<string, string> = new Map([
  ["Rio de Janeiro", "rio-de-janeiro"],
  ["Niterói", "niteroi"],
  ["São Gonçalo", "sao-goncalo"],
]);

const REMOTE_SLUG = "trabalho-home-office";

// Same combining-marks range title-match.ts's own normalizer uses.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The friendly-URL scheme found by reading the real facet links' own
 * `data-url` attributes (ADR-063), not guessed from the legacy
 * `?palabra=&provincia=` query-string form — that form silently returns
 * the unfiltered nationwide set, verified live before this collector was
 * written. `jobName` spaces become `+` (matching InfoJobs's own facet URLs,
 * e.g. `estagio+ti`); the location suffix is a plain hyphenated slug with
 * no separating character.
 */
function buildListingUrl(criteria: InfoJobsCollectorCriteria): string {
  const term = (criteria.jobName ?? "estagio").trim().replace(/\s+/g, "+");
  const locationSlug = criteria.isRemoteWork
    ? REMOTE_SLUG
    : criteria.city
      ? (RJ_METRO_SLUG.get(criteria.city) ?? slugify(criteria.city))
      : null;
  const path = locationSlug
    ? `vagas-de-emprego-${term}-${locationSlug}.aspx`
    : `vagas-de-emprego-${term}.aspx`;
  return `${BASE_URL}/${path}`;
}

/**
 * The **`JobPosting`** block specifically, not merely the first
 * `application/ld+json` script on the page.
 *
 * Every real detail page sampled during discovery (ADR-063) carried
 * exactly one such block, and it was the `JobPosting` — so a
 * take-the-first implementation worked. It would keep working right up
 * until InfoJobs adds the `BreadcrumbList` or `Organization` block that
 * job sites commonly render *before* the posting one, at which point
 * every posting would silently fail schema validation and the source
 * would look empty rather than broken. That is precisely the
 * indistinguishable-failure shape `docs/11-known-issues.md` B13 was
 * about, so it is checked rather than assumed.
 */
function extractJobPostingJsonLd(detailHtml: string): unknown | null {
  const blocks = detailHtml.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  );
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]!) as unknown;
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { "@type"?: unknown })["@type"] === "JobPosting"
    ) {
      return parsed;
    }
  }
  return null;
}

/**
 * `InfoJobsCollector` never throws — every failure path returns a
 * `CollectionResult` with `error` set, matching `CollectorPort`'s contract
 * (docs/05-domain-model.md, principle 1).
 *
 * Two real HTTP requests per posting, not one: the listing page has no
 * description or structured location (`infojobs-listing-parser.ts`'s own
 * doc comment), only a card id and a detail-page link, so every card the
 * listing returns costs one additional detail-page fetch, paced by the
 * same `requestIntervalMs` as every other request this collector makes
 * (CLAUDE.md §6). Bounded by `maxResults`, same as every other collector's
 * cap — this is the lever that keeps a broad query's real cost bounded.
 *
 * **Single-page only.** No working pagination parameter was found during
 * discovery (ADR-063) — every guessed query parameter (`Pagina`, `pagina`,
 * `page`, `Page`) returned page 1's own content again, not page 2's. This
 * bounds a single query to whatever the listing's first page returns
 * (~20 cards observed), an accepted, documented gap, not a silent one —
 * see ADR-063's own "what this does not do."
 */
export class InfoJobsCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: number[];

  constructor(options: InfoJobsCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();

    const criteriaResult = InfoJobsCollectorCriteriaSchema.safeParse(
      rawCriteria ?? {},
    );
    if (!criteriaResult.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid InfoJobs collection criteria",
          cause: criteriaResult.error,
        },
      };
    }
    const criteria = criteriaResult.data;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;

    let schemaRejectedCount = 0;

    let listingHtml: string;
    try {
      const listingUrl = buildListingUrl(criteria);
      const response = await this.fetchPage(listingUrl);
      if (!response.ok) {
        return {
          source: SOURCE,
          postings: [],
          collectedAt,
          error: {
            message: `InfoJobs responded ${response.status} ${response.statusText}`,
          },
        };
      }
      listingHtml = response.body;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: { message: `InfoJobs listing request failed: ${detail}`, cause },
      };
    }

    const cards = parseInfoJobsListing(listingHtml);
    const receivedCount = cards.length;
    const truncated = cards.length > maxResults;
    const cardsToFetch = cards.slice(0, maxResults);

    const postings: RawPosting[] = [];
    for (const [index, card] of cardsToFetch.entries()) {
      if (index > 0) await sleep(this.requestIntervalMs);

      const detailUrl = new URL(card.href, BASE_URL).toString();
      try {
        // One posting's detail page failing — a non-ok response, a
        // timeout, or `fetchPage` exhausting its own retries — is a
        // per-item loss (principle 1), not a whole-collection failure: the
        // listing itself already succeeded, and every other card is
        // independent. Scoped to just this card's fetch/parse so a thrown
        // error here (unlike a non-ok response, which returns normally)
        // cannot abort the rest of the loop.
        const response = await this.fetchPage(detailUrl);
        if (!response.ok) {
          schemaRejectedCount += 1;
          continue;
        }
        const detailHtml = response.body;
        const jsonLd = extractJobPostingJsonLd(detailHtml);
        if (!jsonLd || typeof jsonLd !== "object") {
          schemaRejectedCount += 1;
          continue;
        }

        // `isRemoteQuery` is this collector's own annotation, not
        // InfoJobs's — the same shape `id`/`jobUrl` already are. It carries
        // one fact the JSON-LD genuinely cannot: that this posting came
        // back from InfoJobs's **own** `-trabalho-home-office` facet, which
        // is the source asserting the role is home-office. Without it the
        // normalizer can only see the employer's physical address, and a
        // genuinely remote São Paulo posting is rejected by the pre-filter's
        // location rule — measured, not theorised: 2 of 5 real postings from
        // the live remote query were lost exactly this way before this
        // existed. Reading a source-declared fact, not mining prose for one
        // (CLAUDE.md §15) — a "Home Office" mention in a title or
        // description is still deliberately ignored.
        const merged = {
          ...jsonLd,
          id: card.id,
          jobUrl: detailUrl,
          isRemoteQuery: criteria.isRemoteWork === true,
        };
        const parsed = InfoJobsJobSchema.safeParse(merged);
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
      source: "InfoJobs",
    });
  }
}

import { z } from "zod";
import {
  CollectionError,
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
  /** Age window this query cares about, in days (ADR-079). Absent keeps the
   * pre-ADR-079 behaviour: one unfiltered listing request, every card's
   * detail page fetched. */
  maxAgeDays: z.number().int().positive().optional(),
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

/**
 * InfoJobs's own `Antiguedad` age facet, bucket number → the oldest posting
 * that bucket contains, in days. Read from the real facet links' `data-url`
 * attributes and their labels (ADR-079), the same way ADR-063 found the
 * location suffix: 1 "Hoje", 2 "Últimos 3 dias", 3 "Última semana",
 * 4 "Últimos 15 dias", 5 "Último mês".
 *
 * **The buckets are disjoint, not cumulative** — measured, not assumed,
 * because the labels read cumulative and the naive reading would silently
 * drop postings. Against a live 20-card listing: bucket 2 returned the 3
 * newest ids, bucket 3 returned 20 *older* ids, and every pair of buckets
 * intersected in exactly zero ids. So covering "the last N days" means
 * fetching buckets 1..k and taking their union, never bucket k alone.
 */
const ANTIGUEDAD_BUCKET_MAX_AGE_DAYS: readonly number[] = [1, 3, 7, 15, 30];

/**
 * The buckets whose union covers `maxAgeDays`, or `null` when no bucket
 * combination does (a window longer than the oldest bucket) — in which case
 * the caller falls back to one unfiltered listing request.
 *
 * Always returns a *prefix* `[1..k]`, never a single bucket, because of the
 * disjointness above.
 */
function antiguedadBucketsFor(maxAgeDays: number | undefined): number[] | null {
  if (maxAgeDays === undefined) return null;
  const index = ANTIGUEDAD_BUCKET_MAX_AGE_DAYS.findIndex(
    (days) => days >= maxAgeDays,
  );
  if (index === -1) return null;
  return Array.from({ length: index + 1 }, (_, i) => i + 1);
}

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
function buildListingUrl(
  criteria: InfoJobsCollectorCriteria,
  antiguedadBucket?: number,
): string {
  const term = (criteria.jobName ?? "estagio").trim().replace(/\s+/g, "+");
  const locationSlug = criteria.isRemoteWork
    ? REMOTE_SLUG
    : criteria.city
      ? (RJ_METRO_SLUG.get(criteria.city) ?? slugify(criteria.city))
      : null;
  const path = locationSlug
    ? `vagas-de-emprego-${term}-${locationSlug}.aspx`
    : `vagas-de-emprego-${term}.aspx`;
  const query =
    antiguedadBucket === undefined ? "" : `?Antiguedad=${antiguedadBucket}`;
  return `${BASE_URL}/${path}${query}`;
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
 *
 * `maxAgeDays` softens both problems at once (ADR-079). It replaces the one
 * unfiltered listing request with one per `Antiguedad` age bucket covering
 * the window, so postings too old to survive the recency cutoff never cost
 * a detail-page fetch — measured at 2,027 wasted detail fetches over eight
 * production days — and, because each bucket returns its own page of
 * results, the union reaches postings the single page truncated away
 * (61 ids vs 20, on one live listing).
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

    // One listing request per age bucket (ADR-079), or a single unfiltered
    // one when the query states no window. Buckets are disjoint, so this is
    // a union, deduplicated by card id purely defensively — two buckets
    // returning the same id would mean InfoJobs changed the facet's
    // semantics, and counting a posting twice is worse than the extra Map.
    const buckets = antiguedadBucketsFor(criteria.maxAgeDays);
    const listingUrls =
      buckets === null
        ? [buildListingUrl(criteria)]
        : buckets.map((bucket) => buildListingUrl(criteria, bucket));

    const cardsById = new Map<string, { id: string; href: string }>();
    let listingError: CollectionError | undefined;

    for (const [index, listingUrl] of listingUrls.entries()) {
      if (index > 0) await sleep(this.requestIntervalMs);
      try {
        const response = await this.fetchPage(listingUrl);
        if (!response.ok) {
          listingError ??= {
            message: `InfoJobs responded ${response.status} ${response.statusText}`,
          };
          continue;
        }
        for (const card of parseInfoJobsListing(response.body)) {
          if (!cardsById.has(card.id)) cardsById.set(card.id, card);
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        listingError ??= {
          message: `InfoJobs listing request failed: ${detail}`,
          cause,
        };
      }
    }

    // One bucket failing is a partial loss, not a collection failure — the
    // other buckets' cards are real and independent, the same reasoning
    // AC-004 applies to a paging collector's later-page failure. Only a run
    // that recovered *no* listing at all returns empty-with-error.
    if (cardsById.size === 0 && listingError) {
      return { source: SOURCE, postings: [], collectedAt, error: listingError };
    }

    const cards = [...cardsById.values()];
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
      // Set when at least one bucket failed but others succeeded: the run is
      // recorded as a source failure (so the recency window widens on the
      // next pass) while every posting recovered still persists.
      ...(listingError ? { error: listingError } : {}),
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

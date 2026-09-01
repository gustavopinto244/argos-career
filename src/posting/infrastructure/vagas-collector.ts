import { z } from "zod";
import {
  CollectionResult,
  CollectorPort,
} from "../domain/ports/collector.port";
import { RawPosting } from "../domain/raw-posting";
import { FetchedBody, fetchWithDeadline } from "./fetch-with-deadline";
import { VagasJobSchema } from "./vagas-schema";
import { ListingCard, parseVagasListing } from "./vagas-listing-parser";

const SOURCE = "vagas";
const BASE_URL = "https://www.vagas.com.br";

/**
 * Identifies what this is, honestly — never forged to imitate a browser
 * (CLAUDE.md §6, docs/02-architecture.md collector etiquette).
 */
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

const DEFAULT_MAX_RESULTS = 40;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000];
const PAGE_SIZE = 40;

/**
 * Vagas.com's own facets, read from the real filter links rather than
 * guessed (ADR-080): `a[]=24` is area "Informática/T.I.", `h[]=28` is
 * level "Estágio". **Always applied, not a criteria option** — plain text
 * search on this source matches "estágio" alone and returns "Estágio
 * Nutrição", "Estagiário de Educação Física" for a query like
 * `estagio-desenvolvimento`, measured live before this was corrected. This
 * project only ever wants this source's IT-internship inventory; every
 * query issued through this collector wants both facets, so there is no
 * criterion to turn them off — the same reasoning that makes
 * `titleRequired` a pipeline-wide constant rather than a per-query option.
 */
const AREA_TI_FACET = "a%5B%5D=24";
const LEVEL_ESTAGIO_FACET = "h%5B%5D=28";
const REMOTE_FACET = "m%5B%5D=100%25+Home+Office";

const VagasCollectorCriteriaSchema = z.object({
  city: z.string().optional(),
  isRemoteWork: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  /** ADR-080: skips the detail-page fetch for any card whose listing badge
   * resolves to older than this many days. Unlike InfoJobs (ADR-079), no
   * extra listing request is needed — the badge is already on the single
   * page this collector fetches anyway. */
  maxAgeDays: z.number().int().positive().optional(),
});

export type VagasCollectorCriteria = z.infer<
  typeof VagasCollectorCriteriaSchema
>;

type FetchLike = typeof fetch;

export interface VagasCollectorOptions {
  /** Injected for tests — no test ever makes a real network call
   * (docs/07-testing-strategy.md). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  requestIntervalMs?: number;
  backoffDelaysMs?: number[];
  /** Injected for tests, so a relative badge ("Hoje", "Há 3 dias") resolves
   * against a fixed instant instead of the real clock. Defaults to `Date.now`. */
  now?: () => Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildListingUrl(
  criteria: VagasCollectorCriteria,
  page: number,
): string {
  const citySlug = criteria.city ? `-${slugify(criteria.city)}` : "";
  const params = [
    AREA_TI_FACET,
    LEVEL_ESTAGIO_FACET,
    ...(criteria.isRemoteWork ? [REMOTE_FACET] : []),
    "ordenar_por=mais_recentes",
    ...(page > 1 ? [`pagina=${page}`] : []),
  ];
  return `${BASE_URL}/vagas-de-estagio${citySlug}?${params.join("&")}`;
}

/**
 * Vagas.com's own publication-date badge, verbatim off the listing card:
 * "Hoje", "Ontem", "Há N dias", or an absolute "DD/MM/YYYY" for anything
 * older — every form observed in a real capture. `null` on anything else,
 * the same "absence of a date is not evidence of an old posting" leniency
 * `executeCollect`'s own cutoff applies (ADR-011) — an unparseable badge
 * never blocks a detail-page fetch.
 */
export function parsePublishedLabel(
  label: string | null,
  now: Date,
): Date | null {
  if (!label) return null;
  const trimmed = label.trim();

  if (/^hoje$/i.test(trimmed)) return now;
  if (/^ontem$/i.test(trimmed)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
  const relative = /^há\s+(\d+)\s+dias?$/i.exec(trimmed);
  if (relative) {
    const days = Number(relative[1]);
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }
  const absolute = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (absolute) {
    const [, day, month, year] = absolute;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * The **`JobPosting`** block specifically, not merely the first
 * `application/ld+json` script on the page — the same B13-shaped hardening
 * `InfoJobsCollector` carries (docs/11-known-issues.md B18), applied here
 * from the start rather than found later.
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
 * `VagasCollector` never throws — every failure path returns a
 * `CollectionResult` with `error` set, matching `CollectorPort`'s contract
 * (docs/05-domain-model.md, principle 1).
 *
 * Two real HTTP requests per posting kept, same shape ADR-063 chose for
 * InfoJobs: the listing carries no description or structured location, only
 * a card id, a detail-page link and a publication-date badge, so every card
 * kept after the age filter below costs one detail-page fetch.
 *
 * **The age filter needs no extra request, unlike InfoJobs (ADR-079).**
 * InfoJobs's listing states no date at all, so filtering by age meant
 * querying a separate `Antiguedad` facet bucket per age range. Vagas.com's
 * listing puts a date badge directly on every card already being fetched
 * for `id`/`href` — so `maxAgeDays` costs nothing extra: cards outside the
 * window are simply never given a detail-page fetch, counted in
 * `businessRejectedCount` (a valid, known record intentionally excluded by
 * this collector's own recency policy — the same category CIEE's
 * education-level filter uses), while `receivedCount` still reflects every
 * card the listing actually returned.
 *
 * Paginated up to `maxResults`, same cap and `truncated` semantics every
 * other paginated collector in this project uses.
 */
export class VagasCollector implements CollectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly backoffDelaysMs: number[];
  private readonly now: () => Date;

  constructor(options: VagasCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.backoffDelaysMs = options.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
    this.now = options.now ?? (() => new Date());
  }

  async collect(rawCriteria: unknown): Promise<CollectionResult> {
    const collectedAt = new Date();

    const criteriaResult = VagasCollectorCriteriaSchema.safeParse(
      rawCriteria ?? {},
    );
    if (!criteriaResult.success) {
      return {
        source: SOURCE,
        postings: [],
        collectedAt,
        error: {
          message: "Invalid Vagas.com collection criteria",
          cause: criteriaResult.error,
        },
      };
    }
    const criteria = criteriaResult.data;
    const maxResults = criteria.maxResults ?? DEFAULT_MAX_RESULTS;
    const referenceNow = this.now();

    let schemaRejectedCount = 0;
    let businessRejectedCount = 0;

    // Paginate the listing until `maxResults` cards have been scanned, a
    // page comes back short of `PAGE_SIZE` (genuine exhaustion), or a page
    // fails outright.
    const cards: ListingCard[] = [];
    let truncated = false;
    let page = 1;
    let listingError: { message: string; cause?: unknown } | undefined;

    while (cards.length < maxResults) {
      if (page > 1) await sleep(this.requestIntervalMs);
      const listingUrl = buildListingUrl(criteria, page);
      try {
        const response = await this.fetchPage(listingUrl);
        if (!response.ok) {
          listingError = {
            message: `Vagas.com responded ${response.status} ${response.statusText}`,
          };
          break;
        }
        const pageCards = parseVagasListing(response.body);
        cards.push(...pageCards);
        if (pageCards.length < PAGE_SIZE) break;
        if (cards.length >= maxResults) {
          truncated = true;
          break;
        }
        page += 1;
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        listingError = {
          message: `Vagas.com listing request failed: ${detail}`,
          cause,
        };
        break;
      }
    }

    // A listing failure with nothing recovered yet is a whole-collection
    // failure; a failure after at least one page succeeded keeps those
    // cards (AC-004's reasoning — a later-page failure does not erase
    // earlier valid results).
    if (cards.length === 0 && listingError) {
      return { source: SOURCE, postings: [], collectedAt, error: listingError };
    }

    const receivedCount = cards.length;
    const cardsToFetch = cards.slice(0, maxResults);

    const postings: RawPosting[] = [];
    let fetchedAny = false;
    for (const card of cardsToFetch) {
      const publishedAt = parsePublishedLabel(
        card.publishedLabel,
        referenceNow,
      );
      if (
        criteria.maxAgeDays !== undefined &&
        publishedAt !== null &&
        referenceNow.getTime() - publishedAt.getTime() >
          criteria.maxAgeDays * 24 * 60 * 60 * 1000
      ) {
        businessRejectedCount += 1;
        continue;
      }

      if (fetchedAny) await sleep(this.requestIntervalMs);
      fetchedAny = true;

      const detailUrl = new URL(card.href, BASE_URL).toString();
      try {
        // One posting's detail page failing is a per-item loss (principle
        // 1), not a whole-collection failure — the listing already
        // succeeded, and every other card is independent.
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
        const merged = { ...jsonLd, id: card.id, jobUrl: detailUrl };
        const parsed = VagasJobSchema.safeParse(merged);
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
      businessRejectedCount,
      truncated,
      ...(listingError ? { error: listingError } : {}),
    };
  }

  private fetchPage(url: string): Promise<FetchedBody> {
    return fetchWithDeadline(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      backoffDelaysMs: this.backoffDelaysMs,
      userAgent: USER_AGENT,
      source: "Vagas.com",
    });
  }
}

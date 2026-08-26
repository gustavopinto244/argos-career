import { RawPosting } from "../domain/raw-posting";
import {
  createPosting,
  Location,
  normalizeCountry,
  Posting,
  WorkMode,
} from "../domain/posting";
import { IndeedJob, IndeedJobSchema } from "./indeed-schema";

/**
 * `is_remote` is the only work-mode signal jobspy provides — `false` means
 * "not confirmed remote", not "onsite": jobspy cannot distinguish onsite
 * from hybrid, and inventing that distinction would be exactly the kind of
 * fact CLAUDE.md §15 forbids guessing at. `unknown` is the honest reading,
 * and ADR-011's leniency rule already treats it correctly.
 */
function mapWorkMode(isRemote: boolean | null | undefined): WorkMode {
  return isRemote === true ? "remote" : "unknown";
}

/**
 * `location` is one free-text string ("Rio de Janeiro, RJ, BR"), unlike
 * Gupy's structured `city` field — the first comma-separated segment is the
 * city on every sampled row. Null on anything that doesn't parse to a
 * non-empty first segment, same tolerance the rest of this normalizer uses.
 */
function mapLocation(location: string | null | undefined): Location {
  const city = location?.split(",")[0]?.trim();
  return city ? { kind: "known", city } : { kind: "unknown" };
}

/**
 * The same free-text `location` string carries the country as its **last**
 * comma-separated segment on every sampled row ("Rio de Janeiro, RJ, BR").
 * Read only when that segment is already a two-letter code (ADR-068) —
 * `normalizeCountry` rejects anything else, so a row shaped
 * "Rio de Janeiro, RJ" or "Brazil" yields null rather than a guess.
 *
 * Null is not a problem in practice: `criteria.sourceDefaultCountry` maps
 * Indeed's null to BR, because `collectors/indeed/collect.py` pins
 * `country_indeed="Brazil"`. This exists so that a future remote/worldwide
 * pass stops being silently assumed Brazilian.
 */
function mapCountry(location: string | null | undefined): string | null {
  if (!location) return null;
  const segments = location.split(",");
  if (segments.length < 2) return null;
  return normalizeCountry(segments[segments.length - 1]);
}

/** Present and real on every sampled row (unlike CIEE — docs/11 B1), so no
 * `firstSeenAt`-fallback concern here. Null on anything unparseable, same
 * tolerance `mapApplicationDeadline`/`mapPublishedAt` use elsewhere. */
function mapPublishedAt(datePosted: string | null | undefined): Date | null {
  if (!datePosted) return null;
  const parsed = new Date(datePosted);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting`, for jobspy-sourced Indeed postings. Structurally
 * identical in shape to `normalizeGupyJob`/`normalizeCieeVaga` — same
 * `null`-on-anything-unparseable contract (principle 1 at the item level) —
 * but the raw payload arrives already-fetched, via the ingest endpoint
 * (ADR-027), never a network call this normalizer makes itself.
 *
 * `applicationDeadline` is always null — jobspy states no deadline field,
 * and absence is unknown, not expired (same reading `mapApplicationDeadline`
 * gives elsewhere).
 */
export function normalizeIndeedJob(raw: RawPosting, now: Date): Posting | null {
  const parsed = IndeedJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const job: IndeedJob = parsed.data;
  if (!job.company) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: job.company,
      title: job.title,
      location: mapLocation(job.location),
      country: mapCountry(job.location),
      workMode: mapWorkMode(job.is_remote),
      applicationDeadline: null,
      publishedAt: mapPublishedAt(job.date_posted),
      sourceUrl: job.job_url ?? null,
      description: job.description ?? null,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}

import { RawPosting } from "../domain/raw-posting";
import {
  createPosting,
  Location,
  normalizeCountry,
  Posting,
  WorkMode,
} from "../domain/posting";
import { NerdinJob, NerdinJobSchema } from "./nerdin-schema";

/** Accent- and case-folded, so `"Home Office"`, `"home office"` and a
 * future `"Home Óffice"` all compare equal. Same combining-marks strip
 * `normalizeTitle` uses. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/**
 * Localities that name a *work arrangement*, not a place (ADR-071).
 *
 * NerdIn writes `addressLocality: "Home Office"` with `addressRegion: "HO"`
 * on remote postings — verified on the real capture. Treating that as a
 * city would be actively harmful in two ways: `computeFingerprint` includes
 * the city, so identity would break the day the casing changed; and
 * `isLocationAllowed` would compare `"Home Office"` against
 * `criteria.location.cities` and reject a perfectly valid remote posting on
 * location. That second failure is docs/11 B18 exactly — InfoJobs lost 2 of
 * 5 real remote postings to it.
 *
 * `linkedin-alert-normalizer.ts` handles `"Brasil"` the same way and for
 * the same reason. The set is **observed values only**, extended when a new
 * literal is actually seen — not a guess at what a site might write.
 */
const NON_CITY_LOCALITIES = new Set([
  "home office",
  "homeoffice",
  "remoto",
  "brasil",
]);

/**
 * `workMode` from what the source declares, never from prose (CLAUDE.md
 * §15). Two independent source-stated signals, in priority order:
 *
 * 1. `jobLocationType` containing `TELECOMMUTE` — the posting's own field.
 * 2. `isRemoteQuery` — that NerdIn's own `vagas-home-office.php` facet
 *    returned it.
 *
 * **The second is kept even though the first exists**, deliberately. A
 * posting served by the remote facet but missing `jobLocationType` would
 * otherwise normalize to `unknown`, get judged on the employer's physical
 * address by `isLocationAllowed`, and be rejected — the B18 failure again.
 * Both are source-declared facts; using both costs nothing and closes the
 * hole.
 *
 * Never `hybrid` or `onsite`: schema.org has no HYBRID value, and absence
 * of `jobLocationType` means the source did not say, which is `unknown`,
 * not "onsite" (the same leniency `docs/05` applies to this field).
 */
function mapWorkMode(job: NerdinJob): WorkMode {
  const declared = job.jobLocationType;
  const values = Array.isArray(declared) ? declared : [declared];
  if (values.some((v) => typeof v === "string" && fold(v) === "telecommute")) {
    return "remote";
  }
  return job.isRemoteQuery === true ? "remote" : "unknown";
}

/** schema.org allows one `Place` or several; take the first. */
function firstPlace(job: NerdinJob): { address?: unknown } | undefined {
  const location = job.jobLocation;
  if (Array.isArray(location)) return location[0];
  return location ?? undefined;
}

function mapLocation(job: NerdinJob): Location {
  const address = firstPlace(job)?.address as
    { addressLocality?: string | null } | undefined;
  const locality = address?.addressLocality;
  if (!locality || NON_CITY_LOCALITIES.has(fold(locality))) {
    return { kind: "unknown" };
  }
  return { kind: "known", city: locality };
}

/**
 * ISO 3166-1 alpha-2 (ADR-068), from `jobLocation.address.addressCountry`,
 * falling back to `applicantLocationRequirements` — a `Country` object
 * NerdIn states on every posting sampled. Both go through
 * `normalizeCountry`, which rejects anything that is not a two-letter code
 * rather than translating a name.
 */
function mapCountry(job: NerdinJob): string | null {
  const address = firstPlace(job)?.address as
    { addressCountry?: unknown } | undefined;
  const fromAddress = readCountryValue(address?.addressCountry);
  if (fromAddress) return fromAddress;
  return readCountryValue(job.applicantLocationRequirements);
}

/** Accepts `"BR"` or `{ name: "BR" }`, the two shapes schema.org permits. */
function readCountryValue(value: unknown): string | null {
  if (value !== null && typeof value === "object" && "name" in value) {
    return normalizeCountry((value as { name?: unknown }).name);
  }
  return normalizeCountry(value);
}

/**
 * Every description sampled (4 postings, 133–937 chars) was **plain text**
 * — no tags, no entities. This is therefore deliberately light: strip any
 * tags that do appear and decode the handful of entities that would show up
 * if NerdIn ever starts emitting HTML, rather than building the fuller
 * converter `infojobs-normalizer.ts` needs for a source whose `<br>`-laden
 * markup was actually observed.
 *
 * Tag-stripping stays regardless of what was observed: it is what keeps a
 * `<script>` from ever reaching a model prompt (docs/audit AC-036).
 */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function cleanDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = value
    // Whole element, not just the tags: stripping `<script>` alone would
    // leave its body behind as text, which is not executable but is noise
    // in a Stage A prompt and in keyword matching.
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

/** Invalid or absent → null, never a throw and never NaN. Note the source
 * states `"2026-08-24T00:00:00"` with no offset, which ECMAScript parses as
 * *local* time; not corrected here, but worth knowing against the one-day
 * `recencyDays`/`maxFutureSkewDays` windows. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting` for NerdIn (ADR-071). Same contract as every
 * other normalizer: `null` on anything unparseable, never a throw
 * (`normalizer-registry.ts`).
 *
 * `sourceId` comes from `raw.sourceId` — the listing href's trailing id —
 * **not** from the JSON-LD `identifier`. The two matched on every sample,
 * but `identifier` may be a `PropertyValue` object or NerdIn's internal
 * key, and `sourceId` participates in dedup: changing what it means later
 * would re-collect the whole NerdIn corpus as new (ADR-007).
 */
export function normalizeNerdinJob(raw: RawPosting, now: Date): Posting | null {
  const parsed = NerdinJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const job = parsed.data;
  const company = job.hiringOrganization?.name;
  if (!company) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company,
      title: job.title,
      location: mapLocation(job),
      country: mapCountry(job),
      workMode: mapWorkMode(job),
      applicationDeadline: parseDate(job.validThrough),
      publishedAt: parseDate(job.datePosted),
      sourceUrl: job.jobUrl ?? null,
      description: cleanDescription(job.description),
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}

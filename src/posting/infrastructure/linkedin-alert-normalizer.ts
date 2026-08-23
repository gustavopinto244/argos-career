import { RawPosting } from "../domain/raw-posting";
import { createPosting, Location, Posting, WorkMode } from "../domain/posting";
import {
  LinkedinAlertJob,
  LinkedinAlertJobSchema,
} from "./linkedin-alert-schema";

/**
 * `location` arrives as one string — `"Rio de Janeiro, RJ (Híbrido)"` or
 * `"Brasil (Remoto)"` — with the work mode bundled inside a trailing
 * parenthetical. Splitting them is the whole point of this normalizer
 * (ADR-029): once separated, the existing pre-filter (`isLocationAllowed`,
 * ADR-011 Amendment 3) already rejects a hybrid posting outside the target
 * cities and passes any remote one, with no new pre-filter code — that
 * asymmetric leniency rule was built for Gupy/CIEE and applies unchanged
 * here.
 *
 * `"Brasil"` (country-level, no real city — every fully-remote alert
 * observed uses this) maps to `location: unknown`, not a literal city
 * named "Brasil". A city is only ever the text before the first comma in
 * a `"Cidade, UF"` pair — the state abbreviation is discarded, matching
 * every other source's city-only granularity.
 */
function parseLocationAndWorkMode(raw: string | null | undefined): {
  location: Location;
  workMode: WorkMode;
} {
  const unknown = {
    location: { kind: "unknown" } as Location,
    workMode: "unknown" as WorkMode,
  };
  if (!raw) return unknown;

  const match = /^(.*)\(([^)]+)\)\s*$/.exec(raw);
  if (!match) return unknown;

  const [, place, modeLabel] = match;
  const workMode = mapWorkModeLabel(modeLabel?.trim() ?? "");
  const placeTrimmed = place?.trim() ?? "";

  if (!placeTrimmed || placeTrimmed.toLowerCase() === "brasil") {
    return { location: { kind: "unknown" }, workMode };
  }
  const city = placeTrimmed.split(",")[0]?.trim();
  return {
    location: city ? { kind: "known", city } : { kind: "unknown" },
    workMode,
  };
}

function mapWorkModeLabel(label: string): WorkMode {
  const normalized = label.toLowerCase();
  if (normalized.includes("remoto")) return "remote";
  if (normalized.includes("híbrido") || normalized.includes("hibrido")) {
    return "hybrid";
  }
  if (normalized.includes("presencial")) return "onsite";
  return "unknown";
}

/**
 * LinkedIn's own `/jobs/view/<digits>/` URL shape, observed on every real
 * `link` sampled (including the 2026-08-23 row that motivated this
 * fallback). Not a guess at the id — the id is already present, verbatim,
 * inside a field this schema already validates; extracting it here is
 * reading a fact we already have, not inventing one (CLAUDE.md §15).
 */
function deriveSourceIdFromLink(link: string | null | undefined): string {
  if (!link) return "";
  const match = /\/jobs\/view\/(\d+)/.exec(link);
  return match?.[1] ?? "";
}

/**
 * `RawPosting` → `Posting`, for LinkedIn job-alert emails (ADR-029).
 *
 * `sourceId` was originally documented as "trusted from the envelope... the
 * caller (n8n) extracts the numeric id from the link's `/jobs/view/<id>/`
 * path before POSTing, this normalizer does not re-derive it." Real ingest
 * runs (`docs/11-known-issues.md` B15, 2026-08-18 through 2026-08-23)
 * showed that assumption was false: `raw.sourceId` arrived empty on every
 * item — confirmed directly against `posting_events.source_id`, which
 * recorded `null` for every rejected row, not a real id. Whatever n8n
 * sends, it is not populating the envelope's `sourceId`. Rather than keep
 * trusting a fact that measurably is not true, this normalizer now falls
 * back to `deriveSourceIdFromLink(job.link)` whenever `raw.sourceId` is
 * empty — the envelope is still preferred when a caller does supply it
 * (Indeed's collector, any future well-behaved caller), so this is a
 * fallback, not a replacement.
 *
 * `publishedAt` is always null. LinkedIn's alert email states no
 * publication date, only when the alert was sent — which is not the same
 * fact, and CLAUDE.md §15 forbids treating one as the other. This is
 * CIEE's exact situation (`docs/11-known-issues.md` B1): `firstSeenAt`
 * (set by the caller of this normalizer, not read from the payload) is
 * what `maxAgeDays` falls back to.
 *
 * `description` is always null — LinkedIn's alert email states no job
 * description, only title/company/location. Stage A already treats a null
 * description as "nothing to extract" at zero LLM cost
 * (`stage-a-extractor.ts`), and the resulting empty requirement list trips
 * `lowConfidence`, capping the verdict at `review` — the existing safety
 * net (`docs/04-scoring-model.md`) built for a different trigger, applying
 * here without any new code.
 */
export function normalizeLinkedinAlertJob(
  raw: RawPosting,
  now: Date,
): Posting | null {
  const parsed = LinkedinAlertJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const job: LinkedinAlertJob = parsed.data;
  const { location, workMode } = parseLocationAndWorkMode(job.location);
  const sourceId =
    raw.sourceId && raw.sourceId.trim().length > 0
      ? raw.sourceId
      : deriveSourceIdFromLink(job.link);
  if (!sourceId) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId,
      company: job.company,
      title: job.title,
      location,
      workMode,
      applicationDeadline: null,
      publishedAt: null,
      sourceUrl: job.link ?? null,
      description: null,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}

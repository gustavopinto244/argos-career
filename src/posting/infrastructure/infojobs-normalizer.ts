import { RawPosting } from "../domain/raw-posting";
import {
  createPosting,
  Location,
  normalizeCountry,
  Posting,
} from "../domain/posting";
import { InfoJobsJob, InfoJobsJobSchema } from "./infojobs-schema";

/**
 * InfoJobs's real `description` carries literal `<br>` tags as line breaks
 * (verified against every sample captured during discovery, ADR-063) — not
 * full HTML, just this one tag. Converted to newlines; any other tag
 * (never observed, but the field is free text from an employer, not a
 * contract) is stripped rather than left in place, so a stray `<script>`
 * or similar never reaches a prompt (docs/audit AC-036's own discipline
 * for untrusted posting text, `bound-and-sanitize-llm-inputs`).
 */
function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withBreaks = raw.replace(/<br\s*\/?>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, "").trim();
  return stripped.length > 0 ? stripped : null;
}

function mapLocation(job: InfoJobsJob): Location {
  const city = job.jobLocation?.address?.addressLocality;
  return city ? { kind: "known", city } : { kind: "unknown" };
}

/**
 * schema.org allows `addressCountry` to be either a bare string ("BR") or a
 * nested `Country` object with a `name` (ADR-068), so this reads both shapes
 * and lets `normalizeCountry` reject anything that is not a two-letter code.
 * Was not present in the captured sample; null is the expected result today
 * and `sourceDefaultCountry` covers it.
 */
function mapCountry(job: InfoJobsJob): string | null {
  const raw = job.jobLocation?.address?.addressCountry;
  if (raw !== null && typeof raw === "object" && "name" in raw) {
    return normalizeCountry((raw as { name?: unknown }).name);
  }
  return normalizeCountry(raw);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting`, for InfoJobs (ADR-063). Same
 * null-on-anything-unparseable contract as every other normalizer
 * (principle 1).
 *
 * `workMode` is `"remote"` when the collector reports this posting came
 * back from InfoJobs's own `-trabalho-home-office` facet
 * (`isRemoteQuery` — the source asserting the role is home-office), and
 * `"unknown"` otherwise. Never `"onsite"` or `"hybrid"`: InfoJobs's
 * `JobPosting` states only a physical `jobLocation`, and the free-text
 * "Modelo de trabalho: Híbrido" mention is deliberately not mined
 * (`infojobs-schema.ts`'s own doc comment). ADR-011's leniency rule
 * already treats an unknown work mode correctly: it does not rescue a
 * posting whose city is known and outside the target metro, and does not
 * block one whose city is unknown either.
 *
 * Getting this wrong was measured, not hypothetical. While `workMode` was
 * unconditionally `"unknown"`, every posting from the two remote queries
 * in `config/criteria.yaml` was rejected by that same location rule, on
 * the employer's physical address — 2 of 5 postings in a live run, which
 * made those queries structurally incapable of ever contributing one.
 */
export function normalizeInfoJobsJob(
  raw: RawPosting,
  now: Date,
): Posting | null {
  const parsed = InfoJobsJobSchema.safeParse(raw.payload);
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
      workMode: job.isRemoteQuery === true ? "remote" : "unknown",
      applicationDeadline: parseDate(job.validThrough),
      publishedAt: parseDate(job.datePosted),
      description: cleanDescription(job.description),
      sourceUrl: job.jobUrl ?? null,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}

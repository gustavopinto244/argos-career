import { RawPosting } from "../domain/raw-posting";
import { createPosting, Location, Posting } from "../domain/posting";
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
 * `workMode` is always `"unknown"` — InfoJobs's `JobPosting` states only a
 * physical `jobLocation`, never a structured remote/hybrid/onsite signal
 * (`infojobs-schema.ts`'s own doc comment explains why this is not
 * text-mined from `description`). ADR-011's leniency rule already treats
 * an unknown work mode correctly: it does not rescue a posting whose city
 * is known and outside the target metro, and does not block one whose
 * city is unknown either.
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
      workMode: "unknown",
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

import { RawPosting } from "../domain/raw-posting";
import {
  createPosting,
  Location,
  normalizeCountry,
  Posting,
} from "../domain/posting";
import { VagasJob, VagasJobSchema } from "./vagas-schema";

/**
 * No `<br>` line breaks or any other markup observed across a real sample
 * of `description` values (`npm run fixture:vagas`) — unlike InfoJobs's own
 * literal `<br>` convention. Tags are still stripped defensively, not
 * because one was ever seen: this is free-text employer input, not a
 * contract, and the same discipline InfoJobs's `cleanDescription` applies
 * for a stray `<script>` reaching a prompt (`bound-and-sanitize-llm-inputs`)
 * costs nothing here either.
 */
function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/<[^>]+>/g, "").trim();
  return stripped.length > 0 ? stripped : null;
}

/**
 * `"Localização não informada"` is Vagas.com's own placeholder text for a
 * posting with no stated city — observed verbatim on a real `TELECOMMUTE`
 * posting, not a real city named that (`vagas-schema.ts`'s own doc
 * comment). Filed as unknown rather than a literal city.
 */
const NO_LOCATION_PLACEHOLDER = "Localização não informada";

function mapLocation(job: VagasJob): Location {
  const city = job.jobLocation?.address?.addressLocality;
  return city && city !== NO_LOCATION_PLACEHOLDER
    ? { kind: "known", city }
    : { kind: "unknown" };
}

/**
 * Real, observed value is `"Brasil"` (the full name), not a two-letter
 * code — `normalizeCountry` rejects it and returns `null`, and
 * `sourceDefaultCountry` covers Vagas.com as Brazilian regardless
 * (`vagas-schema.ts`'s own doc comment).
 */
function mapCountry(job: VagasJob): string | null {
  return normalizeCountry(job.jobLocation?.address?.addressCountry);
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `RawPosting` → `Posting`, for Vagas.com (ADR-080). Same
 * null-on-anything-unparseable contract as every other normalizer
 * (principle 1).
 *
 * `workMode` reads schema.org's own `jobLocationType: "TELECOMMUTE"`
 * directly — a fact Vagas.com states about the posting, unlike InfoJobs
 * where this project's own collector has to annotate the payload from
 * which listing facet it queried (ADR-063). Never `"hybrid"` or
 * `"onsite"`: absence of `jobLocationType` states nothing about either, the
 * same caution `InfoJobsNormalizer` documents.
 */
export function normalizeVagasJob(raw: RawPosting, now: Date): Posting | null {
  const parsed = VagasJobSchema.safeParse(raw.payload);
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
      workMode: job.jobLocationType === "TELECOMMUTE" ? "remote" : "unknown",
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

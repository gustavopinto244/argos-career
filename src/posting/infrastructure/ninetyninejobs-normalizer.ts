import { RawPosting } from "../domain/raw-posting";
import { createPosting, normalizeCountry, Posting } from "../domain/posting";
import {
  NinetyNineJobsJob,
  NinetyNineJobsJobSchema,
} from "./ninetyninejobs-schema";

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const decoded = decodeHtml(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return decoded.length > 0 ? decoded : null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mapCountry(job: NinetyNineJobsJob): string | null {
  const raw = job.country;
  if (raw !== null && typeof raw === "object" && "name" in raw) {
    return normalizeCountry((raw as { name?: unknown }).name);
  }
  return normalizeCountry(raw);
}

export function normalizeNinetyNineJobsJob(
  raw: RawPosting,
  now: Date,
): Posting | null {
  const parsed = NinetyNineJobsJobSchema.safeParse(raw.payload);
  if (!parsed.success) return null;
  const job = parsed.data;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: job.company,
      title: job.title,
      location: job.city
        ? { kind: "known", city: job.city }
        : { kind: "unknown" },
      country: mapCountry(job),
      workMode: job.workMode,
      applicationDeadline: parseDate(job.validThrough),
      publishedAt: parseDate(job.datePosted),
      description: cleanDescription(job.description),
      sourceUrl: job.jobUrl,
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: job,
    });
  } catch {
    return null;
  }
}

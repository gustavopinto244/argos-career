import { z } from "zod";

/**
 * Fitted to the real `application/ld+json` `schema.org/JobPosting` block
 * every InfoJobs detail page carries — not a guess. Captured with
 * `npm run fixture:infojobs`; see `test/fixtures/infojobs-jobs.md` for the
 * curated, committed sample and its provenance note (ADR-063).
 *
 * `id` and `jobUrl` are not part of the real JSON-LD block — InfoJobs
 * states no id there at all. `InfoJobsCollector` adds both itself, from
 * the listing card's `data-id`/`data-href` (`infojobs-listing-parser.ts`),
 * before this schema ever sees the object; this schema validates the
 * *merged* shape the collector actually produces, not InfoJobs's raw
 * detail-page JSON-LD verbatim.
 *
 * Tolerant on the same terms as `GupyJobSchema`/`SolidesJobSchema`:
 * `.passthrough()`, and every field but `id`/`title` optional — this is an
 * undocumented use of a public schema.org block (InfoJobs never states a
 * stability contract for it), so a field present in every sample today is
 * not a guarantee it stays that way.
 *
 * **`workMode` has no structural signal here.** Unlike Gupy's
 * `workplaceType` or Indeed's `is_remote`, InfoJobs's `JobPosting` states
 * only a physical `jobLocation` address — hybrid/remote is, at best,
 * mentioned in free `description` text ("Modelo de trabalho: Híbrido"),
 * observed on a real sample but never structured. Not text-mined
 * (CLAUDE.md §15 — inventing a fact from prose is exactly what this
 * project avoids) — `InfoJobsNormalizer` maps every posting to `unknown`
 * work mode, honestly, unless a location-suffix query already establishes
 * it (see the normalizer's own doc comment).
 */
export const InfoJobsJobSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    datePosted: z.string().nullable().optional(),
    validThrough: z.string().nullable().optional(),
    jobUrl: z.string().nullable().optional(),
    hiringOrganization: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    jobLocation: z
      .object({
        address: z
          .object({
            addressLocality: z.string().nullable().optional(),
            addressRegion: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type InfoJobsJob = z.infer<typeof InfoJobsJobSchema>;

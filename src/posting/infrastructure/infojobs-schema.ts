import { z } from "zod";

/**
 * Fitted to the real `application/ld+json` `schema.org/JobPosting` block
 * every InfoJobs detail page carries — not a guess. Captured with
 * `npm run fixture:infojobs`; see `test/fixtures/infojobs-jobs.md` for the
 * curated, committed sample and its provenance note (ADR-063).
 *
 * `id`, `jobUrl` and `isRemoteQuery` are not part of the real JSON-LD
 * block — InfoJobs states no id there at all. `InfoJobsCollector` adds all
 * three itself, from the listing card's `data-id`/`data-href`
 * (`infojobs-listing-parser.ts`) and from which listing facet it queried;
 * this schema validates the *merged* shape the collector actually
 * produces, not InfoJobs's raw detail-page JSON-LD verbatim.
 *
 * Tolerant on the same terms as `GupyJobSchema`/`SolidesJobSchema`:
 * `.passthrough()`, and every field but `id`/`title` optional — this is an
 * undocumented use of a public schema.org block (InfoJobs never states a
 * stability contract for it), so a field present in every sample today is
 * not a guarantee it stays that way.
 *
 * **`workMode` has no structural signal inside the JSON-LD itself.**
 * Unlike Gupy's `workplaceType` or Indeed's `is_remote`, InfoJobs's
 * `JobPosting` states only a physical `jobLocation` address — hybrid or
 * remote is, at best, mentioned in free `description` text ("Modelo de
 * trabalho: Híbrido"), observed on a real sample but never structured.
 * That prose is deliberately **not** text-mined (CLAUDE.md §15).
 *
 * `isRemoteQuery` is the one honest remote signal available, and it does
 * not come from the posting at all: it records that InfoJobs returned this
 * posting from its own `-trabalho-home-office` facet — the source
 * asserting the role is home-office. `InfoJobsNormalizer` maps that to
 * `workMode: "remote"` and everything else to `"unknown"`.
 */
export const InfoJobsJobSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    datePosted: z.string().nullable().optional(),
    validThrough: z.string().nullable().optional(),
    jobUrl: z.string().nullable().optional(),
    isRemoteQuery: z.boolean().optional(),
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
            // schema.org's own field for the country (ADR-068). Declared
            // optional because it was NOT observed in the captured sample —
            // this schema's `.passthrough()` discipline means an absent
            // field is tolerated, and `sourceDefaultCountry` covers InfoJobs
            // as Brazilian regardless. Reading it if it appears is free;
            // requiring it would break a source that works today.
            addressCountry: z.unknown().nullable().optional(),
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

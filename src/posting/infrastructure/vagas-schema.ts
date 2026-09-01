import { z } from "zod";

/**
 * Fitted to the real `application/ld+json` `schema.org/JobPosting` block
 * every Vagas.com detail page carries — not a guess. Captured with
 * `npm run fixture:vagas`; see `test/fixtures/vagas-jobs.md` for the
 * curated, committed sample and its provenance note (ADR-080).
 *
 * `id` and `jobUrl` are not part of the real JSON-LD block at all —
 * `VagasCollector` adds both itself, from the listing card's
 * `data-id-vaga`/`href` (`vagas-listing-parser.ts`), the same convention
 * `InfoJobsJobSchema` documents for the same reason.
 *
 * Tolerant on the same terms as `InfoJobsJobSchema`/`GupyJobSchema`:
 * `.passthrough()`, and every field but `id`/`title` optional — an
 * undocumented use of a public schema.org block, no stability contract.
 *
 * **`jobLocationType` is a real, honest remote signal — unlike InfoJobs.**
 * InfoJobs's `JobPosting` states no remote/hybrid/onsite field anywhere, so
 * that collector had to annotate the payload itself from which listing
 * facet it queried (ADR-063). Vagas.com's detail page states
 * `jobLocationType: "TELECOMMUTE"` directly, schema.org's own value for
 * remote work, confirmed present on a real "100% Home Office" posting and
 * absent on every on-site one sampled — a fact about the posting itself,
 * not a fact this project has to infer from its own query. Still never
 * inferred as `hybrid`/`onsite` from its absence, the same caution
 * `InfoJobsNormalizer` documents: a job stating no `jobLocationType` might
 * be hybrid, might be on-site, and nothing here can tell the two apart.
 *
 * **`"Localização não informada"` is Vagas.com's own placeholder text**,
 * not a real city — observed verbatim on a `TELECOMMUTE` posting with no
 * stated location. `vagas-normalizer.ts` special-cases it to
 * `location: { kind: "unknown" }` rather than filing it as a literal city
 * named that (CLAUDE.md §15: read what the source states, but a literal
 * placeholder string is not a fact about the posting).
 */
export const VagasJobSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    datePosted: z.string().nullable().optional(),
    validThrough: z.string().nullable().optional(),
    jobUrl: z.string().nullable().optional(),
    jobLocationType: z.string().nullable().optional(),
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
            // Real, observed value: "Brasil" (the full name), not an ISO
            // code — `normalizeCountry` rejects it (it only accepts a
            // two-letter code) and returns `null`, and
            // `sourceDefaultCountry` covers Vagas.com as Brazilian
            // regardless, the same pattern `InfoJobsJobSchema` documents.
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

export type VagasJob = z.infer<typeof VagasJobSchema>;

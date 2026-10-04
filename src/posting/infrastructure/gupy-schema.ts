import { z } from "zod";

/**
 * Fitted to the response actually observed from
 * `https://portal.gupy.io/api/job-search/jobs` — not a guess. Captured
 * with `npm run fixture:gupy`; see `test/fixtures/gupy-jobs.json` for the
 * curated, committed sample and its provenance note.
 *
 * Tolerant on purpose (docs/05-domain-model.md): `.passthrough()` so an
 * unannounced new field from Gupy survives into the raw payload instead of
 * being silently dropped, and every field but `id` and `name` is optional —
 * this is an undocumented third-party API, and a field present in every
 * sample today is not a guarantee it stays that way.
 *
 * `type` and `workplaceType` are kept as open strings rather than enums.
 * Four distinct `type` values were already observed in a small sample
 * (vacancy_type_effective, vacancy_type_talent_pool, vacancy_legal_entity,
 * vacancy_type_internship) — enough to expect more exist. Mapping these
 * strings onto ArgosCareer's own domain vocabulary (Seniority, WorkMode) is
 * the Normalize stage's job, not this schema's.
 */
export const GupyJobSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    companyId: z.union([z.number(), z.string()]).optional(),
    description: z.string().optional(),
    careerPageId: z.union([z.number(), z.string()]).optional(),
    careerPageName: z.string().optional(),
    careerPageLogo: z.string().optional(),
    careerPageUrl: z.string().optional(),
    type: z.string().optional(),
    publishedDate: z.string().optional(),
    applicationDeadline: z.string().nullable().optional(),
    isRemoteWork: z.boolean().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    jobUrl: z.string().optional(),
    workplaceType: z.string().optional(),
    disabilities: z.boolean().optional(),
    skills: z.array(z.unknown()).optional(),
    // Observed on some items and absent on others in the same response —
    // never assume presence.
    badges: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type GupyJob = z.infer<typeof GupyJobSchema>;

/**
 * Deliberately loose: only checks that `data` is an array. Individual items
 * are validated one at a time by the collector via `GupyJobSchema.safeParse`
 * so one malformed entry never invalidates the whole page (principle 1) —
 * a `z.array(GupyJobSchema)` at this level would fail the entire response on
 * a single bad item, which is not what "a broken source degrades gracefully"
 * is supposed to mean at the item level.
 */
export const GupyResponseEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()),
    pagination: z.unknown().optional(),
  })
  .passthrough();

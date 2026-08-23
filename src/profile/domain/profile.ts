import { z } from "zod";

/**
 * `config/profile.yaml` is the source of truth; the resume PDFs are
 * projections of it (CLAUDE.md §9). This schema is that source's shape.
 *
 * Distinct from `Track` in the scoring domain, which includes `unknown` as
 * the pre-filter's fallback for a posting it cannot classify — a profile
 * competency is never "unknown", it is tagged by whoever wrote the profile.
 *
 * `data` (ADR-061) exists here mainly so `criteria.tracks`
 * (`z.record(ProfileTrackSchema, ...)`, completeness-enforced) has
 * something to be complete *over* — no `profile.yaml` competency needs the
 * tag yet, since data-analyst postings are a lower-priority track scored
 * from title keywords alone (docs/04), not from any specific evidenced
 * skill. A competency genuinely specific to data work could still be
 * tagged this way later.
 */
export const ProfileTrackSchema = z.enum([
  "dev",
  "security",
  "automation",
  "data",
]);
export type ProfileTrack = z.infer<typeof ProfileTrackSchema>;

/**
 * Every competency carries at least one evidence entry — enforced here, not
 * merely documented, because a competency with no evidence produces
 * `not_met` in stage B regardless (evidence: null forces it, ADR-005): better
 * to fail loudly at load time than to silently deflate every score that
 * touches it.
 */
export const CompetencySchema = z.object({
  name: z.string().min(1),
  tracks: z.array(ProfileTrackSchema).min(1),
  aliases: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).min(1),
});
export type Competency = z.infer<typeof CompetencySchema>;

/**
 * A named subset of the profile — which tracks and competencies it
 * foregrounds. Holds no prose (docs/05-domain-model.md): a variant with its
 * own text would drift from the profile it is supposed to be a view over.
 * Competencies are referenced by name rather than duplicated.
 */
export const ResumeVariantSchema = z.object({
  id: z.string().min(1),
  tracks: z.array(ProfileTrackSchema).min(1),
  competencyNames: z.array(z.string().min(1)).min(1),
});
export type ResumeVariant = z.infer<typeof ResumeVariantSchema>;

/**
 * Literal placeholder for a field that is known to be unanswered
 * (CLAUDE.md §9 — English level, minimum stipend, maximum weekly hours).
 * Present and visible in the file rather than omitted, so opening
 * profile.yaml is enough to see what still needs an answer.
 */
export const UNVERIFIED = "⚠ VERIFY";

const ProfileBaseSchema = z.object({
  /**
   * The degree and institution, as a posting would name them. Required, not
   * optional: "cursando <course>" is the most common blocking requirement in
   * Brazilian internship postings, and stage B can only answer it from text
   * it is allowed to quote (ADR-005). Before these fields existed the answer
   * was always `not_met`, capping otherwise-viable postings at the blocking
   * score — see ADR-014.
   */
  courseName: z.string().min(1),
  institution: z.string().min(1),
  courseStart: z.coerce.date(),
  courseEnd: z.coerce.date(),
  englishLevel: z.string().min(1),
  minimumStipend: z.string().min(1),
  maxWeeklyHours: z.string().min(1),
  /**
   * Where and how the candidate can actually work — onsite/hybrid is
   * geography-bound, remote is not. `evidence-catalog.ts` renders this as
   * a quotable line the same way it does `maxWeeklyHours`; without it,
   * "disponibilidade para atuar em modelo híbrido ou remoto" (a common
   * mandatory requirement) had no evidence to cite and scored `not_met`
   * regardless of the true answer (docs/11-known-issues.md B9).
   */
  workAvailability: z.string().min(1),
  competencies: z.array(CompetencySchema).min(1),
  resumeVariants: z.array(ResumeVariantSchema).min(1),
});

/**
 * Cross-field checks beyond what per-field schemas can express: names must
 * be unique, and a resume variant must reference competencies that actually
 * exist. `path` on each issue is what lets the loader name the exact field
 * that is wrong rather than a generic "invalid profile".
 */
export const ProfileSchema = ProfileBaseSchema.superRefine((profile, ctx) => {
  const competencyNames = new Set<string>();
  profile.competencies.forEach((competency, index) => {
    if (competencyNames.has(competency.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["competencies", index, "name"],
        message: `Duplicate competency name: "${competency.name}"`,
      });
    }
    competencyNames.add(competency.name);
  });

  const variantIds = new Set<string>();
  profile.resumeVariants.forEach((variant, index) => {
    if (variantIds.has(variant.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["resumeVariants", index, "id"],
        message: `Duplicate resume variant id: "${variant.id}"`,
      });
    }
    variantIds.add(variant.id);

    variant.competencyNames.forEach((name, nameIndex) => {
      if (!competencyNames.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["resumeVariants", index, "competencyNames", nameIndex],
          message: `Resume variant "${variant.id}" references unknown competency "${name}"`,
        });
      }
    });
  });
});

export type Profile = z.infer<typeof ProfileBaseSchema>;

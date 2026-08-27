import { z } from "zod";

/**
 * Fitted to NerdIn's real detail-page `application/ld+json`
 * `schema.org/JobPosting`, captured with `npm run fixture:nerdin`
 * (ADR-071) — a real response, not a screenshot and not a guess, which is
 * the mistake `linkedin-alert-schema.ts` records paying for.
 *
 * Keys observed on every one of the four real postings sampled
 * 2026-08-27: `@context`, `@type`, `title`, `description`, `url`,
 * `directApply`, `hiringOrganization`, `applicantLocationRequirements`,
 * `identifier`, `datePosted`, `validThrough`, `employmentType`,
 * `jobLocation`, `occupationalCategory`, `industry`. `jobLocationType`
 * appears **only on remote postings** — see the normalizer.
 *
 * `id`, `jobUrl` and `isRemoteQuery` are **this project's own additions**
 * to the merged payload, not NerdIn's fields, and are named here so a
 * future reader does not mistake them for the source's own (the same note
 * `infojobs-schema.ts` carries).
 *
 * `.passthrough()` at every level, and only the two fields the normalizer
 * genuinely cannot work without are required — the same tolerance
 * discipline every source in this project follows.
 */

/** schema.org permits `addressCountry` as a bare string (`"BR"`) or a
 * nested `Country` object. Kept `unknown` and read by the normalizer, the
 * same treatment `infojobs-schema.ts` gives it. */
const PostalAddressSchema = z
  .object({
    addressLocality: z.string().nullable().optional(),
    addressRegion: z.string().nullable().optional(),
    addressCountry: z.unknown().nullable().optional(),
  })
  .passthrough();

const PlaceSchema = z
  .object({ address: PostalAddressSchema.nullable().optional() })
  .passthrough();

export const NerdinJobSchema = z
  .object({
    // Collector-added, from the listing href's trailing numeric id. NOT the
    // JSON-LD `identifier` — see the normalizer for why.
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    datePosted: z.string().nullable().optional(),
    validThrough: z.string().nullable().optional(),
    // Observed as `["FULL_TIME"]` on every sample — an ARRAY, where
    // schema.org also permits a bare string. Captured for `rawPayload`
    // only: `Posting` has no employment-type field, and `FULL_TIME` on an
    // internship must not be read as a seniority signal (seniority is
    // stage A's output, `posting.ts`).
    employmentType: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    // `"TELECOMMUTE"` on remote postings, absent otherwise. schema.org
    // permits an array here too, so the union is tolerance rather than an
    // observed shape.
    jobLocationType: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    // schema.org permits one `Place` or several; a multi-city posting would
    // use the array form. Declared tolerantly even though every sample was
    // a single object, because the object-only form would silently reject
    // the whole posting the first time an array appeared.
    jobLocation: z
      .union([PlaceSchema, z.array(PlaceSchema)])
      .nullable()
      .optional(),
    // `{ "@type": "Country", "name": "BR" }` on every sample — a second,
    // independent country signal the normalizer falls back to.
    applicantLocationRequirements: z.unknown().nullable().optional(),
    hiringOrganization: z
      .object({ name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    // `{ "@type": "PropertyValue", "name": "Nerdin", "value": "98190" }`.
    // Its `value` matched the href id on every sample, but it is captured
    // and never used as identity — see the normalizer.
    identifier: z.unknown().nullable().optional(),
    occupationalCategory: z.string().nullable().optional(),
    // Collector-added: the source's own detail URL, used as `sourceUrl`.
    jobUrl: z.string().nullable().optional(),
    // Collector-added: whether this posting came back from NerdIn's own
    // `vagas-home-office.php` facet. A fallback remote signal, kept even
    // though `jobLocationType` exists — see the normalizer.
    isRemoteQuery: z.boolean().optional(),
  })
  .passthrough();

export type NerdinJob = z.infer<typeof NerdinJobSchema>;

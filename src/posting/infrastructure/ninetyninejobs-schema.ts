import { z } from "zod";

/**
 * Stable payload produced by the collector from either 99jobs detail shape:
 * the legacy server-rendered JobPosting JSON-LD or the public browser API
 * used by company SPA portals. `upstream` preserves the original object for
 * later re-normalization without making its undocumented shape a contract.
 */
export const NinetyNineJobsJobSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    company: z.string().min(1),
    description: z.string().nullable().optional(),
    datePosted: z.string().nullable().optional(),
    validThrough: z.string().nullable().optional(),
    jobUrl: z.string().url(),
    city: z.string().nullable().optional(),
    country: z.unknown().nullable().optional(),
    workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
    upstream: z.unknown().optional(),
  })
  .passthrough();

export type NinetyNineJobsJob = z.infer<typeof NinetyNineJobsJobSchema>;

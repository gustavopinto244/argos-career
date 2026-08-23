import { z } from "zod";

/**
 * Originally fitted to a **screenshot** of an n8n workflow's extraction
 * table (ADR-029) — never a real request, which is exactly the gap
 * CLAUDE.md §15 warns about, and it cost real data: every real ingest
 * (docs/11-known-issues.md B15, three runs 2026-08-18 through 2026-08-23,
 * 33 postings) was silently discarded by this schema. `title`/`company`
 * were required lowercase; a real row the operator pasted 2026-08-23 had a
 * genuine title, company, location and link, so the field *values* were
 * never the problem — the read against ADR-029's own admission that the
 * real table also carries `Subject`/`ReceivedAt`/`ExtractedAt` (Title
 * Case) is that the required fields are very likely `Title`/`Company`
 * too, not the lowercase names a screenshot-derived guess used.
 *
 * **This is still not a literal raw-JSON capture** — the pasted evidence is
 * a rendered table row, not the HTTP Request node's exact body — so the
 * key-casing fix below is the best-supported hypothesis, not a confirmed
 * fact. `lowercaseKeys` makes the fix safe either way: real Title-Case
 * input and already-lowercase input (this schema's own existing fixture,
 * any hand-built caller) both validate identically. `unnormalizable_count`
 * (`src/cli/main.ts`'s `executeIngestExternal`) and this schema's own test
 * fixture were left deliberately non-updated in shape — see B15's
 * write-up for what would fully close this out.
 *
 * `.passthrough()`, matching every other source's tolerance discipline —
 * `Subject`, `ReceivedAt`, `ExtractedAt` from the real n8n table were
 * observed but are not part of this schema's required shape, since the
 * normalizer never reads them; a caller sending them is tolerated, not
 * required.
 *
 * **`location` is one bundled string** — `"Cidade, UF (Modo)"` or
 * `"Brasil (Modo)"` — carrying both place and work mode together, unlike
 * every other source's separate fields. The normalizer is what splits them
 * (ADR-029); this schema just requires the string exist.
 */
function lowercaseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const lowercased: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    lowercased[key.toLowerCase()] = entryValue;
  }
  return lowercased;
}

export const LinkedinAlertJobSchema = z.preprocess(
  lowercaseKeys,
  z
    .object({
      title: z.string().min(1),
      company: z.string().min(1),
      location: z.string().nullable().optional(),
      link: z.string().min(1).nullable().optional(),
    })
    .passthrough(),
);

export type LinkedinAlertJob = z.infer<typeof LinkedinAlertJobSchema>;

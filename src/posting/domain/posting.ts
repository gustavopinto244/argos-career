import { computeFingerprint } from "./fingerprint";

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

export type Location =
  | { readonly kind: "known"; readonly city: string }
  | { readonly kind: "unknown" };

export type Seniority = "internship" | "trainee" | "junior" | "mid" | "senior";

/**
 * The normalized domain entity. Every stage after normalization consumes
 * only this — never `RawPosting` (docs/05-domain-model.md).
 *
 * `seniority` and `experienceYears` are extracted during stage A (M7) and are
 * absent until then; they exist on the type now so scoring and the pre-filter
 * can be written against a stable shape instead of retrofitted later.
 */
export interface Posting {
  readonly source: string;
  readonly sourceId: string;
  readonly fingerprint: string;
  readonly company: string;
  readonly title: string;
  readonly location: Location;
  readonly workMode: WorkMode;
  readonly seniority: Seniority | null;
  readonly experienceYears: number | null;
  /** Null when the source did not state one — absence is not evidence the
   * posting never expires, and the pre-filter's expiry rule treats it as
   * such (M5): unknown, not automatically pass or fail. */
  readonly applicationDeadline: Date | null;
  /**
   * When the **source** published the posting, as distinct from
   * `firstSeenAt`, which is when *we* first observed it. The recency window
   * (ADR-019) needs the former: a posting published last month and first
   * collected today is old, and `firstSeenAt` cannot tell you that.
   *
   * Null when the source did not state one — and a null **passes** the
   * recency window rather than being discarded, the same leniency ADR-011
   * already applies to an unknown `location`/`workMode`: absence of a date
   * is not evidence of an old posting.
   */
  readonly publishedAt: Date | null;
  /** The posting's full text, when the source provides one. Null, not
   * empty string, when absent — stage A (M7) has nothing to extract
   * requirements from, which is different from a posting whose description
   * is genuinely blank. */
  readonly description: string | null;
  /** Null when the source did not provide a link. The digest (M6) treats a
   * posting with no link as undeliverable-without-a-fallback — see
   * `docs/02-architecture.md`'s "link is mandatory" rule. */
  readonly sourceUrl: string | null;
  /**
   * ISO 3166-1 alpha-2, uppercase (`"BR"`, `"US"`), or null when the source
   * states no country (ADR-068).
   *
   * Distinct from `location`, which is a city and answers "where is the
   * work". This answers "under whose jurisdiction is the hiring" — the axis
   * that decides whether an internship can be taken at all from Brazil, and
   * the one the scoring budget is split along: a national posting is
   * eligible by construction, an international one has to be *evaluated* to
   * find out, and that evaluation costs a model call.
   *
   * **Null is not "unknown country" in practice** — every source wired up
   * today is a Brazilian platform, so `criteria.sourceDefaultCountry` maps a
   * null from a known-Brazilian source to national. That is a property of
   * the source, the same reasoning `location.nationwideSources` already
   * uses, not a guess about the posting.
   *
   * Deliberately **not** part of the fingerprint (`computeFingerprint`):
   * identity is company+title+city (ADR-007), and adding a field to it would
   * re-collect the entire corpus as new.
   */
  readonly country: string | null;
  readonly collectedAt: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly rawPayload: unknown;
}

export type CreatePostingInput = {
  source: string;
  sourceId: string;
  company: string;
  title: string;
  location: Location;
  workMode: WorkMode;
  seniority?: Seniority | null;
  experienceYears?: number | null;
  applicationDeadline?: Date | null;
  publishedAt?: Date | null;
  description?: string | null;
  sourceUrl?: string | null;
  /** ISO 3166-1 alpha-2; case and surrounding space are normalized by
   * `createPosting`. Anything that is not two letters becomes null — see
   * `normalizeCountry`. */
  country?: string | null;
  collectedAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  rawPayload: unknown;
};

/**
 * `"br"`, `" BR "`, `"Br"` → `"BR"`. Anything else — a full country name, a
 * three-letter code, an empty string — → `null` (ADR-068).
 *
 * Rejecting rather than translating is the point. A normalizer that turned
 * `"Brazil"` into `"BR"` would need a name table, and the moment it met
 * `"Brasil"`, `"Brésil"` or a misspelling it would either grow indefinitely
 * or guess. `null` costs nothing here, because `sourceDefaultCountry`
 * already covers every source in production — CLAUDE.md §15: do not invent a
 * fact that can be checked.
 */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Enforces the invariants in docs/05-domain-model.md at construction:
 * company/title/source/sourceId non-empty, fingerprint derived and stable.
 *
 * Throws on violation. This is not a port boundary — ports return failure as
 * a value (docs/05), but a domain factory rejecting invalid input at
 * construction is ordinary validation, not a pipeline stage that principle 1
 * requires to survive.
 */
export function createPosting(input: CreatePostingInput): Posting {
  const source = input.source.trim();
  const sourceId = input.sourceId.trim();
  const company = input.company.trim();
  const title = input.title.trim();

  if (!source) throw new Error("Posting.source must not be empty");
  if (!sourceId) throw new Error("Posting.sourceId must not be empty");
  if (!company) throw new Error("Posting.company must not be empty");
  if (!title) throw new Error("Posting.title must not be empty");

  const city = input.location.kind === "known" ? input.location.city : "";

  return {
    source,
    sourceId,
    company,
    title,
    location: input.location,
    workMode: input.workMode,
    seniority: input.seniority ?? null,
    experienceYears: input.experienceYears ?? null,
    applicationDeadline: input.applicationDeadline ?? null,
    publishedAt: input.publishedAt ?? null,
    description: input.description ?? null,
    sourceUrl: input.sourceUrl ?? null,
    country: normalizeCountry(input.country),
    collectedAt: input.collectedAt,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    rawPayload: input.rawPayload,
    fingerprint: computeFingerprint(company, title, city),
  };
}

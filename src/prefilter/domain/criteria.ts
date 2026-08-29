import { z } from "zod";
import { ProfileTrackSchema } from "../../profile/domain/profile";

export const LocationCriteriaSchema = z.object({
  /** Case-insensitive city names the location rule accepts. */
  cities: z.array(z.string().min(1)).default([]),
  allowRemote: z.boolean().default(true),
  /**
   * Source names whose collector applies no server-side location filter at
   * all — it crawls nationwide and this system learns the city only if its
   * own client-side parsing succeeds (docs/audit AC-024). ADR-011's
   * leniency rule ("an unknown location cannot be ruled out, so it passes")
   * assumes the opposite: that the source already narrowed results to the
   * search profile's region — Gupy's server-side `city` param, or Sólides's
   * (every configured query in `criteria.yaml` sets one). Neither holds for
   * a source listed here — an unknown city from it is exactly as likely to
   * be Manaus as Rio de Janeiro, so `isLocationAllowed` rejects rather than
   * passes it. Defaults to `["catho", "ciee"]` (ADR-011 Amendment 7): Catho
   * crawls its entire national sitemap (ADR-032), and CIEE's own collector
   * sends no city parameter at all — `ciee-collector.ts`'s `buildUrl` only
   * ever sets `size`/`page` — deliberately, to give M10's market analysis a
   * national picture (ADR-021). Both learn geography only from client-side
   * parsing after the fact, exactly the situation this list exists for.
   */
  nationwideSources: z.array(z.string().min(1)).default(["catho", "ciee"]),
});

/**
 * Stage C's inputs (`src/scoring/domain/types.ts`'s `ScoringConfig`, minus
 * `trackWeights` — that lives at the top level of `Criteria` already, shared
 * with the pre-filter's track classification rather than duplicated here).
 */
export const ScoringConfigSchema = z.object({
  /**
   * Must sum to 100 (docs/audit AC-025) — `computeScore`'s formula
   * (`docs/04-scoring-model.md`) is `weights.mandatory * mandatoryCoverage +
   * weights.desirable * desirableCoverage + weights.trackAlignment *
   * trackAlignment`, and every coverage/alignment term is itself bounded to
   * [0, 1]. A score in the documented [0, 100] range is only guaranteed
   * when the three weights add up to exactly 100 — a typo like
   * `mandatory: 350` would otherwise produce a score over 100 with no
   * startup failure to catch it.
   */
  weights: z
    .object({
      mandatory: z.number().nonnegative(),
      desirable: z.number().nonnegative(),
      trackAlignment: z.number().nonnegative(),
    })
    .refine(
      (w) =>
        Math.abs(w.mandatory + w.desirable + w.trackAlignment - 100) < 1e-9,
      {
        message:
          "scoring.weights.mandatory + desirable + trackAlignment must sum to 100",
      },
    ),
  /**
   * `apply` must exceed `review` (docs/audit AC-025) — `computeVerdict`
   * reads them as a descending ladder (`score >= apply` before `score >=
   * review`); an inverted or equal pair would make the `apply` verdict
   * unreachable, or the two verdicts silently interchangeable, with no
   * error anywhere in the pipeline to say so.
   */
  thresholds: z
    .object({
      apply: z.number().min(0).max(100),
      review: z.number().min(0).max(100),
    })
    .refine((t) => t.apply > t.review, {
      message:
        "scoring.thresholds.apply must be greater than thresholds.review",
    }),
  minExtractedRequirements: z.number().int().nonnegative(),
  /** [0, 100] (docs/audit AC-025) — a cap outside the score's own valid
   * range cannot do its job: negative caps everything to a negative
   * score, and anything above 100 caps nothing a valid score could ever
   * reach anyway. */
  blockingCapScore: z.number().min(0).max(100),
  /**
   * Score ceiling when a posting matches no configured track (ADR-025).
   * `trackAlignment` alone caps out at 15% of the formula, which is not
   * enough to stop a generic, easy-to-satisfy posting — customer service,
   * HR, sales — from scoring near the top on coverage alone. Required, not
   * defaulted: this changes real scoring output for real postings, and a
   * criteria file predating it should fail validation rather than silently
   * keep producing the inflated scores this exists to fix.
   */
  unknownTrackCapScore: z.number().min(0).max(100),
  /**
   * How many stage B requirement calls may be in flight at once (ADR-022).
   * Defaulted, not required, so a criteria file written before this existed
   * keeps working — the same backward-compatibility discipline the rest of
   * this schema uses.
   *
   * Not a Stage C input, unlike everything above it: this changes how long
   * scoring takes and nothing about what it produces. It lives here because
   * it is an operational dial that must be turnable without a deploy, which
   * is what `config/criteria.yaml` is for.
   */
  stageBConcurrency: z.number().int().positive().default(8),
  /**
   * OpenRouter provider slugs never to route this model's calls to
   * (ADR-056), sent as `provider.ignore` on every request.
   *
   * ADR-013 pinned the *model* so results stay comparable across runs. It
   * did not pin what sits underneath it: OpenRouter serves this model from
   * 30 different providers and picks one per request, so "same model, same
   * prompt" can still mean two materially different systems — the exact
   * silent violation of the M7 protocol's "change one variable at a time"
   * that `docs/11-known-issues.md` B11 measured.
   *
   * An exclusion list rather than an allowlist, and configuration rather
   * than code, for the same reason `blockedCompanies` and
   * `trackExclusions` are: entries are added when a provider is *observed*
   * failing against this project's own corpus, and adding the next one must
   * not require a deploy (principle 3, docs/09). `require_parameters` is
   * deliberately not used instead — measured useless here, because a broken
   * provider can advertise full parameter support and still ignore it.
   *
   * Defaulted to empty so a criteria file written before this existed stays
   * valid, the same backward-compatibility discipline the rest of this
   * schema uses.
   */
  ignoredProviders: z.array(z.string().min(1)).default([]),
});

/**
 * One query issued to a collector. Mirrors the subset of
 * `GupyCollectorCriteria` that is a *search decision* rather than a
 * transport detail — `pageSize`, timeouts and backoff stay in the adapter.
 */
export const CollectionQuerySchema = z.object({
  /**
   * Which collector answers this query (`src/posting/infrastructure/
   * collector-registry.ts`). Defaults to `gupy` so a criteria file written
   * before a second source existed keeps meaning exactly what it meant —
   * the same backward-compatibility discipline the rest of this schema uses.
   */
  source: z.string().min(1).default("gupy"),
  jobName: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  isRemoteWork: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  /**
   * Source-specific vacancy-type filter — Gupy's own `type` query
   * parameter (`GupyCollectorCriteriaSchema`, e.g.
   * `vacancy_type_internship`). Without this field `CollectionQuerySchema`
   * silently stripped it (plain `z.object` drops unrecognized keys rather
   * than erroring), so a `type:` line in `criteria.yaml` parsed
   * successfully and then never reached the collector at all — found while
   * adding it in the first place (2026-08-23).
   */
  type: z.string().min(1).optional(),
});

/**
 * What the scheduled collection cycle actually asks the source for
 * (principle 3: search strategy is data, not code).
 *
 * Before this existed the cron called `executeCollect(db, collector, {})` —
 * an empty query — and Gupy answered with whatever it liked: 380 mostly-São
 * Paulo senior roles, of which the pre-filter correctly discarded 95%. The
 * fix is not a looser filter, it is asking a better question. ADR-011
 * already predicted this: "most of what the pre-filter cuts is geography,
 * and geography is cheaper to filter at the source than after downloading
 * it."
 *
 * Defaulted to a single empty query so a criteria file written before this
 * section existed stays valid and behaves exactly as it did — same
 * discipline as `trackExclusions`, `schedule` and `alerts`.
 */
export const CollectionSchema = z.object({
  queries: z.array(CollectionQuerySchema).min(1),
  /**
   * Pause between consecutive queries in one cycle. The collector's own
   * ~1.5 s interval only applies *between pages of a single query*, so
   * without this a multi-query cycle would fire back-to-back requests at
   * each query boundary — exactly the impolite behaviour CLAUDE.md §6
   * forbids ("a discreet collector is a collector that keeps working").
   */
  queryIntervalMs: z.number().int().nonnegative().default(1_500),
  /**
   * Only keep postings the source published within this many days
   * (ADR-019). Collection runs every few hours, so a one-day window is
   * already generous overlap — anything older has been seen by a previous
   * cycle, or was never going to be seen at all.
   *
   * A posting whose source states no publication date **passes**: absence
   * of a date is not evidence of an old posting, the same leniency ADR-011
   * applies to an unknown `location`/`workMode`.
   */
  recencyDays: z.number().positive().default(1),
  /**
   * The window used when there is no successful `collect` run on record —
   * a first run on an empty database has no previous cycle to have caught
   * the last week, so it reaches back further exactly once.
   */
  backfillDays: z.number().positive().default(7),
});

/**
 * `config/criteria.yaml`'s shape (docs/09-configuration.md). Committed, not
 * gitignored — criteria are neither secret nor personal, and committing them
 * is what makes "why did I stop seeing infra postings?" answerable with
 * `git log` (principle 3).
 *
 * `tracks` requires an entry for every `ProfileTrack` (Zod's record-over-an-
 * enum enforces completeness) — a track silently missing its keyword list
 * would classify every one of its postings as `unknown`, which is exactly
 * the kind of empty-filter-that-silently-passes-everything principle 3
 * warns against.
 */
export const CriteriaSchema = z.object({
  collection: CollectionSchema.default({
    queries: [{ source: "gupy" }],
    queryIntervalMs: 1_500,
    recencyDays: 1,
    backfillDays: 7,
  }),
  titleBlocklist: z.array(z.string().min(1)).default([]),
  titleRequired: z.array(z.string().min(1)).min(1),
  location: LocationCriteriaSchema,
  blockedCompanies: z.array(z.string().min(1)).default([]),
  /** Minimum count of profile keywords that must appear in a posting's text
   * before it is worth LLM budget. */
  minKeywordAdherence: z.number().int().nonnegative().default(0),
  /**
   * Reject a posting older than this many days before it reaches the LLM.
   * `null` (the default) disables the rule entirely, so a criteria file
   * written before this existed keeps meaning what it meant.
   *
   * Distinct from `collection.recencyDays`, which drops postings at
   * *collection* time and never lets them into the corpus. This one runs in
   * the pre-filter, so the posting is still stored, still counted by M10's
   * market analysis, and still available if the window is later widened — it
   * is only excluded from the expensive part. ADR-019's window answers "what
   * is worth keeping"; this answers "what is worth paying to score".
   */
  maxAgeDays: z.number().int().positive().nullable().default(null),
  /**
   * Business rule (ADR-011 Amendment 5): a posting with no `publishedAt`,
   * first seen at or before this instant, is presumed already past
   * `maxAgeDays` — unconditionally, regardless of the actual gap between
   * `firstSeenAt` and now. `null` (the default) disables the rule.
   *
   * This does **not** backdate `firstSeenAt` itself — that field stays an
   * honest record of when this system actually observed a posting
   * (`docs/05-domain-model.md`), and a fabricated value would corrupt any
   * later reader of it, M10's market analysis included. The cutover is a
   * separate, explicit policy line instead: everything undated collected up
   * to this point is presumed stale; anything undated collected *after* it
   * — "entering" postings, from ongoing collection — gets the normal
   * `maxAgeDays` grace period via `firstSeenAt`, same as before.
   *
   * Meant to be set once, to "now" at the moment this policy is adopted, and
   * left in place — it is a permanent dividing line between "the backlog
   * this rule was written to clear" and everything collected afterward, not
   * a value that needs updating over time.
   */
  undatedBacklogCutoverAt: z.coerce.date().nullable().default(null),
  /**
   * How recently the source must have still been listing a posting for that
   * to override the age rules above (ADR-066). `lastSeenAt` within this
   * window is direct evidence the posting is still being advertised, which
   * outranks `publishedAt`/`firstSeenAt` estimates of when it appeared.
   *
   * Must comfortably exceed the slowest source's collection interval, or a
   * posting that is still listed reads as gone purely because its source has
   * not been swept since. Used only to rescue a posting from `too_old`,
   * never to reject one — see `isStillListedBySource`.
   *
   * `null` (the default) disables it, restoring the pre-ADR-066 behaviour.
   */
  stillListedWithinHours: z.number().positive().nullable().default(null),
  /**
   * Absolute ceiling on the ADR-066 rescue (Amendment 1): a posting past this
   * age is `too_old` even when `lastSeenAt` says the source is still listing
   * it. ADR-066 shipped with no ceiling, deliberately, pending a measurement
   * of whether zombies (old-but-still-listed postings) turned out to be
   * common; they did — the real corpus carries still-listed postings up to
   * 424 days old, almost all off-track already, but a handful of genuine
   * on-track ones ride the tail past 45 days too. `null` (the default)
   * disables the ceiling and keeps the original unbounded rescue.
   *
   * Age is measured the same way `maxAgeDays` measures it — `publishedAt`
   * when stated, `firstSeenAt` otherwise — so the ceiling and the rule it
   * bounds agree on what "age" means.
   */
  stillListedMaxAgeDays: z.number().positive().nullable().default(null),
  /**
   * The country a source's postings belong to when the posting itself states
   * none — ISO 3166-1 alpha-2, keyed by source name (ADR-068).
   *
   * Every source wired up today is a Brazilian platform, and most state no
   * country at all, so without this every existing posting would read as
   * "unknown nationality" and fall into the capped international bucket —
   * inverting the priority this exists to express.
   *
   * A property of the **source**, not a guess about the posting, which is
   * the same standing `location.nationwideSources` already has. A source
   * absent from this map and a posting with no country stay unknown, and
   * `isNationalPosting` treats unknown as international — the conservative
   * direction, since an unknown posting then competes for the capped budget
   * instead of consuming the uncapped one.
   */
  sourceDefaultCountry: z.record(z.string(), z.string()).default({}),
  /**
   * The country the profile can actually be hired in. Postings from here are
   * "national" and are scored without a cap; everything else is capped
   * (ADR-068).
   */
  homeCountry: z.string().default("BR"),
  /**
   * How many international postings a single scoring run may spend model
   * calls on. National postings are never capped — see ADR-068 for why the
   * asymmetry is the whole point. `null` disables the cap entirely.
   */
  maxInternationalPerRun: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null),
  /**
   * How far into the future a source's `publishedAt` is still trusted
   * (docs/audit AC-029). A source reporting `publishedAt` beyond this
   * window — clock skew, a `date_posted` format a normalizer misparses, or
   * an outright bad value like the year 2099 — is not evidence the posting
   * is fresh; it is evidence the date is wrong. `isTooOld` falls back to
   * `firstSeenAt` in that case, the same conservative fallback already used
   * for a missing `publishedAt` (see `isTooOld`'s own comment), rather than
   * letting an implausible future date produce a negative age that always
   * passes the recency check regardless of how old the posting actually is.
   *
   * Generous by default: 1 day covers ordinary timezone differences between
   * a source's server and this system without flagging normal same-day
   * postings as suspicious.
   */
  maxFutureSkewDays: z.number().nonnegative().default(1),
  tracks: z.record(ProfileTrackSchema, z.array(z.string().min(1))),
  /**
   * Phrases that veto a track even when one of its keywords matched
   * (ADR-015). Portuguese job titles overload exactly the two words this
   * project cares most about: "desenvolvimento" is packaging, product,
   * people or business development far more often than software, and
   * "segurança do trabalho" is occupational safety, a different profession
   * from information security. Both scored 1.0 track alignment on postings
   * hand-labelled 0.
   *
   * Optional and defaulted so an existing criteria file stays valid.
   */
  trackExclusions: z
    .object({
      dev: z.array(z.string().min(1)).default([]),
      security: z.array(z.string().min(1)).default([]),
      automation: z.array(z.string().min(1)).default([]),
      data: z.array(z.string().min(1)).default([]),
    })
    .default({ dev: [], security: [], automation: [], data: [] }),
  /**
   * Reject a posting pre-LLM when `classifyTrack` matches none of `tracks`
   * (ADR-051). Defaulted `false` so a criteria file predating this stays
   * valid and behaves exactly as it did — same discipline as
   * `trackExclusions`.
   *
   * Before this existed, an unknown-track posting still passed the
   * pre-filter and was scored: `unknownTrackCapScore` (ADR-025) stopped it
   * from ever reaching `apply`, but did not stop it from spending Stage
   * A/B budget or from cluttering the "review" section when scoring
   * failed. Measured on the 2026-08-17 calibration run: of 28 postings
   * that passed the pre-filter, all 28 classified `unknown` — none matched
   * `dev`, `security` or `automation` — and the delivered digest was
   * Segurança do Trabalho, Jurídico, RH, Marketing, Contabilidade, Design,
   * Fisioterapia and similar, not a single genuine backend/security/infra
   * posting among them.
   */
  rejectUnknownTrack: z.boolean().default(false),
  /**
   * Each in [0, 1] (docs/audit AC-025) — `computeTrackAlignment` takes the
   * max of the matched tracks' weights and multiplies it by
   * `scoring.weights.trackAlignment`'s share of the 100-point total, so a
   * weight outside [0, 1] would let this one term alone push the score
   * above 100 or below 0 regardless of every other term.
   */
  trackWeights: z.object({
    dev: z.number().min(0).max(1),
    security: z.number().min(0).max(1),
    automation: z.number().min(0).max(1),
    data: z.number().min(0).max(1),
    unknown: z.number().min(0).max(1),
  }),
  scoring: ScoringConfigSchema,
  /**
   * ADR-009's two independent crons, as configuration (docs/09) — a strategy
   * change ("run collection every 2h instead of 4") is a config edit, not a
   * code change. Defaulted to ADR-009's own defaults so an existing criteria
   * file without this section stays valid, same discipline as
   * `trackExclusions`.
   */
  schedule: z
    .object({
      collection: z
        .object({
          intervalHours: z.number().positive().default(4),
        })
        .default({ intervalHours: 4 }),
      scoreAndDeliver: z
        .object({
          // HH:mm, 24h. Validated as a string shape here; the scheduler
          // infrastructure is what turns it into a cron expression.
          time: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm, 24h")
            .default("03:00"),
          timezone: z.string().min(1).default("America/Sao_Paulo"),
        })
        .default({ time: "03:00", timezone: "America/Sao_Paulo" }),
    })
    .default({
      collection: { intervalHours: 4 },
      scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    }),
  /**
   * docs/08-observability.md's alert thresholds. `consecutiveEmptyCollectionRuns`
   * is tolerant (collection runs every few hours per `schedule.collection`,
   * so one empty cycle is routine); a missed `scoreAndDeliver` run has no
   * threshold here because it alerts on the first miss, unconditionally —
   * there is no "tolerance" for a day with no digest.
   */
  alerts: z
    .object({
      consecutiveEmptyCollectionRuns: z.number().int().positive().default(2),
      scoreFailureRateThreshold: z.number().min(0).max(1).default(0.5),
      /**
       * Per-source freshness, in hours: how long a source may go without a
       * single posting being seen before that counts as a failure
       * (docs/11-known-issues.md B13).
       *
       * This exists because every other health signal is blind to it. A
       * push-based external collector (ADR-027 — Indeed, Catho, LinkedIn)
       * never appears in `runs.attempted_sources`, so a `collect` run says
       * `success` whether that source delivered everything or nothing at
       * all. Indeed went six days contributing zero postings while every
       * run row, `evaluateCollectionHealth` and the missed-run alert
       * reported green, because the pulled sources really were healthy.
       *
       * Keyed by source with no default entries: a source only gets a
       * freshness expectation once someone states what "fresh" means for
       * it, and an unlisted source is simply not checked. That keeps a new
       * or deliberately dormant collector from alerting before anyone has
       * decided how often it should deliver.
       */
      sourceFreshnessHours: z
        .record(z.string(), z.number().positive())
        .default({}),
    })
    .default({
      consecutiveEmptyCollectionRuns: 2,
      scoreFailureRateThreshold: 0.5,
      sourceFreshnessHours: {},
    }),
});

export type Criteria = z.infer<typeof CriteriaSchema>;
export type CollectionQuery = z.infer<typeof CollectionQuerySchema>;
export type LocationCriteria = z.infer<typeof LocationCriteriaSchema>;
export type ScoringConfigCriteria = z.infer<typeof ScoringConfigSchema>;

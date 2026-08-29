import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { applyPreFilter } from "../../../src/prefilter/domain/pre-filter";
import { Criteria } from "../../../src/prefilter/domain/criteria";

const NOW = new Date("2026-08-14T03:00:00Z");

function baseCriteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    collection: {
      queries: [{ source: "gupy" }],
      queryIntervalMs: 0,
      recencyDays: 1,
      backfillDays: 7,
    },
    titleBlocklist: ["sênior", "pleno", "especialista"],
    titleRequired: ["estágio", "estagiário", "intern", "trainee"],
    location: {
      cities: ["Rio de Janeiro", "Niterói"],
      allowRemote: true,
      nationwideSources: [],
    },
    blockedCompanies: ["Empresa Bloqueada"],
    minKeywordAdherence: 0,
    maxAgeDays: null,
    undatedBacklogCutoverAt: null,
    stillListedWithinHours: null,
    stillListedMaxAgeDays: null,
    sourceDefaultCountry: {},
    homeCountry: "BR",
    maxInternationalPerRun: null,
    maxFutureSkewDays: 1,
    tracks: {
      dev: ["backend", "node"],
      security: ["segurança"],
      automation: ["automação"],
      data: [],
    },
    trackExclusions: { dev: [], security: [], automation: [], data: [] },
    rejectUnknownTrack: false,
    schedule: {
      collection: { intervalHours: 4 },
      scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
    },
    alerts: {
      consecutiveEmptyCollectionRuns: 2,
      scoreFailureRateThreshold: 0.5,
      sourceFreshnessHours: {},
    },
    trackWeights: {
      dev: 1.0,
      security: 1.0,
      automation: 0.7,
      data: 0.7,
      unknown: 0.4,
    },
    scoring: {
      weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
      thresholds: { apply: 70, review: 45 },
      minExtractedRequirements: 1,
      blockingCapScore: 35,
      unknownTrackCapScore: 50,
      stageBConcurrency: 8,
      ignoredProviders: [],
    },
    ...overrides,
  };
}

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

describe("applyPreFilter — title blocklist", () => {
  it("rejects a title containing a blocked term", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio Sênior em Backend" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome).toMatchObject({ passed: false, reason: "title_blocked" });
  });

  it("is case- and accent-insensitive", () => {
    const outcome = applyPreFilter(
      posting({ title: "ESTAGIO SENIOR EM BACKEND" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("title_blocked");
  });
});

describe("applyPreFilter — title required", () => {
  it("rejects a title with none of the required terms", () => {
    const outcome = applyPreFilter(
      posting({ title: "Analista de Backend Pleno" }),
      baseCriteria({ titleBlocklist: [] }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("title_missing_required_term");
  });

  it("passes when any one required term is present", () => {
    const outcome = applyPreFilter(
      posting({ title: "Trainee de Backend" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — blocked companies", () => {
  it("rejects a posting from a blocked company", () => {
    const outcome = applyPreFilter(
      posting({ company: "Empresa Bloqueada" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("company_blocked");
  });

  it("matches case- and accent-insensitively", () => {
    const outcome = applyPreFilter(
      posting({ company: "empresa bloqueada" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("company_blocked");
  });
});

describe("applyPreFilter — expired", () => {
  it("rejects a posting whose deadline has passed", () => {
    const outcome = applyPreFilter(
      posting({ applicationDeadline: new Date("2026-01-01T00:00:00Z") }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("expired");
  });

  it("passes a posting whose deadline is in the future", () => {
    const outcome = applyPreFilter(
      posting({ applicationDeadline: new Date("2026-12-01T00:00:00Z") }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("does not reject a posting with no stated deadline — unknown, not expired", () => {
    const outcome = applyPreFilter(
      posting({ applicationDeadline: null }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — maxAgeDays (age limit)", () => {
  it("does nothing when maxAgeDays is null (the default)", () => {
    const outcome = applyPreFilter(
      posting({
        publishedAt: new Date("2020-01-01T00:00:00Z"),
        firstSeenAt: new Date("2020-01-01T00:00:00Z"),
      }),
      baseCriteria({ maxAgeDays: null }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects a posting older than the limit by publishedAt", () => {
    const outcome = applyPreFilter(
      posting({ publishedAt: new Date("2026-08-01T00:00:00Z") }), // 13 days before NOW
      baseCriteria({ maxAgeDays: 7 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("passes a posting within the limit by publishedAt", () => {
    const outcome = applyPreFilter(
      posting({ publishedAt: new Date("2026-08-10T00:00:00Z") }), // 4 days before NOW
      baseCriteria({ maxAgeDays: 7 }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("falls back to firstSeenAt when publishedAt is absent — CIEE's usual case", () => {
    const outcome = applyPreFilter(
      posting({
        publishedAt: null,
        firstSeenAt: new Date("2026-08-01T00:00:00Z"), // 13 days before NOW
      }),
      baseCriteria({ maxAgeDays: 7 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("prefers publishedAt over firstSeenAt when both are present", () => {
    // A posting collected recently but published long ago is old; the
    // opposite (published recently, collected late) should not happen in
    // practice, but publishedAt is still the stronger claim when it exists.
    const outcome = applyPreFilter(
      posting({
        publishedAt: new Date("2026-08-01T00:00:00Z"), // 13 days before NOW
        firstSeenAt: NOW,
      }),
      baseCriteria({ maxAgeDays: 7 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("is checked after expired, so a closed posting reports as expired", () => {
    const outcome = applyPreFilter(
      posting({
        applicationDeadline: new Date("2026-01-01T00:00:00Z"),
        publishedAt: new Date("2026-08-01T00:00:00Z"),
      }),
      baseCriteria({ maxAgeDays: 7 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("expired");
  });
});

describe("applyPreFilter — maxFutureSkewDays (docs/audit AC-029)", () => {
  it("passes a publishedAt within the future-skew tolerance", () => {
    const outcome = applyPreFilter(
      posting({ publishedAt: new Date("2026-08-14T12:00:00Z") }), // 9h after NOW
      baseCriteria({ maxAgeDays: 7, maxFutureSkewDays: 1 }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("does not let an implausibly future publishedAt grant indefinite freshness", () => {
    // Without the AC-029 fix, a publishedAt this far in the future makes
    // ageMs negative, which always passes maxAgeDays regardless of how old
    // the posting actually is (e.g. a stale firstSeenAt).
    const outcome = applyPreFilter(
      posting({
        publishedAt: new Date("2099-01-01T00:00:00Z"),
        firstSeenAt: new Date("2026-08-01T00:00:00Z"), // 13 days before NOW
      }),
      baseCriteria({ maxAgeDays: 7, maxFutureSkewDays: 1 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
    expect(outcome.anomalies).toEqual(["published_at_future"]);
  });

  it("falls back to a fresh firstSeenAt when publishedAt is implausibly future, so it still passes", () => {
    const outcome = applyPreFilter(
      posting({
        publishedAt: new Date("2099-01-01T00:00:00Z"),
        firstSeenAt: NOW,
      }),
      baseCriteria({ maxAgeDays: 7, maxFutureSkewDays: 1 }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.anomalies).toEqual(["published_at_future"]);
  });
});

describe("applyPreFilter — stillListedWithinHours (ADR-066)", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const old = (days: number) => new Date(NOW.getTime() - days * DAY);
  const seenAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

  it("does nothing when null (the default) — a stale posting is still too_old", () => {
    const outcome = applyPreFilter(
      posting({ publishedAt: old(21), firstSeenAt: old(21), lastSeenAt: NOW }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: null }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("rescues a posting the source was still listing, however old its publishedAt", () => {
    // The real case: "Estágio em TI" (BHG, Rio) — published 21 days ago,
    // still returned by Indeed 7 hours before this measurement.
    const outcome = applyPreFilter(
      posting({
        publishedAt: old(21),
        firstSeenAt: old(3),
        lastSeenAt: seenAgo(7),
      }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: 30 }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("still rejects a posting that has vanished from its source", () => {
    // The 18 of 26 the age rule should keep catching: old *and* gone.
    const outcome = applyPreFilter(
      posting({
        publishedAt: old(21),
        firstSeenAt: old(21),
        lastSeenAt: seenAgo(96),
      }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: 30 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("outranks undatedBacklogCutoverAt — a posting served up today is not backlog", () => {
    // The two CIEE "Estágio em Informática" rows: first seen 8 hours before
    // the cutover instant, still advertised ten days later.
    const CUTOVER = new Date(NOW.getTime() - 10 * DAY);
    const outcome = applyPreFilter(
      posting({
        publishedAt: null,
        firstSeenAt: new Date(CUTOVER.getTime() - 8 * HOUR),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        undatedBacklogCutoverAt: CUTOVER,
        stillListedWithinHours: 30,
      }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("treats the window as inclusive at its exact boundary", () => {
    const at = applyPreFilter(
      posting({
        publishedAt: old(21),
        firstSeenAt: old(21),
        lastSeenAt: seenAgo(30),
      }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: 30 }),
      [],
      NOW,
    );
    expect(at.passed).toBe(true);

    const justPast = applyPreFilter(
      posting({
        publishedAt: old(21),
        firstSeenAt: old(21),
        lastSeenAt: new Date(NOW.getTime() - 30 * HOUR - 1),
      }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: 30 }),
      [],
      NOW,
    );
    expect(justPast.reason).toBe("too_old");
  });

  it("does not let a future lastSeenAt rescue anything — that is clock skew", () => {
    const outcome = applyPreFilter(
      posting({
        publishedAt: old(21),
        firstSeenAt: old(21),
        lastSeenAt: new Date(NOW.getTime() + 5 * DAY),
      }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: 30 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("rescues from too_old only — it does not override any other rule", () => {
    // A still-listed posting outside the allowed region is still rejected:
    // this evidence speaks to whether a posting is open, nothing else.
    const outcome = applyPreFilter(
      posting({
        title: "Estágio em Desenvolvimento Backend",
        location: { kind: "known", city: "Fortaleza" },
        workMode: "onsite",
        publishedAt: old(21),
        firstSeenAt: old(21),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({ maxAgeDays: 7, stillListedWithinHours: 30 }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });
});

describe("applyPreFilter — stillListedMaxAgeDays (ADR-066 Amendment 1)", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const old = (days: number) => new Date(NOW.getTime() - days * DAY);
  const seenAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

  it("does nothing when null (the default) — the rescue stays unbounded", () => {
    // The real 424-day-old zombie, with no ceiling set.
    const outcome = applyPreFilter(
      posting({
        publishedAt: old(424),
        firstSeenAt: old(424),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        stillListedWithinHours: 30,
        stillListedMaxAgeDays: null,
      }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("still rescues a posting inside the ceiling", () => {
    // The real on-track case: "Estagiário(a) de Tecnologia da Informação"
    // (Indeed, Méier-RJ), 71 days old and still listed.
    const outcome = applyPreFilter(
      posting({
        publishedAt: old(71),
        firstSeenAt: old(71),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        stillListedWithinHours: 30,
        stillListedMaxAgeDays: 90,
      }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("stops rescuing once the posting is older than the ceiling", () => {
    const outcome = applyPreFilter(
      posting({
        publishedAt: old(120),
        firstSeenAt: old(120),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        stillListedWithinHours: 30,
        stillListedMaxAgeDays: 90,
      }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("treats the ceiling as inclusive at its exact boundary", () => {
    const at = applyPreFilter(
      posting({
        publishedAt: old(90),
        firstSeenAt: old(90),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        stillListedWithinHours: 30,
        stillListedMaxAgeDays: 90,
      }),
      [],
      NOW,
    );
    expect(at.passed).toBe(true);

    const justPast = applyPreFilter(
      posting({
        publishedAt: new Date(old(90).getTime() - 1),
        firstSeenAt: new Date(old(90).getTime() - 1),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        stillListedWithinHours: 30,
        stillListedMaxAgeDays: 90,
      }),
      [],
      NOW,
    );
    expect(justPast.reason).toBe("too_old");
  });

  it("still falls through to undatedBacklogCutoverAt once past the ceiling", () => {
    // Past the ceiling, the rescue no longer applies and the older,
    // stricter rule (an undated posting from before the cutover) governs.
    const CUTOVER = new Date(NOW.getTime() - 200 * DAY);
    const outcome = applyPreFilter(
      posting({
        publishedAt: null,
        firstSeenAt: old(300),
        lastSeenAt: seenAgo(1),
      }),
      baseCriteria({
        maxAgeDays: 7,
        undatedBacklogCutoverAt: CUTOVER,
        stillListedWithinHours: 30,
        stillListedMaxAgeDays: 90,
      }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("too_old");
  });
});

describe("applyPreFilter — undatedBacklogCutoverAt (ADR-011 Amendment 5)", () => {
  const CUTOVER = new Date("2026-08-16T12:00:00Z");

  it("does nothing when the cutover is null (the default)", () => {
    const outcome = applyPreFilter(
      posting({ publishedAt: null, firstSeenAt: NOW }), // just seen, no date
      baseCriteria({ maxAgeDays: 7, undatedBacklogCutoverAt: null }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects an undated posting first seen at or before the cutover, regardless of actual age", () => {
    const outcome = applyPreFilter(
      // firstSeenAt equals the cutover exactly and NOW is the same instant —
      // by real elapsed time this posting is 0 days old, not 7.
      posting({ publishedAt: null, firstSeenAt: CUTOVER }),
      baseCriteria({ maxAgeDays: 7, undatedBacklogCutoverAt: CUTOVER }),
      [],
      CUTOVER,
    );
    expect(outcome.reason).toBe("too_old");
  });

  it("does not reject an undated posting first seen after the cutover — it is 'entering', not backlog", () => {
    const outcome = applyPreFilter(
      posting({
        publishedAt: null,
        firstSeenAt: new Date(CUTOVER.getTime() + 1000), // one second after
      }),
      baseCriteria({ maxAgeDays: 7, undatedBacklogCutoverAt: CUTOVER }),
      [],
      new Date(CUTOVER.getTime() + 1000),
    );
    expect(outcome.passed).toBe(true);
  });

  it("does not apply to a posting that does have a publishedAt, even before the cutover", () => {
    // A dated posting's freshness is a measured fact, not a presumption —
    // the cutover exists specifically for the undated case.
    const outcome = applyPreFilter(
      posting({
        publishedAt: new Date(CUTOVER.getTime() - 1000),
        firstSeenAt: new Date(CUTOVER.getTime() - 1000),
      }),
      baseCriteria({ maxAgeDays: 7, undatedBacklogCutoverAt: CUTOVER }),
      [],
      CUTOVER,
    );
    expect(outcome.passed).toBe(true);
  });

  it("never mutates firstSeenAt — the posting's own record is untouched", () => {
    const original = posting({ publishedAt: null, firstSeenAt: CUTOVER });
    const before = original.firstSeenAt.getTime();

    applyPreFilter(
      original,
      baseCriteria({ maxAgeDays: 7, undatedBacklogCutoverAt: CUTOVER }),
      [],
      CUTOVER,
    );

    expect(original.firstSeenAt.getTime()).toBe(before);
  });
});

describe("applyPreFilter — location and workMode", () => {
  it("passes a posting in an allowed city", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "Niterói" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects a posting on-site in a city that is not allowed", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("passes a remote posting regardless of city, when remote is allowed", () => {
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "São Paulo" },
        workMode: "remote",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("passes an unknown location from an ordinary source — cannot be ruled out", () => {
    const outcome = applyPreFilter(
      posting({ location: { kind: "unknown" }, workMode: "onsite" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects an unknown location from a nationwide-crawl source (docs/audit AC-024)", () => {
    const outcome = applyPreFilter(
      posting({
        source: "catho",
        location: { kind: "unknown" },
        workMode: "onsite",
      }),
      baseCriteria({
        location: {
          cities: ["Rio de Janeiro", "Niterói"],
          allowRemote: true,
          nationwideSources: ["catho"],
        },
      }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("rejects an unknown location from CIEE, a full-board crawl with no server-side location filter (docs/audit PR-016, ADR-011 Amendment 7)", () => {
    const outcome = applyPreFilter(
      posting({
        source: "ciee",
        location: { kind: "unknown" },
        workMode: "unknown",
      }),
      baseCriteria({
        location: {
          cities: ["Rio de Janeiro", "Niterói"],
          allowRemote: true,
          nationwideSources: ["catho", "ciee"],
        },
      }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("still passes a known, in-region city from a nationwide-crawl source", () => {
    const outcome = applyPreFilter(
      posting({
        source: "catho",
        location: { kind: "known", city: "Niterói" },
        workMode: "onsite",
      }),
      baseCriteria({
        location: {
          cities: ["Rio de Janeiro", "Niterói"],
          allowRemote: true,
          nationwideSources: ["catho"],
        },
      }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects a remote posting when remote is not allowed by criteria", () => {
    const outcome = applyPreFilter(
      posting({ workMode: "remote" }),
      baseCriteria({
        location: {
          cities: ["Rio de Janeiro"],
          allowRemote: false,
          nationwideSources: [],
        },
      }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("rejects an unknown workMode when the city is known and disallowed (ADR-011 Amendment 3)", () => {
    // This asserted the opposite until 2026-08-16. The symmetric rule was
    // written when Gupy was the only source and usually stated workMode;
    // CIEE never states it, so every São Paulo posting passed on the theory
    // that it "cannot be ruled out as remote" — 1,700 of them, measured.
    // Absence of evidence about how the work happens does not outweigh
    // positive evidence about where it happens.
    const outcome = applyPreFilter(
      posting({
        location: { kind: "known", city: "São Paulo" },
        workMode: "unknown",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toBe("location_not_allowed");
  });

  it("still passes an unknown LOCATION — that leniency is unchanged", () => {
    // The asymmetry is the point: an unknown place cannot be ruled out as
    // being in the target region, so it still passes.
    const outcome = applyPreFilter(
      posting({ location: { kind: "unknown" }, workMode: "unknown" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("does not reject an unknown location with a non-remote workMode — cannot rule out the target region", () => {
    const outcome = applyPreFilter(
      posting({ location: { kind: "unknown" }, workMode: "onsite" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — minimum keyword adherence", () => {
  it("passes when the floor is 0, regardless of keyword overlap", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Vendas" }),
      baseCriteria({ minKeywordAdherence: 0 }),
      ["typescript", "node"],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });

  it("rejects when fewer profile keywords appear in the title than the floor", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Vendas" }),
      baseCriteria({ minKeywordAdherence: 1 }),
      ["typescript", "node"],
      NOW,
    );
    expect(outcome.reason).toBe("insufficient_keyword_adherence");
  });

  it("passes when enough profile keywords appear in the title", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Node e TypeScript" }),
      baseCriteria({ minKeywordAdherence: 2 }),
      ["typescript", "node"],
      NOW,
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("applyPreFilter — track classification", () => {
  it("is populated even when the posting is rejected", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio Sênior em Backend" }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.tracks).toEqual(["dev"]);
  });

  it("is populated on a passing posting", () => {
    const outcome = applyPreFilter(posting(), baseCriteria(), [], NOW);
    expect(outcome.tracks).toEqual(["dev"]);
  });
});

describe("applyPreFilter — rejectUnknownTrack (ADR-051)", () => {
  it("does nothing when the flag is false (the default)", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Recursos Humanos" }),
      baseCriteria({ rejectUnknownTrack: false }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.tracks).toEqual([]);
  });

  it("rejects an unknown-track posting when the flag is true", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Recursos Humanos" }),
      baseCriteria({ rejectUnknownTrack: true }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toBe("track_unknown");
    expect(outcome.tracks).toEqual([]);
  });

  it("still passes a posting that matches a configured track", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Desenvolvimento Backend" }),
      baseCriteria({ rejectUnknownTrack: true }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.tracks).toEqual(["dev"]);
  });

  it("still reports track_unknown even for a track excluded by trackExclusions (ADR-015 veto lands as unknown)", () => {
    const outcome = applyPreFilter(
      posting({ title: "Estágio em Segurança do Trabalho" }),
      baseCriteria({
        rejectUnknownTrack: true,
        trackExclusions: {
          dev: [],
          security: ["segurança do trabalho"],
          automation: [],
          data: [],
        },
      }),
      [],
      NOW,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toBe("track_unknown");
    expect(outcome.tracks).toEqual([]);
  });
});

describe("applyPreFilter — ordering", () => {
  it("reports the first failing rule when a posting fails several at once", () => {
    // Fails title blocklist, title required is moot, company blocked, and
    // location — only the first rule's reason should be reported.
    const outcome = applyPreFilter(
      posting({
        title: "Analista Sênior Pleno",
        company: "Empresa Bloqueada",
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("title_blocked");
  });

  it("checks track before company, when title passes", () => {
    const outcome = applyPreFilter(
      posting({
        title: "Estágio em Recursos Humanos",
        company: "Empresa Bloqueada",
      }),
      baseCriteria({ rejectUnknownTrack: true }),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("track_unknown");
  });

  it("checks company before location, when title passes", () => {
    const outcome = applyPreFilter(
      posting({
        company: "Empresa Bloqueada",
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("company_blocked");
  });

  it("checks expiry before location, when title and company pass", () => {
    const outcome = applyPreFilter(
      posting({
        applicationDeadline: new Date("2020-01-01T00:00:00Z"),
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria(),
      [],
      NOW,
    );
    expect(outcome.reason).toBe("expired");
  });

  it("checks location before keyword adherence", () => {
    const outcome = applyPreFilter(
      posting({
        title: "Estágio em Vendas",
        location: { kind: "known", city: "São Paulo" },
        workMode: "onsite",
      }),
      baseCriteria({ minKeywordAdherence: 5 }),
      ["typescript"],
      NOW,
    );
    expect(outcome.reason).toBe("location_not_allowed");
  });
});

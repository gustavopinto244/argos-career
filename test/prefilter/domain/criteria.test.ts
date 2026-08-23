import { describe, expect, it } from "vitest";
import { CriteriaSchema } from "../../../src/prefilter/domain/criteria";

function validCriteria() {
  return {
    titleBlocklist: ["sênior", "pleno"],
    titleRequired: ["estágio", "estagiário"],
    location: { cities: ["Rio de Janeiro"], allowRemote: true },
    blockedCompanies: [],
    minKeywordAdherence: 1,
    tracks: {
      dev: ["backend", "node"],
      security: ["segurança", "firewall"],
      automation: ["automação", "devops"],
      data: ["análise de dados"],
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
    },
  };
}

describe("CriteriaSchema", () => {
  it("accepts a structurally valid criteria document", () => {
    expect(CriteriaSchema.safeParse(validCriteria()).success).toBe(true);
  });

  it("requires titleRequired to have at least one entry", () => {
    const criteria = { ...validCriteria(), titleRequired: [] };
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("defaults titleBlocklist and blockedCompanies to empty arrays when omitted", () => {
    const {
      titleBlocklist: _tb,
      blockedCompanies: _bc,
      ...rest
    } = validCriteria();
    const result = CriteriaSchema.parse(rest);
    expect(result.titleBlocklist).toEqual([]);
    expect(result.blockedCompanies).toEqual([]);
  });

  it("defaults minKeywordAdherence to 0 when omitted", () => {
    const { minKeywordAdherence: _mka, ...rest } = validCriteria();
    expect(CriteriaSchema.parse(rest).minKeywordAdherence).toBe(0);
  });

  it("defaults maxFutureSkewDays to 1 when omitted (docs/audit AC-029)", () => {
    expect(CriteriaSchema.parse(validCriteria()).maxFutureSkewDays).toBe(1);
  });

  it("defaults location.nationwideSources to ['catho', 'ciee'] when omitted (docs/audit AC-024, PR-016)", () => {
    expect(
      CriteriaSchema.parse(validCriteria()).location.nationwideSources,
    ).toEqual(["catho", "ciee"]);
  });

  it("rejects a tracks table missing one of the three required tracks", () => {
    const criteria = validCriteria();
    // @ts-expect-error deliberately incomplete for the test
    delete criteria.tracks.automation;
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("rejects an unknown track key in the tracks table", () => {
    const criteria = {
      ...validCriteria(),
      tracks: { ...validCriteria().tracks, madeUpTrack: ["x"] },
    };
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("requires every trackWeights field", () => {
    const criteria = validCriteria();
    // @ts-expect-error deliberately incomplete for the test
    delete criteria.trackWeights.unknown;
    expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
  });

  it("requires the scoring section", () => {
    const { scoring: _scoring, ...rest } = validCriteria();
    expect(CriteriaSchema.safeParse(rest).success).toBe(false);
  });

  it("parses scoring's weights and thresholds correctly", () => {
    const result = CriteriaSchema.parse(validCriteria());
    expect(result.scoring.weights).toEqual({
      mandatory: 65,
      desirable: 20,
      trackAlignment: 15,
    });
    expect(result.scoring.thresholds).toEqual({ apply: 70, review: 45 });
  });

  it("location defaults allowRemote to true and cities to empty when omitted", () => {
    const result = CriteriaSchema.parse({ ...validCriteria(), location: {} });
    expect(result.location).toEqual({
      cities: [],
      allowRemote: true,
      nationwideSources: ["catho", "ciee"],
    });
  });

  describe("schedule (M8, ADR-009)", () => {
    it("defaults to ADR-009's own defaults when the section is omitted entirely", () => {
      const result = CriteriaSchema.parse(validCriteria());
      expect(result.schedule).toEqual({
        collection: { intervalHours: 4 },
        scoreAndDeliver: { time: "03:00", timezone: "America/Sao_Paulo" },
      });
    });

    it("accepts an explicit, non-default schedule", () => {
      const result = CriteriaSchema.parse({
        ...validCriteria(),
        schedule: {
          collection: { intervalHours: 2 },
          scoreAndDeliver: { time: "23:30", timezone: "UTC" },
        },
      });
      expect(result.schedule.collection.intervalHours).toBe(2);
      expect(result.schedule.scoreAndDeliver).toEqual({
        time: "23:30",
        timezone: "UTC",
      });
    });

    it("rejects a scoreAndDeliver.time not in HH:mm 24h form", () => {
      const criteria = {
        ...validCriteria(),
        schedule: { scoreAndDeliver: { time: "3am" } },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects a non-positive collection interval", () => {
      const criteria = {
        ...validCriteria(),
        schedule: { collection: { intervalHours: 0 } },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });
  });

  describe("alerts (M8, docs/08-observability.md)", () => {
    it("defaults consecutiveEmptyCollectionRuns and scoreFailureRateThreshold when omitted", () => {
      const result = CriteriaSchema.parse(validCriteria());
      expect(result.alerts).toEqual({
        consecutiveEmptyCollectionRuns: 2,
        scoreFailureRateThreshold: 0.5,
        // Empty, not absent: an unlisted source is deliberately not checked
        // for freshness (docs/11-known-issues.md B13), so the safe default
        // is "watch nothing until someone says what fresh means".
        sourceFreshnessHours: {},
      });
    });

    it("accepts explicit alert thresholds", () => {
      const result = CriteriaSchema.parse({
        ...validCriteria(),
        alerts: {
          consecutiveEmptyCollectionRuns: 3,
          scoreFailureRateThreshold: 0.25,
        },
      });
      expect(result.alerts).toEqual({
        consecutiveEmptyCollectionRuns: 3,
        scoreFailureRateThreshold: 0.25,
        sourceFreshnessHours: {},
      });
    });

    it("accepts per-source freshness windows (docs/11-known-issues.md B13)", () => {
      const result = CriteriaSchema.parse({
        ...validCriteria(),
        alerts: { sourceFreshnessHours: { indeed: 36, gupy: 72 } },
      });
      expect(result.alerts.sourceFreshnessHours).toEqual({
        indeed: 36,
        gupy: 72,
      });
    });

    it("rejects a non-positive freshness window", () => {
      expect(() =>
        CriteriaSchema.parse({
          ...validCriteria(),
          alerts: { sourceFreshnessHours: { indeed: 0 } },
        }),
      ).toThrow();
    });

    it("rejects a scoreFailureRateThreshold outside [0, 1]", () => {
      const criteria = {
        ...validCriteria(),
        alerts: { scoreFailureRateThreshold: 1.5 },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });
  });

  describe("scoring invariants (docs/audit AC-025)", () => {
    it("accepts weights that sum to exactly 100", () => {
      const criteria = validCriteria();
      expect(CriteriaSchema.safeParse(criteria).success).toBe(true);
    });

    it("rejects weights that do not sum to 100 (a config typo like mandatory: 350)", () => {
      const criteria = {
        ...validCriteria(),
        scoring: {
          ...validCriteria().scoring,
          weights: { mandatory: 350, desirable: 20, trackAlignment: 15 },
        },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects weights that sum to less than 100", () => {
      const criteria = {
        ...validCriteria(),
        scoring: {
          ...validCriteria().scoring,
          weights: { mandatory: 10, desirable: 10, trackAlignment: 10 },
        },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects an apply threshold not greater than the review threshold", () => {
      const criteria = {
        ...validCriteria(),
        scoring: {
          ...validCriteria().scoring,
          thresholds: { apply: 45, review: 45 },
        },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects an inverted apply/review threshold pair", () => {
      const criteria = {
        ...validCriteria(),
        scoring: {
          ...validCriteria().scoring,
          thresholds: { apply: 40, review: 70 },
        },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects a blockingCapScore outside [0, 100]", () => {
      const criteria = {
        ...validCriteria(),
        scoring: { ...validCriteria().scoring, blockingCapScore: 150 },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects an unknownTrackCapScore outside [0, 100]", () => {
      const criteria = {
        ...validCriteria(),
        scoring: { ...validCriteria().scoring, unknownTrackCapScore: -5 },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });

    it("rejects a trackWeights entry outside [0, 1]", () => {
      const criteria = {
        ...validCriteria(),
        trackWeights: {
          dev: 1.5,
          security: 1.0,
          automation: 0.7,
          data: 0.7,
          unknown: 0.4,
        },
      };
      expect(CriteriaSchema.safeParse(criteria).success).toBe(false);
    });
  });
});

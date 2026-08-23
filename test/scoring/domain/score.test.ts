import { describe, expect, it } from "vitest";
import {
  computeScore,
  computeTrackAlignment,
} from "../../../src/scoring/domain/score";
import {
  createMatch,
  Requirement,
  ScoringConfig,
  Track,
} from "../../../src/scoring/domain/types";

const baseConfig: ScoringConfig = {
  weights: { mandatory: 65, desirable: 20, trackAlignment: 15 },
  thresholds: { apply: 70, review: 45 },
  trackWeights: {
    dev: 1.0,
    security: 1.0,
    automation: 0.7,
    data: 0.7,
    unknown: 0.4,
  },
  minExtractedRequirements: 3,
  blockingCapScore: 35,
  unknownTrackCapScore: 50,
};

function requirement(
  weight: Requirement["weight"],
  text = "requirement",
): Requirement {
  return { text, category: "general", weight };
}

describe("computeTrackAlignment", () => {
  it("falls back to the unknown weight when no track matched", () => {
    expect(computeTrackAlignment([], baseConfig.trackWeights)).toBe(0.4);
  });

  it("uses the single matched track's weight", () => {
    expect(computeTrackAlignment(["automation"], baseConfig.trackWeights)).toBe(
      0.7,
    );
  });

  it("picks the highest weight across multiple matched tracks", () => {
    const tracks: Track[] = ["automation", "security"];
    expect(computeTrackAlignment(tracks, baseConfig.trackWeights)).toBe(1.0);
  });

  it("is order-independent when picking the highest weight", () => {
    expect(
      computeTrackAlignment(
        ["security", "automation"],
        baseConfig.trackWeights,
      ),
    ).toBe(
      computeTrackAlignment(
        ["automation", "security"],
        baseConfig.trackWeights,
      ),
    );
  });
});

describe("computeScore — coverage", () => {
  it("treats an empty mandatory category as full coverage (1)", () => {
    const outcome = computeScore([], ["dev"], baseConfig);
    expect(outcome.breakdown.mandatoryCoverage).toBe(1);
    expect(outcome.breakdown.desirableCoverage).toBe(1);
  });

  it("averages statusWeight across a mandatory category", () => {
    const matches = [
      createMatch(requirement("mandatory", "a"), "met", "evidence a"),
      createMatch(requirement("mandatory", "b"), "partial", "evidence b"),
      createMatch(requirement("mandatory", "c"), "not_met", null),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    // (1.0 + 0.5 + 0.0) / 3
    expect(outcome.breakdown.mandatoryCoverage).toBeCloseTo(0.5, 10);
  });

  it("only counts requirements of the matching weight in each coverage term", () => {
    const matches = [
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "not_met", null),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.breakdown.mandatoryCoverage).toBe(1);
    expect(outcome.breakdown.desirableCoverage).toBe(0);
  });
});

describe("computeScore — blocking requirements", () => {
  it("caps the score at blockingCapScore when a blocking requirement is not_met", () => {
    const blocking = requirement("blocking", "period >= 3");
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.score).toBe(35);
    expect(outcome.blockingFailure).toEqual(blocking);
    expect(outcome.verdict).toBe("discard");
  });

  it("caps the score at blockingCapScore when a blocking requirement is only partial", () => {
    const blocking = requirement("blocking", "ATS knockout question");
    const matches = [
      createMatch(blocking, "partial", "ambiguous evidence"),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.score).toBe(35);
    expect(outcome.blockingFailure).toEqual(blocking);
  });

  it("does not raise a score that is already below the cap", () => {
    const blocking = requirement("blocking");
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "not_met", null),
      createMatch(requirement("desirable"), "not_met", null),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    // raw score = 65*0 + 20*0 + 15*0.4(unknown) = 6, below the 35 cap
    expect(outcome.score).toBeCloseTo(6, 10);
  });

  it("leaves blockingFailure null when the blocking requirement is met", () => {
    const matches = [createMatch(requirement("blocking"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.blockingFailure).toBeNull();
  });

  it("leaves blockingFailure null when there are no blocking requirements", () => {
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.blockingFailure).toBeNull();
  });

  it("exposes every unmet blocking requirement in blockingFailures, not just the first", () => {
    const first = requirement("blocking", "first blocker");
    const second = requirement("blocking", "second blocker");
    const matches = [
      createMatch(first, "not_met", null),
      createMatch(second, "not_met", null),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.blockingFailure).toEqual(first);
    expect(outcome.blockingFailures).toEqual([first, second]);
  });
});

describe("computeScore — period gate", () => {
  const courseStart = new Date("2026-03-01T00:00:00Z");
  // Period 2 as of this date (matches academic-period.test.ts's own fixture).
  const period2Today = new Date("2026-08-14T00:00:00Z");

  it("is null when no academicContext is supplied — every existing caller's behavior", () => {
    const blocking = requirement(
      "blocking",
      "Estar cursando a partir do 4º período.",
    );
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig);
    expect(outcome.periodGate).toBeNull();
  });

  it("routes a sole not-yet-reached period gate to periodGate instead of only capping the score", () => {
    const blocking = requirement(
      "blocking",
      "Estar cursando a partir do 4º período.",
    );
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig, {
      courseStart,
      today: period2Today,
    });
    // Still capped — periodGate is additional context, not a different score.
    expect(outcome.score).toBe(35);
    expect(outcome.periodGate).toEqual({
      minimumPeriod: 4,
      opensAtLabel: "2027.2",
    });
  });

  it("stays null when the rest of the posting would not even clear review uncapped", () => {
    const blocking = requirement(
      "blocking",
      "Estar cursando a partir do 4º período.",
    );
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "not_met", null),
      createMatch(requirement("desirable"), "not_met", null),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig, {
      courseStart,
      today: period2Today,
    });
    // rawScore = 65*0 + 20*0 + 15*1 = 15, well below the review threshold —
    // a weak match that also has a period gate, not "a good fit, just early".
    expect(outcome.periodGate).toBeNull();
  });

  it("stays null when another blocking requirement fails alongside the period gate", () => {
    const periodBlocking = requirement(
      "blocking",
      "Estar cursando a partir do 4º período.",
    );
    const otherBlocking = requirement("blocking", "Ter CNH categoria B.");
    const matches = [
      createMatch(periodBlocking, "not_met", null),
      createMatch(otherBlocking, "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig, {
      courseStart,
      today: period2Today,
    });
    expect(outcome.periodGate).toBeNull();
  });

  it("stays null when the candidate has already reached the required period", () => {
    const blocking = requirement(
      "blocking",
      "Estar cursando a partir do 2º período.",
    );
    const matches = [
      createMatch(blocking, "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], baseConfig, {
      courseStart,
      today: period2Today,
    });
    expect(outcome.periodGate).toBeNull();
  });
});

// `["dev"]`, not `[]` — these tests isolate the mandatory/threshold math via
// `trackAlignment: 0`, so which track is passed makes no difference to the
// score, but an empty (unknown) track would now trip `unknownTrackCapScore`
// (ADR-025) and cap 70/69 down to 50, breaking the boundary these tests
// actually check. `unknownTrackCapScore` has its own describe block below.
describe("computeScore — verdict boundaries", () => {
  it("is 'apply' at exactly the apply threshold (70)", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 70, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], config);
    expect(outcome.score).toBe(70);
    expect(outcome.verdict).toBe("apply");
  });

  it("is 'review' just below the apply threshold", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 69, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], config);
    expect(outcome.score).toBe(69);
    expect(outcome.verdict).toBe("review");
  });

  it("is 'review' at exactly the review threshold (45)", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 45, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], config);
    expect(outcome.score).toBe(45);
    expect(outcome.verdict).toBe("review");
  });

  it("is 'discard' just below the review threshold", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 44, desirable: 0, trackAlignment: 0 },
      minExtractedRequirements: 1,
    };
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], config);
    expect(outcome.score).toBe(44);
    expect(outcome.verdict).toBe("discard");
  });
});

describe("computeScore — unknownTrackCapScore (ADR-025)", () => {
  it("caps the score when the posting matches no track — the real HR-internship case", () => {
    // The exact shape of the 2026-08-16 incident: a generic posting whose
    // few requirements are trivially satisfied, so both coverages hit 1.0.
    const matches = [
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    // Uncapped this would be 65 + 20 + 15*0.4 = 91 — computed once to prove
    // the cap is actually doing something, not just coincidentally at 50.
    const uncapped =
      baseConfig.weights.mandatory +
      baseConfig.weights.desirable +
      baseConfig.weights.trackAlignment * baseConfig.trackWeights.unknown;
    expect(uncapped).toBeGreaterThan(baseConfig.unknownTrackCapScore);
    expect(outcome.score).toBe(baseConfig.unknownTrackCapScore);
    expect(outcome.verdict).toBe("review");
  });

  it("does not raise a score already below the cap — a cap, not a floor", () => {
    const matches = [createMatch(requirement("mandatory"), "not_met", null)];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.score).toBeLessThan(baseConfig.unknownTrackCapScore);
  });

  it("does not apply when the posting matches a real track", () => {
    const matches = [
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("desirable"), "met", "e"),
    ];
    // minExtractedRequirements overridden to 1 — baseConfig's 3 would flag
    // lowConfidence against this test's 2 requirements and cap the verdict
    // at review regardless of score, which is a different rule than the one
    // this test checks.
    const outcome = computeScore(matches, ["dev"], {
      ...baseConfig,
      minExtractedRequirements: 1,
    });
    // dev's full trackAlignment (1.0) pushes this well past the unknown cap.
    expect(outcome.score).toBeGreaterThan(baseConfig.unknownTrackCapScore);
    expect(outcome.verdict).toBe("apply");
  });

  it("stacks with blockingCapScore — whichever cap is lower wins", () => {
    const matches = [
      createMatch(requirement("blocking"), "not_met", null),
      createMatch(requirement("mandatory"), "met", "e"),
    ];
    const config: ScoringConfig = { ...baseConfig, blockingCapScore: 20 };
    const outcome = computeScore(matches, [], config);
    expect(outcome.score).toBeLessThanOrEqual(20);
    expect(outcome.blockingFailure).not.toBeNull();
  });
});

describe("computeScore — lowConfidence", () => {
  it("flags lowConfidence when fewer requirements were extracted than the minimum", () => {
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, ["dev"], {
      ...baseConfig,
      minExtractedRequirements: 3,
    });
    expect(outcome.lowConfidence).toBe(true);
  });

  it("does not flag lowConfidence when enough requirements were extracted", () => {
    const matches = [
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("mandatory"), "met", "e"),
      createMatch(requirement("mandatory"), "met", "e"),
    ];
    const outcome = computeScore(matches, ["dev"], {
      ...baseConfig,
      minExtractedRequirements: 3,
    });
    expect(outcome.lowConfidence).toBe(false);
  });

  it("caps an otherwise-apply verdict at review when lowConfidence — the empty-posting edge case", () => {
    // No requirements at all: empty-category coverage rule gives full marks,
    // which would otherwise top the ranking on a vague, contentless posting.
    const outcome = computeScore([], ["dev"], baseConfig);
    expect(outcome.score).toBe(100);
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.verdict).toBe("review");
  });

  it("never upgrades a discard verdict to review because of lowConfidence", () => {
    const matches = [createMatch(requirement("mandatory"), "not_met", null)];
    const outcome = computeScore(matches, [], {
      ...baseConfig,
      minExtractedRequirements: 5,
    });
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.verdict).toBe("discard");
  });
});

describe("computeScore — criticalGaps", () => {
  it("includes not_met mandatory and blocking requirements", () => {
    const mandatoryGap = requirement("mandatory", "SQL");
    const blockingGap = requirement("blocking", "period >= 3");
    const matches = [
      createMatch(mandatoryGap, "not_met", null),
      createMatch(blockingGap, "not_met", null),
    ];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([mandatoryGap, blockingGap]);
  });

  it("includes a partial mandatory requirement as a gap", () => {
    const partialGap = requirement("mandatory", "Docker");
    const matches = [createMatch(partialGap, "partial", "some evidence")];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([partialGap]);
  });

  it("excludes met requirements", () => {
    const matches = [createMatch(requirement("mandatory"), "met", "e")];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([]);
  });

  it("excludes not_met desirable requirements — they are not critical", () => {
    const matches = [createMatch(requirement("desirable"), "not_met", null)];
    const outcome = computeScore(matches, [], baseConfig);
    expect(outcome.criticalGaps).toEqual([]);
  });
});

/**
 * ADR-015. Measured on the first 16 hand-labelled postings, 28% of all
 * mandatory and blocking requirements were unfalsifiable self-description
 * ("dinamismo", "proatividade"), and the effect was worst on the postings
 * judged best by hand — the DevOps internship scored 40.1 against a hand
 * score of 100 with 5 of its 10 mandatory requirements being traits.
 */
describe("computeScore — non-verifiable requirements (ADR-015)", () => {
  function trait(weight: Requirement["weight"], text = "dinamismo") {
    return { text, category: "soft_skill", weight, verifiable: false };
  }

  it("excludes a failed trait from mandatory coverage instead of scoring it zero", () => {
    const withTrait = computeScore(
      [
        createMatch(requirement("mandatory"), "met", "evidence"),
        createMatch(trait("mandatory"), "not_met", null),
      ],
      ["dev"],
      baseConfig,
    );
    const withoutTrait = computeScore(
      [createMatch(requirement("mandatory"), "met", "evidence")],
      ["dev"],
      baseConfig,
    );

    expect(withTrait.breakdown.mandatoryCoverage).toBe(1);
    expect(withTrait.score).toBe(withoutTrait.score);
  });

  it("does not let a trait marked blocking cap the score forever", () => {
    const outcome = computeScore(
      [
        createMatch(requirement("mandatory"), "met", "evidence"),
        createMatch(trait("blocking", "ter compromisso"), "not_met", null),
      ],
      ["dev"],
      baseConfig,
    );

    expect(outcome.blockingFailure).toBeNull();
    expect(outcome.score).toBeGreaterThan(baseConfig.blockingCapScore);
  });

  it("still caps on a verifiable blocking failure", () => {
    const outcome = computeScore(
      [
        createMatch(requirement("blocking"), "not_met", null),
        createMatch(trait("mandatory"), "not_met", null),
      ],
      ["dev"],
      baseConfig,
    );

    expect(outcome.blockingFailure).not.toBeNull();
    expect(outcome.score).toBeLessThanOrEqual(baseConfig.blockingCapScore);
  });

  it("keeps traits out of the study backlog", () => {
    const outcome = computeScore(
      [
        createMatch(requirement("mandatory", "Docker"), "not_met", null),
        createMatch(trait("mandatory"), "not_met", null),
      ],
      ["dev"],
      baseConfig,
    );

    expect(outcome.criticalGaps.map((r) => r.text)).toEqual(["Docker"]);
  });

  it("flags a posting made only of traits as lowConfidence rather than scoring it top", () => {
    const outcome = computeScore(
      [
        createMatch(trait("mandatory", "proatividade"), "not_met", null),
        createMatch(trait("mandatory", "dinamismo"), "not_met", null),
        createMatch(trait("mandatory", "boa comunicação"), "not_met", null),
        createMatch(trait("mandatory", "trabalho em equipe"), "not_met", null),
      ],
      ["dev"],
      baseConfig,
    );

    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.verdict).not.toBe("apply");
  });

  it("treats a requirement with no verifiable field as verifiable (legacy cache)", () => {
    const outcome = computeScore(
      [createMatch(requirement("mandatory"), "not_met", null)],
      ["dev"],
      baseConfig,
    );

    expect(outcome.breakdown.mandatoryCoverage).toBe(0);
  });
});

describe("computeScore — score is always clamped to [0, 100] (docs/audit AC-025)", () => {
  // CriteriaSchema rejects this config at load time (weights must sum to
  // 100) -- this is the defense-in-depth guarantee for a config that
  // reaches computeScore some other way, e.g. constructed directly in a
  // script or a future caller that skips CriteriaSchema.
  it("clamps a score above 100 when weights sum well past 100", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: 350, desirable: 0, trackAlignment: 0 },
    };
    const outcome = computeScore(
      [createMatch(requirement("mandatory"), "met", "e")],
      ["dev"],
      config,
    );
    expect(outcome.score).toBe(100);
  });

  it("clamps a score below 0 when a weight is negative", () => {
    const config: ScoringConfig = {
      ...baseConfig,
      weights: { mandatory: -50, desirable: 0, trackAlignment: 0 },
    };
    const outcome = computeScore(
      [createMatch(requirement("mandatory"), "met", "e")],
      ["dev"],
      config,
    );
    expect(outcome.score).toBe(0);
  });
});

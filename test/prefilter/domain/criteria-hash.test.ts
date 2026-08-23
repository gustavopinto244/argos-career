import { describe, expect, it } from "vitest";
import { CriteriaSchema } from "../../../src/prefilter/domain/criteria";
import { hashCriteria } from "../../../src/prefilter/domain/criteria-hash";

function criteria(overrides: Record<string, unknown> = {}) {
  return CriteriaSchema.parse({
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
    ...overrides,
  });
}

describe("hashCriteria", () => {
  it("is deterministic for the same criteria", () => {
    expect(hashCriteria(criteria())).toBe(hashCriteria(criteria()));
  });

  it("changes when titleRequired changes", () => {
    const a = hashCriteria(criteria());
    const b = hashCriteria(criteria({ titleRequired: ["trainee"] }));
    expect(a).not.toBe(b);
  });
});

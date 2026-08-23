import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCriteria } from "../../../src/prefilter/infrastructure/criteria-loader";

/**
 * config/criteria.yaml is committed, real, and consumed by the CLI. This is
 * the guard that keeps it structurally valid as the schema evolves.
 */
describe("config/criteria.yaml", () => {
  it("loads and validates against CriteriaSchema", () => {
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    expect(() => loadCriteria(filePath)).not.toThrow();
  });

  it("still excludes the provider measured broken in ADR-056", () => {
    // Not a style assertion: `sail-research` returned 0 of 8 usable Stage B
    // responses against production's own prompt (docs/11-known-issues.md
    // B11). Dropping it from criteria.yaml silently re-admits it to routing,
    // and the symptom — a digest full of "não foi possível pontuar" — looks
    // like a model problem, not a config edit.
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    const criteria = loadCriteria(filePath);
    expect(criteria.scoring.ignoredProviders).toContain("sail-research");
  });

  it("keeps dev and security as equal first priorities", () => {
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    const criteria = loadCriteria(filePath);
    expect(criteria.trackWeights.dev).toBe(criteria.trackWeights.security);
  });

  it("weighs trackAlignment above mandatoryCoverage (ADR-026)", () => {
    // A guard against silently reverting the 2026-08-16 recalibration —
    // requested directly, after mandatoryCoverage's 65% share left
    // trackAlignment's 15% unable to keep a real, partially-matched dev
    // posting out of `review`. Asserts the relationship the ADR is actually
    // about, not the exact numbers, so a further deliberate recalibration
    // doesn't have to touch this test as long as the relationship holds.
    const filePath = join(process.cwd(), "config", "criteria.yaml");
    const { weights } = loadCriteria(filePath).scoring;
    expect(weights.trackAlignment).toBeGreaterThan(weights.mandatory);
  });

  describe("query coverage (docs/audit AC-023)", () => {
    // Cities `location.cities` accepts but no Gupy query targets by name —
    // measured live against Gupy 2026-08-17 ("estágio"/"estagiário"/
    // "estagiária" per city): 13 postings returned across 21 city x term
    // combinations, 0 on-track. A deliberate, documented gap (see the
    // comment in criteria.yaml itself), not an oversight — this allowlist
    // exists so that if `location.cities` ever grows a city that is
    // *neither* queried *nor* in this known-gap list, that is new,
    // unreviewed coverage drift and this test fails on it, per the audit's
    // "matriz de cobertura... alertas por gap" recommendation.
    const KNOWN_UNQUERIED_CITIES = new Set([
      "Duque de Caxias",
      "Nova Iguaçu",
      "Belford Roxo",
      "São João de Meriti",
      "Itaboraí",
      "Maricá",
      "Mesquita",
    ]);

    function gupyQueriedCities(): Set<string> {
      const filePath = join(process.cwd(), "config", "criteria.yaml");
      const { queries } = loadCriteria(filePath).collection;
      return new Set(
        queries
          .filter((q) => q.source === "gupy" && q.city !== undefined)
          .map((q) => q.city!),
      );
    }

    it("every accepted city is either queried on Gupy or a documented, measured gap", () => {
      const filePath = join(process.cwd(), "config", "criteria.yaml");
      const { cities } = loadCriteria(filePath).location;
      const queried = gupyQueriedCities();

      const unaccountedFor = cities.filter(
        (city) => !queried.has(city) && !KNOWN_UNQUERIED_CITIES.has(city),
      );
      expect(unaccountedFor).toEqual([]);
    });

    it("the known-gap allowlist contains no city that is actually queried", () => {
      // Catches the allowlist going stale in the other direction — a city
      // added to criteria.yaml's Gupy queries without being dropped here.
      const queried = gupyQueriedCities();
      const stale = [...KNOWN_UNQUERIED_CITIES].filter((city) =>
        queried.has(city),
      );
      expect(stale).toEqual([]);
    });
  });
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadJobRadarConfig } from "../../../src/radar/infrastructure/job-radar-config-loader";

describe("config/job-radar.yaml", () => {
  const loadConfig = () =>
    loadJobRadarConfig(join(process.cwd(), "config", "job-radar.yaml"));

  it("loads and validates against JobRadarConfigSchema", () => {
    expect(loadConfig).not.toThrow();
  });

  it("explicitly searches for QA and support vacancies", () => {
    const terms = loadConfig().collection.queries.flatMap((query) =>
      query.jobName ? [query.jobName.toLocaleLowerCase("pt-BR")] : [],
    );

    expect(terms).toContain("qa");
    expect(terms).toContain("suporte");
  });

  it("reserves delivery slots for QA and support", () => {
    const categories = loadConfig().delivery.requiredCategories.map(
      ({ label }) => label,
    );

    expect(categories).toEqual(["QA", "Suporte"]);
  });
});

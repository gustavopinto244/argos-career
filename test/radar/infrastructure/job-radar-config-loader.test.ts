import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadJobRadarConfig } from "../../../src/radar/infrastructure/job-radar-config-loader";

describe("config/job-radar.yaml", () => {
  it("targets generalist roles in Joinville and remote Brazil", () => {
    const config = loadJobRadarConfig(
      join(process.cwd(), "config", "job-radar.yaml"),
    );
    expect(config.schedule.delivery.times).toEqual(["07:00", "14:00"]);
    expect(config.delivery.onsiteCity).toBe("Joinville");
    for (const term of ["analista", "auxiliar", "assistente", "negociador"]) {
      expect(
        config.collection.queries.some(
          (q) =>
            q.jobName === term &&
            q.city === "Joinville" &&
            q.isRemoteWork === false,
        ),
      ).toBe(true);
      expect(
        config.collection.queries.some(
          (q) => q.jobName === term && q.isRemoteWork === true && !q.city,
        ),
      ).toBe(true);
    }
    expect(
      config.collection.queries.every((q) =>
        config.delivery.titleTerms.includes(q.jobName!),
      ),
    ).toBe(true);
  });
});

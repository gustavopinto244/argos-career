import { describe, expect, it } from "vitest";
import { Profile } from "../../../src/profile/domain/profile";
import { hashProfile } from "../../../src/profile/domain/profile-hash";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
    workAvailability: "40h remoto, disponível dias úteis.",
    competencies: [
      {
        name: "Node.js",
        tracks: ["dev"],
        aliases: [],
        evidence: ["Built a Node.js service."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
    ...overrides,
  };
}

describe("hashProfile", () => {
  it("is deterministic for the same profile", () => {
    expect(hashProfile(profile())).toBe(hashProfile(profile()));
  });

  it("changes when a competency's evidence changes", () => {
    const a = hashProfile(profile());
    const b = hashProfile(
      profile({
        competencies: [
          {
            name: "Node.js",
            tracks: ["dev"],
            aliases: [],
            evidence: ["Different evidence."],
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  describe("academic period sensitivity (docs/audit AC-018)", () => {
    // courseStart 2026-03-01 -> period 1 through 2026-06, period 2 from
    // 2026-07 on (computeAcademicPeriod's semester-boundary math).
    const p = profile({ courseStart: new Date("2026-03-01") });

    it("changes when the derived academic period crosses a semester boundary", () => {
      const beforeBoundary = hashProfile(p, new Date("2026-06-30T00:00:00Z"));
      const afterBoundary = hashProfile(p, new Date("2026-07-01T00:00:00Z"));
      expect(beforeBoundary).not.toBe(afterBoundary);
    });

    it("stays the same for two dates within the same academic period", () => {
      const early = hashProfile(p, new Date("2026-03-01T00:00:00Z"));
      const late = hashProfile(p, new Date("2026-06-15T00:00:00Z"));
      expect(early).toBe(late);
    });

    it("is deterministic for the same profile and the same today", () => {
      const today = new Date("2026-08-14T00:00:00Z");
      expect(hashProfile(p, today)).toBe(hashProfile(p, today));
    });
  });
});

it("invalidates matching caches when start or duration is confirmed", () => {
  const original = profile();
  const now = new Date("2026-10-30");
  expect(
    hashProfile(
      { ...original, startAvailability: "Disponível para início imediato." },
      now,
    ),
  ).not.toBe(hashProfile(original, now));
  expect(
    hashProfile({ ...original, minimumInternshipMonths: 18 }, now),
  ).not.toBe(hashProfile(original, now));
});

import { describe, expect, it } from "vitest";
import { recurringGapsFor } from "../../../src/market/domain/recurring-gaps";
import { Taxonomy } from "../../../src/market/domain/taxonomy";
import { GapAnalysisEntry } from "../../../src/market/domain/types";
import { Requirement } from "../../../src/scoring/domain/types";

const TAXONOMY: Taxonomy = {
  skills: [
    { canonical: "Python", aliases: [] },
    { canonical: "AWS", aliases: ["Amazon Web Services"] },
    { canonical: "Docker", aliases: [] },
  ],
};

function requirement(text: string, category = ""): Requirement {
  return { text, category, weight: "mandatory" };
}

function history(
  ...pairs: readonly (readonly [string, number])[]
): GapAnalysisEntry[] {
  return pairs.map(([skill, count]) => ({ skill, count, percentage: 0 }));
}

describe("recurringGapsFor", () => {
  it("reports a gap this posting shares with the operator's history", () => {
    expect(
      recurringGapsFor(
        [requirement("Conhecimento em Python")],
        history(["Python", 3]),
        TAXONOMY,
      ),
    ).toEqual([{ skill: "Python", count: 3 }]);
  });

  it("matches through a taxonomy alias, not the requirement wording", () => {
    // The whole point of joining on the canonical skill: the posting says
    // "Amazon Web Services" and the history counted "AWS".
    expect(
      recurringGapsFor(
        [requirement("Vivência com Amazon Web Services")],
        history(["AWS", 2]),
        TAXONOMY,
      ),
    ).toEqual([{ skill: "AWS", count: 2 }]);
  });

  it("stays silent about a gap that has never cost the operator a posting", () => {
    // Docker is genuinely missing here, but the line claims recurrence and
    // there is none to claim.
    expect(
      recurringGapsFor(
        [requirement("Docker")],
        history(["Python", 3]),
        TAXONOMY,
      ),
    ).toEqual([]);
  });

  it("ranks by how often the skill has cost a posting, then alphabetically", () => {
    expect(
      recurringGapsFor(
        [requirement("Docker"), requirement("Python"), requirement("AWS")],
        history(["Docker", 1], ["Python", 5], ["AWS", 5]),
        TAXONOMY,
      ),
    ).toEqual([
      { skill: "AWS", count: 5 },
      { skill: "Python", count: 5 },
      { skill: "Docker", count: 1 },
    ]);
  });

  it("counts a skill once when two requirements both name it", () => {
    expect(
      recurringGapsFor(
        [requirement("Python básico"), requirement("Scripts em Python")],
        history(["Python", 4]),
        TAXONOMY,
      ),
    ).toEqual([{ skill: "Python", count: 4 }]);
  });

  it("reads the requirement category as well as its text", () => {
    expect(
      recurringGapsFor(
        [requirement("Linguagem de script", "Python")],
        history(["Python", 2]),
        TAXONOMY,
      ),
    ).toEqual([{ skill: "Python", count: 2 }]);
  });

  it("returns nothing when the posting has no unmet requirements", () => {
    expect(recurringGapsFor([], history(["Python", 3]), TAXONOMY)).toEqual([]);
  });

  it("returns nothing when there is no history to compare against", () => {
    // The first weeks of use: every gap is new, so nothing is recurring.
    expect(recurringGapsFor([requirement("Python")], [], TAXONOMY)).toEqual([]);
  });

  it("ignores a history entry whose count is zero", () => {
    expect(
      recurringGapsFor(
        [requirement("Python")],
        history(["Python", 0]),
        TAXONOMY,
      ),
    ).toEqual([]);
  });
});

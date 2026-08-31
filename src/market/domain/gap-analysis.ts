import { Profile } from "../../profile/domain/profile";
import { skillsInPosting } from "./aggregate-corpus";
import { findSkills, Taxonomy } from "./taxonomy";
import { CorpusEntry, GapAnalysisEntry } from "./types";
import { percentageOf } from "./percentage";

/**
 * Every taxonomy skill the profile already claims, via a competency's name
 * or any of its aliases — the "what's already known" side of the gap
 * comparison (docs/01-vision-and-scope.md).
 */
function profileSkills(profile: Profile, taxonomy: Taxonomy): Set<string> {
  const covered = new Set<string>();
  for (const competency of profile.competencies) {
    const text = [competency.name, ...competency.aliases].join(" ");
    for (const skill of findSkills(text, taxonomy)) {
      covered.add(skill);
    }
  }
  return covered;
}

/**
 * "Skills frequent in `entries` and weak or absent in the profile, ranked by
 * frequency" (docs/10-milestones.md).
 *
 * Deliberately takes `entries` as already scoped — this function used to
 * filter to verdict `review`/`apply` internally, but "what counts as in
 * scope" turned out not to be one fixed answer: M10's market-wide study
 * plan means high-compatibility postings; ADR-076's personal gap analysis
 * means postings the operator actually applied to, or postings discarded
 * specifically for an unmet competency (a different `discard` reason than
 * "off-track", which `verdict` alone cannot distinguish). Each caller now
 * decides that before calling this — see `composeStudyPlan` and
 * `personal-gap-scope.ts` for the two current scopes.
 *
 * Pure, no I/O — same discipline as `aggregateCorpus`.
 */
export function gapAnalysis(
  entries: readonly CorpusEntry[],
  profile: Profile,
  taxonomy: Taxonomy,
): GapAnalysisEntry[] {
  const covered = profileSkills(profile, taxonomy);

  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const skill of skillsInPosting(entry, taxonomy)) {
      if (covered.has(skill)) continue;
      counts.set(skill, (counts.get(skill) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([skill, count]) => ({
      skill,
      count,
      percentage: percentageOf(count, entries.length),
    }))
    .sort((a, b) => b.count - a.count);
}

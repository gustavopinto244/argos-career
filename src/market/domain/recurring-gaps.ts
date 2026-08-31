import { Requirement } from "../../scoring/domain/types";
import { findSkills, Taxonomy } from "./taxonomy";
import { GapAnalysisEntry } from "./types";

export interface RecurringGap {
  readonly skill: string;
  /** How many postings in the personal history demanded this same skill and
   * were discarded for an unmet requirement. */
  readonly count: number;
}

/**
 * Crosses one posting's own unmet requirements against the operator's
 * history, so the digest can say "this asks for Python, and Python has cost
 * you three postings already" at the moment the decision is being made
 * (ADR-078).
 *
 * The join is the taxonomy skill, not the requirement text: requirement
 * wording is free-form model output, so "Conhecimento em Python" and
 * "Python (desejável)" are the same gap only after both collapse onto the
 * canonical term. That is the same reason `gapAnalysis` counts skills
 * rather than strings, and why `docs/01-vision-and-scope.md` calls the
 * taxonomy the thing question 2 depends on.
 *
 * Reads `criticalGaps` — verifiable mandatory/blocking requirements the
 * profile did **not** meet — rather than every requirement. A skill the
 * profile already has is not a gap, however often it appears, and
 * `computeCriticalGaps` has already excluded unverifiable traits for the
 * same reason this function exists: "proatividade" is not something to go
 * and learn.
 *
 * Pure, no I/O — the caller supplies `history`, already aggregated.
 */
export function recurringGapsFor(
  criticalGaps: readonly Requirement[],
  history: readonly GapAnalysisEntry[],
  taxonomy: Taxonomy,
): RecurringGap[] {
  if (criticalGaps.length === 0 || history.length === 0) return [];

  const counts = new Map(history.map((entry) => [entry.skill, entry.count]));
  const seen = new Set<string>();
  const out: RecurringGap[] = [];

  for (const requirement of criticalGaps) {
    for (const skill of findSkills(
      `${requirement.text} ${requirement.category}`,
      taxonomy,
    )) {
      if (seen.has(skill)) continue;
      seen.add(skill);
      const count = counts.get(skill);
      // Absent from the history means it has never cost the operator a
      // posting — a real gap for *this* vacancy, but not a recurring one,
      // and this line only claims recurrence.
      if (count !== undefined && count > 0) out.push({ skill, count });
    }
  }

  return out.sort(
    (a, b) => b.count - a.count || a.skill.localeCompare(b.skill),
  );
}

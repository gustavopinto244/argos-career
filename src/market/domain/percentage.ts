/**
 * A share of a whole, expressed the way the field names holding it claim:
 * **0–100, not 0–1**.
 *
 * `SkillFrequency.percentage` and `GapAnalysisEntry.percentage` both used
 * to hold the raw fraction while being named `percentage`.
 * `renderStudyPlan` multiplied by 100 on the way out, so the Telegram text
 * was always right — which is precisely what kept the mismatch invisible
 * for as long as the only consumer was a renderer. It stopped being
 * invisible once `get_personal_gap_analysis` began returning the field raw
 * over MCP, where a consumer reading `0.15` as "0.15%" is wrong by 100×
 * (ADR-078 Amendment 1).
 *
 * One function rather than the arithmetic inlined at each site: the defect
 * was two independent copies of a unit convention, so there is now exactly
 * one place that decides it.
 *
 * Rounded to one decimal place. The field is a convenience — both payloads
 * carry the numerator (`count`) and the denominator (`extractedCount`,
 * `scopedPostingCount`) beside it, so any consumer needing the exact ratio
 * can divide. Full float precision on a derived share (1/63 →
 * 1.5873015873015872) is noise in a payload a person reads.
 */
export function percentageOf(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

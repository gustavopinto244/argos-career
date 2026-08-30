import { normalize } from "../../posting/domain/fingerprint";
import { findSkills, Taxonomy } from "./taxonomy";
import {
  CorpusEntry,
  CountBucket,
  MarketAggregates,
  SkillFrequency,
} from "./types";

function countBy(
  entries: readonly CorpusEntry[],
  label: (entry: CorpusEntry) => string,
): CountBucket[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = label(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([bucketLabel, count]) => ({ label: bucketLabel, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Same as `countBy`, but for free-text labels written by a source rather
 * than chosen from an enum — a city or a company name. Counts on
 * `normalize` (the fingerprint's own casing/accent/punctuation collapse,
 * ADR-007) and reports the most frequent original spelling, so the reader
 * still sees `"Brasília"` rather than a normalized `"brasilia"`.
 *
 * Sources disagree about casing, and grouping on the raw string split the
 * same place into several rows. Measured on the production corpus
 * (2026-08-29): **40 of 488 distinct city labels** were spelling variants of
 * another — `"BRASÍLIA" (10)` next to `"Brasília" (269)`, `"CAMPINAS" (1)`
 * next to `"Campinas" (96)` — and 12 of 2,964 company labels likewise.
 *
 * Small, but not invisible: it reordered the report's own top ten, where
 * `"Santos" (57)` outranked a `"São José dos Campos"` that was really 59
 * split across two rows. A market report whose ranking depends on how a
 * source capitalized a city name is not answering Question 2
 * (`docs/01-vision-and-scope.md`) honestly.
 *
 * Only for free text. `workModes` and `experienceLevels` come from closed
 * enums where every value is already canonical, and `countBy` stays for
 * them — normalizing a value that cannot vary would only obscure where the
 * label comes from.
 */
function countByCanonical(
  entries: readonly CorpusEntry[],
  label: (entry: CorpusEntry) => string,
): CountBucket[] {
  // Two passes rather than one, so picking the winning spelling never needs
  // a scan of `entries` per group: tally every raw spelling first, then
  // collapse. Ties keep the first spelling encountered — `Map` preserves
  // insertion order, so the result is deterministic for a given corpus.
  const spellings = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const raw = label(entry);
    const key = normalize(raw);
    const byRaw = spellings.get(key) ?? new Map<string, number>();
    byRaw.set(raw, (byRaw.get(raw) ?? 0) + 1);
    spellings.set(key, byRaw);
  }

  return [...spellings.values()]
    .map((byRaw) => {
      let total = 0;
      let best = "";
      let bestCount = -1;
      for (const [raw, count] of byRaw) {
        total += count;
        if (count > bestCount) {
          best = raw;
          bestCount = count;
        }
      }
      return { label: best, count: total };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Every distinct taxonomy skill mentioned anywhere in one posting's
 * requirements — deduplicated per posting so a skill named in three
 * separate requirements of the same posting still counts once, matching
 * "PostgreSQL appears in 58% of relevant postings" (docs/10-milestones.md),
 * a per-posting statement, not a per-mention one.
 */
export function skillsInPosting(
  entry: CorpusEntry,
  taxonomy: Taxonomy,
): string[] {
  const found = new Set<string>();
  for (const requirement of entry.requirements) {
    for (const skill of findSkills(
      `${requirement.text} ${requirement.category}`,
      taxonomy,
    )) {
      found.add(skill);
    }
  }
  return [...found];
}

/**
 * Stage C-style: pure, deterministic, no I/O (docs/04-scoring-model.md's
 * discipline, applied to market aggregation). Runs over the **whole**
 * corpus `MarketRepository` hands it, including postings the pre-filter
 * rejected (`docs/05-domain-model.md`'s "corpus is not a cache" principle)
 * — company/region/work-mode/experience-level counts use every posting,
 * since those fields exist independent of Stage A. Skill frequency can
 * only use postings with a cached extraction, so its percentage is of
 * `extractedCount`, not `corpusSize` — reporting it against the whole
 * corpus would understate every real number by however thin Stage A
 * coverage currently is, which is itself the M10 close-out's honest
 * finding, not something to hide inside a misleading denominator.
 */
export function aggregateCorpus(
  entries: readonly CorpusEntry[],
  taxonomy: Taxonomy,
): MarketAggregates {
  const extracted = entries.filter((entry) => entry.requirements.length > 0);

  const skillCounts = new Map<string, number>();
  for (const entry of extracted) {
    for (const skill of skillsInPosting(entry, taxonomy)) {
      skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    }
  }
  const skillFrequency: SkillFrequency[] = [...skillCounts.entries()]
    .map(([skill, count]) => ({
      skill,
      count,
      percentage: extracted.length === 0 ? 0 : count / extracted.length,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    corpusSize: entries.length,
    extractedCount: extracted.length,
    skillFrequency,
    companies: countByCanonical(entries, (entry) => entry.posting.company),
    regions: countByCanonical(entries, (entry) =>
      entry.posting.location.kind === "known"
        ? entry.posting.location.city
        : "unknown",
    ),
    workModes: countBy(entries, (entry) => entry.posting.workMode),
    experienceLevels: countBy(
      entries,
      (entry) => entry.posting.seniority ?? "unknown",
    ),
  };
}

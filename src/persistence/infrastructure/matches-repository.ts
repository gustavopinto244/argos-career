import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Match, MatchSchema, Requirement } from "../../scoring/domain/types";
import { Db } from "./db";
import { matches, partialMatches } from "./schema";

const CachedMatchesSchema = z.array(MatchSchema);

/** `null` on anything that is not a valid `Match[]` — same reasoning as
 * `extractions-repository.ts`'s `parseRequirements` (docs/audit AC-031,
 * PR-013): a corrupted cache row, or a structurally-valid-JSON array whose
 * elements are not real `Match`es (an invalid `status` enum, a nested
 * `requirement` missing a field), must read back as a miss, not throw and
 * take down whatever read it. */
function parseMatches(value: string): Match[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = CachedMatchesSchema.safeParse(parsed);
  return result.success ? (result.data as Match[]) : null;
}

/**
 * Stage B's cache, keyed by the composite `(fingerprint, profileHash,
 * promptVersion, model, requirementsHash)` (ADR-007, docs/audit
 * AC-007/PR-017). `profileHash` is what makes this cache correct against a
 * profile edit; `requirementsHash` against a Stage A change (a new prompt
 * version, or a content-hash-triggered re-extraction) that leaves
 * `fingerprint`/`profileHash`/`promptVersion` untouched from Stage B's own
 * point of view; `model` against switching `LLM_MODEL`. Before PR-017, only
 * `(fingerprint, profileHash, promptVersion)` was the row's actual database
 * identity — `model`/`requirementsHash` were checked after a row was
 * already found, so a different model or requirement set under that same
 * triple silently overwrote a still-valid match instead of coexisting
 * alongside it, enforced now by `matches_composite_identity_unique`.
 */
export class MatchesRepository {
  constructor(private readonly db: Db) {}

  upsert(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
    matchList: readonly Match[],
    matchedAt: Date,
  ): void {
    const existing = this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.fingerprint, fingerprint),
          eq(matches.profileHash, profileHash),
          eq(matches.promptVersion, promptVersion),
          eq(matches.model, model),
          eq(matches.requirementsHash, requirementsHash),
        ),
      )
      .get();

    const serialized = JSON.stringify(matchList);

    if (existing) {
      this.db
        .update(matches)
        .set({ matches: serialized, model, requirementsHash, matchedAt })
        .where(eq(matches.id, existing.id))
        .run();
    } else {
      this.db
        .insert(matches)
        .values({
          fingerprint,
          profileHash,
          promptVersion,
          model,
          requirementsHash,
          matches: serialized,
          matchedAt,
        })
        .run();
    }

    // Publishing the complete cache retires the per-requirement checkpoints
    // it was assembled from: they exist only to let a failed run resume, and
    // once every position is present here they can never be read again
    // (`findPartial` is only consulted after `find` misses, and `find` now
    // hits for this exact key).
    //
    // Without this they accumulated forever — ~25 rows per scored posting,
    // and a new `profileHash`, `promptVersion`, `model` or `requirementsHash`
    // starts a fresh generation without retiring the old one. Measured on
    // production before the fix: 571 of 585 partial rows (98%) were already
    // superseded by a complete row, and every nightly `VACUUM INTO` backup
    // copied all of them.
    this.deletePartial(
      fingerprint,
      profileHash,
      promptVersion,
      model,
      requirementsHash,
    );
  }

  /** Drops the resume checkpoints for one cache key. Safe to call when none
   * exist. */
  deletePartial(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
  ): void {
    this.db
      .delete(partialMatches)
      .where(
        and(
          eq(partialMatches.fingerprint, fingerprint),
          eq(partialMatches.profileHash, profileHash),
          eq(partialMatches.promptVersion, promptVersion),
          eq(partialMatches.model, model),
          eq(partialMatches.requirementsHash, requirementsHash),
        ),
      )
      .run();
  }

  find(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
  ): Match[] | null {
    const row = this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.fingerprint, fingerprint),
          eq(matches.profileHash, profileHash),
          eq(matches.promptVersion, promptVersion),
          eq(matches.model, model),
          eq(matches.requirementsHash, requirementsHash),
        ),
      )
      .get();
    if (!row) return null;

    return parseMatches(row.matches);
  }

  findPartial(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
    requirements: readonly Requirement[],
  ): readonly (Match | null)[] {
    const result: (Match | null)[] = requirements.map(() => null);
    const rows = this.db
      .select()
      .from(partialMatches)
      .where(
        and(
          eq(partialMatches.fingerprint, fingerprint),
          eq(partialMatches.profileHash, profileHash),
          eq(partialMatches.promptVersion, promptVersion),
          eq(partialMatches.model, model),
          eq(partialMatches.requirementsHash, requirementsHash),
        ),
      )
      .all();
    for (const row of rows) {
      const requirement = requirements[row.requirementIndex];
      if (!requirement) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.match);
      } catch {
        continue;
      }
      const validated = MatchSchema.safeParse(parsed);
      if (!validated.success) continue;
      const match = validated.data as Match;
      if (
        match.requirement.text === requirement.text &&
        match.requirement.category === requirement.category &&
        match.requirement.weight === requirement.weight &&
        match.requirement.verifiable === requirement.verifiable
      ) {
        result[row.requirementIndex] = match;
      }
    }
    return result;
  }

  upsertPartial(
    fingerprint: string,
    profileHash: string,
    promptVersion: string,
    model: string,
    requirementsHash: string,
    requirementIndex: number,
    match: Match,
    matchedAt: Date,
  ): void {
    this.db
      .insert(partialMatches)
      .values({
        fingerprint,
        profileHash,
        promptVersion,
        model,
        requirementsHash,
        requirementIndex,
        match: JSON.stringify(match),
        matchedAt,
      })
      .onConflictDoUpdate({
        target: [
          partialMatches.fingerprint,
          partialMatches.profileHash,
          partialMatches.promptVersion,
          partialMatches.model,
          partialMatches.requirementsHash,
          partialMatches.requirementIndex,
        ],
        set: { match: JSON.stringify(match), matchedAt },
      })
      .run();
  }
}

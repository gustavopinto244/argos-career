import { Posting } from "../domain/posting";
import { RawPosting } from "../domain/raw-posting";
import { normalizeCathoJob } from "./catho-normalizer";
import { normalizeCieeVaga } from "./ciee-normalizer";
import { normalizeGupyJob } from "./gupy-normalizer";
import { normalizeIndeedJob } from "./indeed-normalizer";
import { normalizeInfoJobsJob } from "./infojobs-normalizer";
import { normalizeNerdinJob } from "./nerdin-normalizer";
import { normalizeLinkedinAlertJob } from "./linkedin-alert-normalizer";
import { normalizeSolidesJob } from "./solides-normalizer";
import { normalizeVagasJob } from "./vagas-normalizer";

/**
 * `RawPosting` → `Posting` for one source. Every normalizer returns `null`
 * rather than throwing on a payload it cannot turn into a valid `Posting`
 * (principle 1 at the item level).
 */
export type Normalizer = (raw: RawPosting, now: Date) => Posting | null;

/**
 * Which normalizer handles which source, keyed by `RawPosting.source`.
 *
 * This exists because `executeCollect` called `normalizeGupyJob` directly —
 * a single source hardcoded in the middle of the collection loop. It worked
 * for as long as there was one source and silently guaranteed there would
 * only ever be one: a second collector's payloads would have been handed to
 * Gupy's schema, failed validation, and been dropped as malformed, with no
 * error anywhere. The failure would have looked exactly like an empty source.
 *
 * `source` is the key rather than the collector instance because that is
 * what actually travels with the data: `CollectionResult.source` and
 * `RawPosting.source` are already the contract, so the dispatch reuses a
 * fact the pipeline carries instead of inventing a parallel one.
 */
// A Map, not an object literal: plain property access would resolve
// `normalizerFor("toString")` to `Object.prototype.toString` — a function,
// so the null check passes, and the pipeline then calls something that is
// not a normalizer at all. Caught by a test rather than in production, but
// only because the test asked.
const NORMALIZERS: ReadonlyMap<string, Normalizer> = new Map([
  ["gupy", normalizeGupyJob],
  ["ciee", normalizeCieeVaga],
  ["indeed", normalizeIndeedJob],
  ["linkedin", normalizeLinkedinAlertJob],
  ["solides", normalizeSolidesJob],
  ["catho", normalizeCathoJob],
  ["infojobs", normalizeInfoJobsJob],
  ["nerdin", normalizeNerdinJob],
  ["vagas", normalizeVagasJob],
]);

/**
 * The normalizer for a source, or `null` when none is registered.
 *
 * Returning `null` rather than throwing keeps the collection loop's contract
 * intact — but an unregistered source is a *programming* error, not a
 * degraded source, so the caller is expected to surface it rather than skip
 * it quietly. That distinction is the whole reason this returns a nullable
 * instead of a no-op normalizer that would drop everything and look normal.
 */
export function normalizerFor(source: string): Normalizer | null {
  return NORMALIZERS.get(source) ?? null;
}

/** The sources this build knows how to normalize. */
export function registeredSources(): string[] {
  return [...NORMALIZERS.keys()].sort();
}

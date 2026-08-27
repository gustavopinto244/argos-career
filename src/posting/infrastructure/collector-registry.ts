import { CollectorPort } from "../domain/ports/collector.port";
import { CieeCollector } from "./ciee-collector";
import { GupyCollector } from "./gupy-collector";
import { InfoJobsCollector } from "./infojobs-collector";
import { NerdinCollector } from "./nerdin-collector";
import { SolidesCollector } from "./solides-collector";

/**
 * Which collector answers a query, keyed by the query's `source`.
 *
 * Mirrors `normalizerFor` deliberately: one registry decides who fetches,
 * the other decides who parses, and both are keyed by the same string. A
 * source is wired up when — and only when — it appears in both.
 *
 * Instances are created per call rather than shared. Collectors here hold no
 * cross-call state worth reusing (each carries only its timeout/backoff
 * settings), and a fresh one per cycle keeps them from accumulating any.
 */
const COLLECTORS: ReadonlyMap<string, () => CollectorPort> = new Map([
  ["gupy", () => new GupyCollector() as CollectorPort],
  ["ciee", () => new CieeCollector() as CollectorPort],
  ["solides", () => new SolidesCollector() as CollectorPort],
  ["infojobs", () => new InfoJobsCollector() as CollectorPort],
  ["nerdin", () => new NerdinCollector()],
]);

/**
 * The collector for a source, or `null` when none is registered.
 *
 * Null rather than a throw for the same reason `normalizerFor` returns null:
 * the caller can then report it as the wiring bug it is, instead of the
 * collection cycle dying on a config typo.
 */
export function collectorFor(source: string): CollectorPort | null {
  return COLLECTORS.get(source)?.() ?? null;
}

/** The sources this build can collect from. */
export function collectableSources(): string[] {
  return [...COLLECTORS.keys()].sort();
}

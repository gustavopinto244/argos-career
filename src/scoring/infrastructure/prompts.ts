import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Profile } from "../../profile/domain/profile";
import {
  buildEvidenceCatalog,
  formatEvidenceCatalog,
} from "../domain/evidence-catalog";
import { Requirement } from "../domain/types";

/**
 * The prompt version is the file it came from, not a separately maintained
 * string — a wording change means a new file (`a-v2`), so the version and
 * the content it names can never drift apart (see `prompts/*.v1.md`'s note).
 */
export const STAGE_A_PROMPT_VERSION = "a-v5";
export const STAGE_A_PROMPT_PATH = "./prompts/stage-a-extraction.v5.md";

export const STAGE_B_PROMPT_VERSION = "b-v4";
export const STAGE_B_PROMPT_PATH = "./prompts/stage-b-matching.v4.md";

/**
 * The prompt files are Markdown documentation with one fenced code block
 * holding the actual template — everything above and below the fence is
 * commentary for a human reader, not sent to the model.
 */
const templateCache = new Map<string, string>();

function loadTemplate(filePath: string): string {
  // Cache the file that was actually resolved, not its relative spelling.
  // A process may change cwd (tests do; workers and launchers can too), and
  // `./prompts/x.md` before and after that change are different files.
  const resolvedPath = resolve(filePath);
  const cached = templateCache.get(resolvedPath);
  if (cached !== undefined) return cached;
  const content = readFileSync(resolvedPath, "utf8");
  const match = /```\n([\s\S]*?)\n```/.exec(content);
  if (!match?.[1]) {
    throw new Error(`No fenced template block found in ${filePath}`);
  }
  templateCache.set(resolvedPath, match[1]);
  return match[1];
}

/**
 * Reads both templates once, up front, and reports the first that cannot be
 * loaded — a missing file, or a file with no fenced block.
 *
 * Exists because a prompt template is a *deployment* fact, not a per-posting
 * one: if `stage-a-extraction.v3.md` is absent, it is absent for all 2292
 * postings, and discovering that per posting turns one packaging mistake into
 * a batch of identical failures. `buildScorer` calls this so the condition
 * surfaces as the misconfiguration it is, on the same path that already
 * reports a missing LLM_API_KEY, instead of as a stack trace at 03:00.
 *
 * Returns the message rather than throwing, matching `BuildScorerResult` —
 * the caller decides whether that becomes a console line or a Telegram alert.
 */
export function verifyPromptTemplates(
  paths: readonly string[] = [STAGE_A_PROMPT_PATH, STAGE_B_PROMPT_PATH],
): string | null {
  for (const path of paths) {
    try {
      loadTemplate(path);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `Prompt template unavailable: ${detail}`;
    }
  }
  return null;
}

/**
 * The replacement is passed as a **function**, not a string, so `$` in the
 * value is literal.
 *
 * With a string replacement, `String.replaceAll` interprets `$&`, `` $` ``,
 * `$'` and `$1` in the *replacement* as substitution patterns — and the
 * values here are `POSTING_TITLE`/`POSTING_DESCRIPTION` (raw text from the
 * source) and `REQUIREMENT_TEXT` (model output derived from it). A posting
 * containing `$'` spliced the rest of the template back in after the
 * placeholder, duplicating or re-ordering the prompt's own instruction
 * block; `$&` re-inserted the `{{PLACEHOLDER}}` literal, leaving an
 * unsubstituted token in the rendered prompt. Neither is something posting
 * text should be able to do.
 */
function substitute(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, () => value),
    template,
  );
}

export function buildStageAPrompt(
  title: string,
  description: string | null,
  promptPath: string = STAGE_A_PROMPT_PATH,
): string {
  const template = loadTemplate(promptPath);
  return substitute(template, {
    POSTING_TITLE: title,
    POSTING_DESCRIPTION: description ?? "(not provided)",
  });
}

export function buildStageBPrompt(
  requirement: Requirement,
  profile: Profile,
  promptPath: string = STAGE_B_PROMPT_PATH,
  today: Date = new Date(),
): string {
  return createStageBPromptBuilder(profile, promptPath, today)(requirement);
}

/** Precomputes the invariant template and profile-evidence prefix once for
 * all requirements of one posting. Stage B used to repeat both synchronous
 * disk I/O and the full catalog render once per model call. */
export function createStageBPromptBuilder(
  profile: Profile,
  promptPath: string = STAGE_B_PROMPT_PATH,
  today: Date = new Date(),
): (requirement: Requirement) => string {
  const template = loadTemplate(promptPath);
  const profileEvidence = formatEvidenceCatalog(
    buildEvidenceCatalog(profile, today),
  );
  return (requirement) =>
    substitute(template, {
      REQUIREMENT_TEXT: requirement.text,
      REQUIREMENT_CATEGORY: requirement.category,
      REQUIREMENT_WEIGHT: requirement.weight,
      PROFILE_EVIDENCE: profileEvidence,
    });
}

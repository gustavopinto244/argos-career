import { Logger } from "@nestjs/common";
import { z } from "zod";
import { LlmFailureDiagnostic } from "../domain/failure-diagnostic";
import {
  isBatchFatalFailure,
  isTransientFailure,
  LlmTransportError,
} from "./openrouter-client";

/** Calls a model with a prompt and returns its raw text response. */
export type AskModel = (prompt: string) => Promise<string>;

export type LlmParseResult<T> =
  | { readonly ok: true; readonly data: T; readonly attempts: number }
  | {
      readonly ok: false;
      /**
       * `invalid_output` — the output-repair budget was exhausted: the model
       * kept answering with content that was not valid JSON or did not fit
       * the schema. `transport_failed` — the transport-retry budget was
       * exhausted on transient failures (timeout, rate limiting, 5xx,
       * provider error). `permanent_error` — a transport failure that is
       * never worth retrying at all (auth or config error, docs/audit
       * AC-016) ended the call on its very first attempt.
       */
      readonly reason:
        "invalid_output" | "transport_failed" | "permanent_error";
      readonly attempts: number;
      readonly lastError: string;
      /** Whether the failure proves the rest of this run is also doomed. */
      readonly batchFatal: boolean;
      /** Content-free operational cause, safe to persist with the posting. */
      readonly diagnostic: LlmFailureDiagnostic;
    };

const logger = new Logger("LlmOutput");

/** Transient transport failures (docs/audit AC-016): timeout, connection
 * failure, rate limiting, 5xx, provider error, malformed envelope, an
 * unexpected 2xx shape, or the circuit breaker refusing the call. Backed off
 * exponentially with jitter and, when the provider sends one, a trustworthy
 * `Retry-After`. */
const DEFAULT_MAX_TRANSPORT_ATTEMPTS = 4;
/** Output-repair attempts (ADR-006): the model answered, but the content was
 * not valid JSON or failed the schema. Retried immediately — no backoff,
 * this is not a network problem — feeding the error back into the prompt. */
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Full jitter: uniform in `[0, cap]`, where `cap` doubles per attempt. Avoids
 * every concurrent Stage B worker (ADR-022) backing off in lockstep and
 * re-storming the provider at the same instant. */
function computeBackoffMs(attempt: number): number {
  const cap = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(Math.random() * cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FENCE_PATTERN = /^```[a-zA-Z]*\n?|\n?```$/g;

/**
 * ADR-006 step 1: strip markdown fences and surrounding prose, trim to the
 * outermost JSON object or array. Lossless and shape-preserving only — no
 * field invention, no enum guessing. If no bracket is found, the input is
 * returned trimmed and `JSON.parse` fails naturally on it.
 */
export function normalizeModelOutput(raw: string): string {
  const withoutFences = raw.trim().replace(FENCE_PATTERN, "").trim();

  const firstBrace = withoutFences.indexOf("{");
  const firstBracket = withoutFences.indexOf("[");
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (starts.length === 0) return withoutFences;

  const sliceFrom = (start: number): string | null => {
    const closeChar = withoutFences[start] === "{" ? "}" : "]";
    const end = withoutFences.lastIndexOf(closeChar);
    if (end === -1 || end < start) return null;
    return withoutFences.slice(start, end + 1);
  };

  // Both candidate starts are tried, preferring one that actually parses,
  // rather than committing to whichever delimiter appears first.
  //
  // Taking the earliest position unconditionally broke on unfenced JSON
  // preceded by prose containing a bracket — a real Stage A shape:
  // `Analisando os requisitos [ver lista], segue o JSON:\n{"requirements":…}`
  // sliced from the `[`, producing text that could never parse. Each
  // occurrence then burned the whole 3-attempt repair budget and landed the
  // posting in the review section as `invalid_output`.
  //
  // Ordering still matters when both parse: the earliest start wins, so a
  // genuine array-at-top-level response is unaffected.
  const ordered = [...starts].sort((a, b) => a - b);
  const slices = ordered
    .map(sliceFrom)
    .filter((slice): slice is string => slice !== null);

  for (const slice of slices) {
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      // Try the other delimiter before giving up.
    }
  }

  // Nothing parsed: keep the previous behaviour and let `JSON.parse` fail
  // naturally downstream, where the failure is classified and retried.
  return slices[0] ?? withoutFences;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function buildRetryPrompt(originalPrompt: string, error: string): string {
  return `${originalPrompt}\n\nYour previous response was invalid: ${error}\nRespond again with only the corrected JSON, no other text.`;
}

export interface RetryOptions {
  readonly maxTransportAttempts?: number;
  readonly maxRepairAttempts?: number;
  /** Prefixed onto every log line for this call, purely for a human reading
   * logs to correlate attempts with a posting or requirement — e.g.
   * `"stage-a:<fingerprint>"`. Never parsed, never persisted: this project
   * deliberately has no structured logging system yet (docs/08-observability.md),
   * and building one is not what this option is for. */
  readonly operationLabel?: string;
}

/**
 * ADR-006's original policy (normalize, validate with Zod, retry with the
 * error fed back into the prompt) still governs *output repair* — the model
 * answered, but the content was wrong. docs/audit AC-016 (ADR-035) adds a
 * second, independent budget for *transport* failures — the request itself
 * failed before there was any content to repair — with its own retry logic:
 * exponential backoff with full jitter, honoring a trustworthy
 * `Retry-After`, and no retry at all for a permanent failure (auth/config).
 *
 * The two budgets are separate counters, never traded against each other:
 * a transport failure does not consume repair budget and vice versa. Total
 * attempts this call can ever make is bounded by their sum — the "teto
 * cumulativo" AC-016 asks for, derived rather than configured separately,
 * since deriving it can't drift out of sync with the two budgets the way a
 * hand-maintained third number could.
 *
 * Never throws — the caller gets a typed result, matching every other port
 * in this project (CollectorPort, NotifierPort).
 */
export async function parseModelOutputWithRetries<T>(
  schema: z.ZodType<T>,
  ask: AskModel,
  initialPrompt: string,
  options: RetryOptions = {},
): Promise<LlmParseResult<T>> {
  const maxTransportAttempts =
    options.maxTransportAttempts ?? DEFAULT_MAX_TRANSPORT_ATTEMPTS;
  const maxRepairAttempts =
    options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  const label = options.operationLabel ? `[${options.operationLabel}] ` : "";

  let prompt = initialPrompt;
  let lastError: string;
  let transportAttempt = 0;
  let repairAttempt = 0;
  let totalAttempts = 0;

  for (;;) {
    totalAttempts += 1;
    const startedAt = Date.now();
    let raw: string;
    try {
      raw = await ask(prompt);
    } catch (cause) {
      const latencyMs = Date.now() - startedAt;
      const category =
        cause instanceof LlmTransportError ? cause.category : "networkError";
      const message = cause instanceof Error ? cause.message : String(cause);
      lastError = `Request failed: ${message}`;
      const transportDiagnostic =
        cause instanceof LlmTransportError
          ? {
              category: cause.category,
              ...(cause.errorType ? { errorType: cause.errorType } : {}),
              ...(cause.provider ? { provider: cause.provider } : {}),
              ...(cause.model ? { model: cause.model } : {}),
              ...(cause.finishReason
                ? { finishReason: cause.finishReason }
                : {}),
              ...(cause.generationId
                ? { generationId: cause.generationId }
                : {}),
              ...(cause.status !== undefined
                ? { httpStatus: cause.status }
                : {}),
              lastAttemptLatencyMs: cause.latencyMs ?? latencyMs,
            }
          : {
              category: "networkError" as const,
              lastAttemptLatencyMs: latencyMs,
            };

      if (!isTransientFailure(category)) {
        logger.warn(
          `${label}attempt ${totalAttempts} failed permanently (${category}, ${latencyMs}ms): ${message}`,
        );
        return {
          ok: false,
          reason: "permanent_error",
          attempts: totalAttempts,
          lastError,
          batchFatal: isBatchFatalFailure(category),
          diagnostic: { kind: "permanent_error", ...transportDiagnostic },
        };
      }

      transportAttempt += 1;
      logger.warn(
        `${label}attempt ${totalAttempts} transient transport failure (${category}, ${latencyMs}ms): ${message}`,
      );
      if (transportAttempt >= maxTransportAttempts) {
        return {
          ok: false,
          reason: "transport_failed",
          attempts: totalAttempts,
          lastError,
          batchFatal: false,
          diagnostic: { kind: "transport_failed", ...transportDiagnostic },
        };
      }

      const retryAfterMs =
        cause instanceof LlmTransportError ? cause.retryAfterMs : undefined;
      const delayMs = retryAfterMs ?? computeBackoffMs(transportAttempt);
      logger.debug(
        `${label}retrying transport failure in ${delayMs}ms (transport attempt ${transportAttempt + 1}/${maxTransportAttempts})`,
      );
      await sleep(delayMs);
      // Deliberately unchanged: a transport failure has nothing to do with
      // the model's own output, so there is nothing to feed back into it.
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    const normalized = normalizeModelOutput(raw);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(normalized);
    } catch (cause) {
      lastError = `Output was not valid JSON: ${(cause as Error).message}`;
      logger.warn(
        `${label}attempt ${totalAttempts} invalid JSON output (${latencyMs}ms)`,
      );
      repairAttempt += 1;
      if (repairAttempt >= maxRepairAttempts) {
        return {
          ok: false,
          reason: "invalid_output",
          attempts: totalAttempts,
          lastError,
          batchFatal: false,
          diagnostic: {
            kind: "output_invalid_json",
            lastAttemptLatencyMs: latencyMs,
          },
        };
      }
      prompt = buildRetryPrompt(initialPrompt, lastError);
      continue;
    }

    const result = schema.safeParse(parsedJson);
    if (result.success) {
      // Only the recovered case is worth a line: a clean first-attempt
      // success is the common case, and logging every one of them would
      // flood a real run (~25 Stage B calls per posting, ADR-022) with
      // nothing failures-and-retries logging doesn't already say better.
      if (totalAttempts > 1) {
        logger.debug(
          `${label}recovered on attempt ${totalAttempts} (${latencyMs}ms)`,
        );
      }
      return { ok: true, data: result.data, attempts: totalAttempts };
    }

    lastError = describeIssues(result.error);
    logger.warn(
      `${label}attempt ${totalAttempts} invalid schema output (${latencyMs}ms): ${lastError}`,
    );
    repairAttempt += 1;
    if (repairAttempt >= maxRepairAttempts) {
      return {
        ok: false,
        reason: "invalid_output",
        attempts: totalAttempts,
        lastError,
        batchFatal: false,
        diagnostic: {
          kind: "output_schema_rejected",
          lastAttemptLatencyMs: latencyMs,
        },
      };
    }
    prompt = buildRetryPrompt(initialPrompt, lastError);
  }
}

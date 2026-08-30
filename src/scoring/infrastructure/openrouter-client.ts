import { Logger } from "@nestjs/common";
import { z } from "zod";
import { LlmFailureCategory } from "../domain/failure-diagnostic";
import { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker";

const logger = new Logger("OpenRouterClient");

const MAX_DIAGNOSTIC_CHARS = 200;

function boundedDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_DIAGNOSTIC_CHARS);
}

/**
 * Honest identification per OpenRouter's convention (the same etiquette
 * `GupyCollector`'s User-Agent follows, CLAUDE.md §6) — these headers are
 * informational for OpenRouter's own dashboards, not required for auth.
 */
const APP_URL = "https://github.com/gustavopinto244/ArgosCareer";
const APP_TITLE = "ArgosCareer";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_COMPLETION_TOKENS = 2_048;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ProviderErrorSchema = z
  .object({
    code: z.union([z.number().int(), z.string()]).optional(),
    // Parsed so the envelope remains forward-compatible, but deliberately
    // never logged or persisted: provider messages can echo user content.
    message: z.string().optional(),
    metadata: z
      .object({
        error_type: z.string().optional(),
        provider_code: z.union([z.string(), z.number()]).optional(),
        provider_name: z.string().optional(),
        model_slug: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const RouterMetadataSchema = z
  .object({
    endpoints: z
      .object({
        available: z
          .array(
            z
              .object({
                provider: z.string().optional(),
                model: z.string().optional(),
                selected: z.boolean().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    attempts: z
      .array(
        z
          .object({
            provider: z.string().optional(),
            model: z.string().optional(),
            status: z.number().int().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Tolerant on purpose (same reasoning as `GupyJobSchema`): this is a
 * third-party API. Success requirements are checked after documented error
 * envelopes have been recognized, so no field is universally required here.
 */
const ChatCompletionResponseSchema = z
  .object({
    // Deliberately no `.min(1)` here (docs/audit AC-015): a response with a
    // genuinely empty `choices` array — content filtered, no completion
    // returned — is still a structurally valid envelope, and OpenRouter can
    // still report real `usage` for it. Enforcing "at least one choice" at
    // the schema level made the whole envelope fail validation together
    // with `usage`, silently discarding usage the provider already
    // reported. `complete()` below checks `choices[0]` itself and treats a
    // missing first choice as its own failure — a business-rule check, not
    // a shape one.
    choices: z
      .array(
        z
          .object({
            message: z
              .object({ content: z.string().nullable().optional() })
              .passthrough()
              .optional(),
            finish_reason: z.string().nullable().optional(),
            error: ProviderErrorSchema.optional(),
          })
          .passthrough(),
      )
      .optional(),
    error: ProviderErrorSchema.optional(),
    id: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    openrouter_metadata: RouterMetadataSchema.optional(),
    // Usage validity is independent of completion validity. Keep the raw
    // value here and let `captureUsage` validate it separately so a malformed
    // accounting block cannot hide a documented provider error or discard
    // otherwise valid model content.
    usage: z.unknown().optional(),
  })
  .passthrough();

/**
 * How one `complete()` attempt ended — tracked independently of `calls`
 * (docs/audit/AUDIT_REPORT.md AC-015): `calls` only ever counted a fully
 * successful round trip, so a timeout, a network error, an HTTP error, a
 * malformed body, or an unexpected shape were all invisible to
 * `getUsage()` — the provider may have processed and billed a request
 * this client never counted as an attempt at all.
 *
 * Split from a single `httpError` bucket into the taxonomy AC-016 asks for
 * (`docs/audit/AUDIT_REPORT.md`): each category implies a different retry
 * policy one layer up (`llm-output.ts`) — `rateLimited`/`serverError`/
 * `providerError` are worth backing off and retrying, `authError`/
 * `configError` are not (retrying a bad API key or a malformed request
 * forever wastes budget on something no amount of waiting fixes).
 */
export type AttemptOutcome =
  | "success"
  | "timeout"
  | "networkError"
  | "rateLimited"
  | "serverError"
  | "providerError"
  | "authError"
  | "configError"
  /** Permanent for this request, but not evidence that every posting in the
   * batch is doomed (400/409/413/422). */
  | "requestError"
  | "invalidEnvelope"
  | "invalidOutput"
  /** Fallback for a non-2xx status this classifier has no more specific
   * bucket for (e.g. an unexpected 3xx). Kept rather than folded into one
   * of the categories above so an unanticipated status is still visible as
   * its own thing instead of silently miscounted. */
  | "httpError";

const ZERO_OUTCOMES: Readonly<Record<AttemptOutcome, number>> = {
  success: 0,
  timeout: 0,
  networkError: 0,
  rateLimited: 0,
  serverError: 0,
  providerError: 0,
  authError: 0,
  configError: 0,
  requestError: 0,
  invalidEnvelope: 0,
  invalidOutput: 0,
  httpError: 0,
};

/**
 * Everything `complete()` can throw, tagged with the category above plus
 * whatever the retry layer needs to act on it: a parsed, clamped
 * `Retry-After` when the provider sent a trustworthy one, and the raw HTTP
 * status for logging. `parseModelOutputWithRetries` (`llm-output.ts`) is
 * this class's one real consumer.
 */
export class LlmTransportError extends Error {
  readonly category: FailureCategory;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly errorType: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly finishReason: string | undefined;
  readonly generationId: string | undefined;
  readonly latencyMs: number | undefined;

  constructor(
    message: string,
    category: FailureCategory,
    options?: {
      cause?: unknown;
      retryAfterMs?: number | undefined;
      status?: number;
      errorType?: string;
      provider?: string;
      model?: string;
      finishReason?: string;
      generationId?: string;
      latencyMs?: number;
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "LlmTransportError";
    this.category = category;
    this.retryAfterMs = options?.retryAfterMs;
    this.status = options?.status;
    this.errorType = options?.errorType;
    this.provider = options?.provider;
    this.model = options?.model;
    this.finishReason = options?.finishReason;
    this.generationId = options?.generationId;
    this.latencyMs = options?.latencyMs;
  }
}

/**
 * `circuitOpen` is not a network attempt (`CircuitBreaker.beforeCall`
 * refuses the call before `fetch` is ever reached) so it is not a member of
 * `AttemptOutcome`, which `getUsage()` documents as strictly "reached the
 * network." It is still a failure category the retry layer needs to
 * classify, hence its own union rather than reusing `AttemptOutcome`.
 */
export type FailureCategory = LlmFailureCategory;

/**
 * Which categories are worth retrying at all. `authError` and `configError`
 * are the two AC-016 names explicitly as permanent — no `Retry-After`,
 * no backoff, no amount of waiting turns a bad API key or a malformed
 * request into a valid one.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>([
    "timeout",
    "networkError",
    "rateLimited",
    "serverError",
    "providerError",
    "invalidEnvelope",
    "invalidOutput",
    "httpError",
    "circuitOpen",
  ]);

export function isTransientFailure(category: FailureCategory): boolean {
  return TRANSIENT_CATEGORIES.has(category);
}

/** Only credentials or endpoint/model configuration are run-wide. A bad or
 * oversized individual prompt is permanent for that posting, not the batch. */
export function isBatchFatalFailure(category: FailureCategory): boolean {
  return category === "authError" || category === "configError";
}

/**
 * Whether a failure is evidence the *provider itself* is degraded — as
 * opposed to evidence about one specific request or response (docs/audit
 * PR-009). Deliberately a narrower set than `isTransientFailure`: a
 * connection failure, a timeout, a rate limit, or a 5xx says something
 * about the transport as a whole, which is exactly what
 * `CircuitBreaker` — one shared instance protecting every concurrent Stage
 * B worker (ADR-022) — needs to open on. A malformed envelope or an
 * unexpected empty-`choices` response (`invalidEnvelope`/`invalidOutput`)
 * is a fact about *that one response* — content filtering or a one-off
 * hiccup for a specific prompt — and five of those in a row said nothing
 * reliable about whether the next, unrelated posting's call would succeed.
 * Before this distinction existed, both unconditionally called
 * `onFailure(true)`, so five content-filtered answers across five
 * unrelated postings could trip the shared breaker and block every other
 * posting's calls for the full cooldown — the exact "systemic" failure the
 * breaker is supposed to reserve itself for.
 */
const BREAKER_TRIPPING_CATEGORIES: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>([
    "timeout",
    "networkError",
    "rateLimited",
    "serverError",
    "providerError",
  ]);

export function isBreakerTrippingFailure(category: FailureCategory): boolean {
  return BREAKER_TRIPPING_CATEGORIES.has(category);
}

/**
 * 401/403 (bad or revoked credentials) and 429 get their own category each;
 * 502/503/504 are OpenRouter's own documented vocabulary for "the upstream
 * model provider is unavailable," distinct enough from a generic 500 to be
 * worth its own bucket; 408 (Request Timeout) reuses the same category this
 * client's own `AbortController` timeout uses — both mean "no timely
 * response," and treating 408 as a permanent `configError` (docs/audit
 * PR-009) meant a legitimately retryable status was never retried; anything
 * A 402 is account-wide insufficient-credit/configuration state and stops the
 * batch; request-shape failures such as 400/409/413/422 are permanent only
 * for the current posting. Anything else falls to `serverError` (transient,
 * the safe default for an unclassified 5xx) or `httpError`.
 */
function classifyHttpStatus(
  status: number,
): Exclude<AttemptOutcome, "success"> {
  if (status === 401 || status === 403) return "authError";
  if (status === 408) return "timeout";
  if (status === 429) return "rateLimited";
  if (status === 502 || status === 503 || status === 504)
    return "providerError";
  if (status >= 500) return "serverError";
  if (status === 402 || status === 404 || status === 405) return "configError";
  if (status >= 400) return "requestError";
  return "httpError";
}

/** OpenRouter documents `error.metadata.error_type` as the stable signal
 * across providers and response skins. It wins over the outer HTTP status,
 * which can be 200 after generation has already started. */
function classifyErrorType(
  errorType: string | undefined,
  fallbackStatus: number,
): Exclude<AttemptOutcome, "success"> {
  switch (errorType) {
    case "authentication":
      return "authError";
    case "payment_required":
    case "not_found":
      return "configError";
    case "rate_limit_exceeded":
      return "rateLimited";
    case "provider_overloaded":
    case "provider_unavailable":
      return "providerError";
    case "timeout":
      return "timeout";
    case "server":
    case "unmapped":
      return "serverError";
    case "context_length_exceeded":
    case "max_tokens_exceeded":
    case "token_limit_exceeded":
    case "string_too_long":
    case "permission_denied":
    case "invalid_request":
    case "invalid_prompt":
    case "precondition_failed":
    case "payload_too_large":
    case "unprocessable":
    case "content_policy_violation":
    case "refusal":
    case "invalid_image":
    case "image_too_large":
    case "image_too_small":
    case "unsupported_image_format":
    case "image_not_found":
    case "image_download_failed":
      return "requestError";
    default:
      return classifyHttpStatus(fallbackStatus);
  }
}

interface ResponseDiagnostic {
  readonly errorType?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly generationId?: string;
}

type ParsedCompletionEnvelope = z.infer<typeof ChatCompletionResponseSchema>;

function responseDiagnostic(
  envelope: ParsedCompletionEnvelope,
  response: Response,
  error: z.infer<typeof ProviderErrorSchema> | undefined,
): ResponseDiagnostic {
  const metadata = envelope.openrouter_metadata;
  const selected = metadata?.endpoints?.available?.find(
    (endpoint) => endpoint.selected,
  );
  const lastAttempt = metadata?.attempts?.at(-1);
  const firstChoice = envelope.choices?.[0];

  const provider = boundedDiagnostic(
    envelope.provider ??
      error?.metadata?.provider_name ??
      lastAttempt?.provider ??
      selected?.provider,
  );
  const model = boundedDiagnostic(
    envelope.model ??
      error?.metadata?.model_slug ??
      lastAttempt?.model ??
      selected?.model,
  );
  const errorType = boundedDiagnostic(error?.metadata?.error_type);
  const finishReason = boundedDiagnostic(firstChoice?.finish_reason);
  const generationId = boundedDiagnostic(
    envelope.id ?? response.headers.get("x-generation-id"),
  );

  return {
    ...(errorType ? { errorType } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(generationId ? { generationId } : {}),
  };
}

function numericErrorCode(
  error: z.infer<typeof ProviderErrorSchema> | undefined,
): number | undefined {
  if (typeof error?.code === "number") return error.code;
  if (typeof error?.code !== "string") return undefined;
  const parsed = Number(error.code);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** Clamp so an untrustworthy or huge `Retry-After` cannot stall a nightly
 * batch run for a single posting — "quando confiável" (AC-016) means bounded,
 * not blindly obeyed. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * `Retry-After` is either a delta in seconds or an HTTP-date (RFC 9110
 * §10.2.3). Returns `undefined` — not zero — for anything that fails to
 * parse as either, so the caller falls back to its own computed backoff
 * instead of treating "couldn't parse" as "retry immediately."
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds >= 0
      ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
      : undefined;
  }

  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  return Math.min(Math.max(deltaMs, 0), MAX_RETRY_AFTER_MS);
}

/** Running totals across every call this client has made. */
export interface UsageTotals {
  /** Successful round trips only — kept for backward compatibility with
   * every existing caller (the M7 calibration script, ADR-014). */
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly costUsd: number;
  /** Every `complete()` invocation that reached the network, regardless of
   * outcome — `attempts >= calls` always, and the gap is exactly what
   * `calls` alone could never show (AC-015). */
  readonly attempts: number;
  readonly attemptsByOutcome: Readonly<Record<AttemptOutcome, number>>;
  /** Same attempts split by the operation that issued them. */
  readonly attemptsByStageOutcome: Readonly<
    Record<LlmOperationStage, Readonly<Record<AttemptOutcome, number>>>
  >;
  /** Provider/model routing metadata is deliberately reduced to counters. */
  readonly providerCounts: Readonly<Record<string, number>>;
  readonly errorTypeCounts: Readonly<Record<string, number>>;
  /** Attempts for which no usable `usage` object was available to add to
   * `costUsd`, regardless of whether the completion itself succeeded. A
   * provider error can still report usage, while a schema-valid success can
   * omit it (OpenRouter's own field is optional). A
   * `costUsd` of 0 with a nonzero count here means "unknown," not "free." */
  readonly attemptsWithoutUsage: number;
  /** Calls the circuit breaker (docs/audit AC-016) refused outright, before
   * `fetch` was ever reached — not part of `attempts`, which is documented
   * above as strictly "reached the network." A run where this climbs while
   * `attempts` stays flat means the provider was down long enough to trip
   * the breaker, not that requests are merely failing individually. */
  readonly blockedByCircuit: number;
}

type FetchLike = typeof fetch;

export type LlmOperationStage = "stage-a" | "stage-b" | "unknown";

export interface CompletionOptions {
  readonly stage?: LlmOperationStage;
  readonly timeoutMs?: number;
  readonly maxCompletionTokens?: number;
  /** ADR-052 Amendment 2: caps OpenRouter's `reasoning.max_tokens`, the
   * documented control for a reasoning model's internal chain-of-thought
   * (openrouter.ai/docs/use-cases/reasoning-tokens). Isolated Stage A calls
   * against this project's own failing postings showed `reasoning` alone
   * running 70,000+ characters, exhausting `maxCompletionTokens` before
   * `content` ever got written — raising the completion ceiling (Amendment
   * 1) did not fix this because reasoning has no ceiling of its own without
   * this option. `undefined` omits the field, leaving OpenRouter's default
   * (provider-decided) reasoning budget in place. */
  readonly reasoningMaxTokens?: number;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Injected for tests — no test ever makes a real network call
   * (docs/07-testing-strategy.md). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Provider-side output ceiling. Local Zod bounds remain the second line
   * of defence, but this prevents paying for an arbitrarily large response. */
  maxCompletionTokens?: number;
  maxResponseBytes?: number;
  /** Injected for tests, so a breaker trip can be asserted without waiting
   * out a real cooldown (docs/audit AC-016). Defaults to one shared instance
   * per client, protecting every call this client makes — across Stage A
   * and Stage B alike, since `build-scorer.ts` constructs exactly one
   * `OpenRouterClient` per run and both stages call through it. */
  circuitBreaker?: CircuitBreaker;
  /** ADR-056: OpenRouter provider slugs to exclude from routing, sent as
   * `provider.ignore`. Empty (the default) omits the field entirely,
   * leaving OpenRouter's normal routing untouched. */
  ignoredProviders?: readonly string[];
}

/**
 * A single chat-completion call against OpenRouter's OpenAI-compatible
 * endpoint (ADR-012). One attempt, no retry — retries live one layer up, in
 * `parseModelOutputWithRetries`, which classifies the typed
 * `LlmTransportError` this method throws and decides whether, and how long,
 * to wait before trying again (docs/audit AC-016; ADR-035).
 *
 * Throws on any failure (non-2xx, malformed body, empty `choices`, or the
 * circuit breaker refusing the call) rather than returning a result type:
 * this class has exactly one caller (`AskModel`), and that caller already
 * wraps every invocation in a try/catch (`llm-output.ts`) — a second
 * failure-as-value layer here would just be forwarded, not handled.
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxCompletionTokens: number;
  private readonly maxResponseBytes: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly ignoredProviders: readonly string[];

  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedPromptTokens = 0;
  private costUsd = 0;
  private attempts = 0;
  private attemptsByOutcome: Record<AttemptOutcome, number> = {
    ...ZERO_OUTCOMES,
  };
  private attemptsByStageOutcome: Record<
    LlmOperationStage,
    Record<AttemptOutcome, number>
  > = {
    "stage-a": { ...ZERO_OUTCOMES },
    "stage-b": { ...ZERO_OUTCOMES },
    unknown: { ...ZERO_OUTCOMES },
  };
  private providerCounts: Record<string, number> = {};
  private errorTypeCounts: Record<string, number> = {};
  private attemptsWithoutUsage = 0;
  private blockedByCircuit = 0;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxCompletionTokens =
      options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.ignoredProviders = options.ignoredProviders ?? [];
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("OpenRouter timeoutMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.maxCompletionTokens) ||
      this.maxCompletionTokens <= 0
    ) {
      throw new Error(
        "OpenRouter maxCompletionTokens must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0
    ) {
      throw new Error(
        "OpenRouter maxResponseBytes must be a positive safe integer",
      );
    }
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
  }

  /**
   * What this client has spent so far. Exposed as a getter rather than
   * threaded through `AskModel`'s return type: usage is an operational
   * concern of the transport, and making every caller carry it would push a
   * billing detail into the scoring stages, which have no business knowing
   * about it. Read by the M7 calibration script so one run's cost — and
   * whether the prompt cache is actually being hit — is visible rather than
   * inferred (ADR-014).
   */
  getUsage(): UsageTotals {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedPromptTokens: this.cachedPromptTokens,
      costUsd: this.costUsd,
      attempts: this.attempts,
      attemptsByOutcome: { ...this.attemptsByOutcome },
      attemptsByStageOutcome: {
        "stage-a": { ...this.attemptsByStageOutcome["stage-a"] },
        "stage-b": { ...this.attemptsByStageOutcome["stage-b"] },
        unknown: { ...this.attemptsByStageOutcome.unknown },
      },
      providerCounts: { ...this.providerCounts },
      errorTypeCounts: { ...this.errorTypeCounts },
      attemptsWithoutUsage: this.attemptsWithoutUsage,
      blockedByCircuit: this.blockedByCircuit,
    };
  }

  private recordOutcome(
    outcome: AttemptOutcome,
    stage: LlmOperationStage,
  ): void {
    this.attemptsByOutcome[outcome] += 1;
    this.attemptsByStageOutcome[stage][outcome] += 1;
  }

  private recordResponseDiagnostic(diagnostic: ResponseDiagnostic): void {
    if (diagnostic.provider) {
      this.providerCounts[diagnostic.provider] =
        (this.providerCounts[diagnostic.provider] ?? 0) + 1;
    }
    if (diagnostic.errorType) {
      this.errorTypeCounts[diagnostic.errorType] =
        (this.errorTypeCounts[diagnostic.errorType] ?? 0) + 1;
    }
  }

  private captureUsage(value: unknown): boolean {
    const parsed = UsageSchema.safeParse(value);
    if (!parsed.success) return false;
    const usage = parsed.data;
    this.promptTokens += usage.prompt_tokens ?? 0;
    this.completionTokens += usage.completion_tokens ?? 0;
    this.cachedPromptTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
    this.costUsd += usage.cost ?? 0;
    return true;
  }

  private async readBody(
    response: Response,
    signal: AbortSignal,
  ): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      throw new Error(
        `OpenRouter response exceeds ${this.maxResponseBytes} bytes`,
      );
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel();
          throw new Error(
            `OpenRouter response exceeds ${this.maxResponseBytes} bytes`,
          );
        }
        chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks, total));
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * `timeoutMs` here is the **remaining** budget for the attempt, not a fresh
   * copy of the full one.
   *
   * The fetch timer is cleared in its own `finally` before this runs, so
   * passing the whole `timeoutMs` again applied the deadline twice: one
   * Stage A attempt could run 240 s against a documented 120 s timeout, and
   * with `DEFAULT_MAX_TRANSPORT_ATTEMPTS = 4` a single posting could consume
   * ~16 minutes of the nightly window — while the code claimed an "explicit
   * timeout" per attempt.
   */
  private async readBodyWithDeadline(
    response: Response,
    controller: AbortController,
    remainingMs: number,
  ): Promise<string> {
    // Never zero or negative: a budget already spent still needs a tick for
    // the abort to be delivered rather than throwing synchronously here.
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, remainingMs),
    );
    try {
      return await this.readBody(response, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(
    prompt: string,
    options: CompletionOptions = {},
  ): Promise<string> {
    const stage = options.stage ?? "unknown";
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxCompletionTokens =
      options.maxCompletionTokens ?? this.maxCompletionTokens;
    const reasoningMaxTokens = options.reasoningMaxTokens;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("OpenRouter timeoutMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(maxCompletionTokens) ||
      maxCompletionTokens <= 0
    ) {
      throw new Error(
        "OpenRouter maxCompletionTokens must be a positive safe integer",
      );
    }
    if (
      reasoningMaxTokens !== undefined &&
      (!Number.isSafeInteger(reasoningMaxTokens) || reasoningMaxTokens <= 0)
    ) {
      throw new Error(
        "OpenRouter reasoningMaxTokens must be a positive safe integer",
      );
    }
    const startedAt = Date.now();

    try {
      this.circuitBreaker.beforeCall();
    } catch (cause) {
      // Refused before `fetch` is ever reached -- not an "attempt" by this
      // class's own definition of the word, so it is tracked separately
      // rather than inflating `attemptsByOutcome`.
      this.blockedByCircuit += 1;
      throw new LlmTransportError(
        (cause as CircuitBreakerOpenError).message,
        "circuitOpen",
        {
          cause,
          retryAfterMs: (cause as CircuitBreakerOpenError).retryAfterMs,
          latencyMs: Date.now() - startedAt,
        },
      );
    }

    // Counted before the network call, not after a successful one — this is
    // the direct fix for AC-015: every attempt that reaches the network is
    // now visible, regardless of how it ends.
    this.attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": APP_URL,
          "X-Title": APP_TITLE,
          "X-OpenRouter-Metadata": "enabled",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxCompletionTokens,
          ...(reasoningMaxTokens !== undefined
            ? { reasoning: { max_tokens: reasoningMaxTokens } }
            : {}),
          // ADR-056. Omitted entirely when empty so the default request
          // body is byte-identical to what it was before this existed.
          ...(this.ignoredProviders.length > 0
            ? { provider: { ignore: [...this.ignoredProviders] } }
            : {}),
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      // Our own abort (timeout) vs. anything else (DNS, connection reset,
      // TLS) — both are "no response," but distinguishing them is what the
      // retry/backoff policy one layer up needs (docs/audit AC-016).
      const category = controller.signal.aborted ? "timeout" : "networkError";
      this.recordOutcome(category, stage);
      this.attemptsWithoutUsage += 1;
      this.circuitBreaker.onFailure(isBreakerTrippingFailure(category));
      throw new LlmTransportError((cause as Error).message, category, {
        cause,
        latencyMs: Date.now() - startedAt,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await this.readBodyWithDeadline(
        response,
        controller,
        timeoutMs - (Date.now() - startedAt),
      ).catch(() => "");
      let errorJson: unknown;
      try {
        errorJson = JSON.parse(body);
      } catch {
        errorJson = null;
      }
      const parsedEnvelope = ChatCompletionResponseSchema.safeParse(errorJson);
      const envelope = parsedEnvelope.success ? parsedEnvelope.data : undefined;
      const error = envelope?.error ?? envelope?.choices?.[0]?.error;
      const diagnostic = envelope
        ? responseDiagnostic(envelope, response, error)
        : {};
      const category = classifyErrorType(diagnostic.errorType, response.status);
      this.recordOutcome(category, stage);
      this.recordResponseDiagnostic(diagnostic);
      const usage = envelope?.usage;
      if (!this.captureUsage(usage)) this.attemptsWithoutUsage += 1;
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      this.circuitBreaker.onFailure(isBreakerTrippingFailure(category));
      throw new LlmTransportError(
        `OpenRouter responded ${response.status}`,
        category,
        {
          status: response.status,
          retryAfterMs,
          ...diagnostic,
          latencyMs: Date.now() - startedAt,
        },
      );
    }

    let bodyText = "";
    let json: unknown;
    try {
      bodyText = await this.readBodyWithDeadline(
        response,
        controller,
        timeoutMs - (Date.now() - startedAt),
      );
      json = JSON.parse(bodyText);
    } catch (cause) {
      const category = controller.signal.aborted
        ? "timeout"
        : "invalidEnvelope";
      this.recordOutcome(category, stage);
      this.attemptsWithoutUsage += 1;
      // A content/response-shape problem, not evidence the provider is
      // down (docs/audit PR-009) — see isBreakerTrippingFailure.
      this.circuitBreaker.onFailure(isBreakerTrippingFailure(category));
      // Do not log the body: it can contain partial model output derived
      // from posting/profile data. Shape and size are sufficient here.
      if (category === "invalidEnvelope" && bodyText) {
        logger.debug(
          `Malformed OpenRouter response body (200, unparsable JSON, ${bodyText.length} chars)`,
        );
      }
      throw new LlmTransportError(
        category === "timeout"
          ? "OpenRouter response body timed out"
          : "Malformed OpenRouter response body",
        category,
        { cause, latencyMs: Date.now() - startedAt },
      );
    }

    const rawUsage =
      json !== null && typeof json === "object"
        ? (json as { usage?: unknown }).usage
        : undefined;
    const hasUsage = this.captureUsage(rawUsage);
    const parsed = ChatCompletionResponseSchema.safeParse(json);
    // Captured before the shape check below, deliberately — a response that
    // is a valid chat-completion envelope but fails Stage A/B's own schema
    // one layer up still spent real usage, and this is the one place that
    // usage is ever visible (REMEDIATION_PLAN.md AC-015: "persistir usage
    // retornado pelo provider mesmo quando o conteúdo falhar posteriormente
    // no schema Stage A/B").
    if (!hasUsage) this.attemptsWithoutUsage += 1;

    if (!parsed.success) {
      this.recordOutcome("invalidOutput", stage);
      this.circuitBreaker.onFailure(isBreakerTrippingFailure("invalidOutput"));
      logger.debug(
        "Unexpected OpenRouter response shape (200, invalid completion envelope)",
      );
      throw new LlmTransportError(
        "Unexpected OpenRouter response shape",
        "invalidOutput",
        { latencyMs: Date.now() - startedAt },
      );
    }

    const firstChoice = parsed.data.choices?.[0];
    const providerError = firstChoice?.error ?? parsed.data.error;
    const diagnostic = responseDiagnostic(parsed.data, response, providerError);
    this.recordResponseDiagnostic(diagnostic);

    if (providerError || firstChoice?.finish_reason === "error") {
      const category = classifyErrorType(
        diagnostic.errorType,
        numericErrorCode(providerError) ?? 502,
      );
      this.recordOutcome(category, stage);
      this.circuitBreaker.onFailure(isBreakerTrippingFailure(category));
      logger.debug(
        `OpenRouter in-band error (HTTP 200): ${JSON.stringify({ category, ...diagnostic, hasUsage })}`,
      );
      throw new LlmTransportError(
        `OpenRouter generation failed (${diagnostic.errorType ?? category})`,
        category,
        {
          status: response.status,
          ...diagnostic,
          latencyMs: Date.now() - startedAt,
        },
      );
    }

    const content = firstChoice?.message?.content;
    if (typeof content !== "string") {
      this.recordOutcome("invalidOutput", stage);
      // Same reasoning as invalidEnvelope above (docs/audit PR-009): a
      // content-filtered or empty-choices response is a fact about this
      // one call, not the provider as a whole.
      this.circuitBreaker.onFailure(isBreakerTrippingFailure("invalidOutput"));
      logger.debug(
        `Unexpected OpenRouter response shape (200, no string content): ${JSON.stringify(diagnostic)}`,
      );
      throw new LlmTransportError(
        "Unexpected OpenRouter response shape",
        "invalidOutput",
        { ...diagnostic, latencyMs: Date.now() - startedAt },
      );
    }

    this.calls += 1;
    this.recordOutcome("success", stage);
    this.circuitBreaker.onSuccess();

    return content;
  }
}

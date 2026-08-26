import { createHash, randomUUID } from "node:crypto";
import { Digest } from "../domain/digest";
import { DeliveryCheckpointPort } from "../domain/ports/delivery-checkpoint.port";
import { NotifierPort, NotifyResult } from "../domain/ports/notifier.port";
import { renderDigestText } from "../domain/render-digest";
import { TelegramConfig } from "./telegram-config";

/** Telegram's hard limit on a single `sendMessage` call's `text` field. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Telegram rate-limits a single chat to roughly one message per second
 * (docs/11-known-issues.md B3) — this pause between consecutive chunk sends
 * is what keeps a large digest from tripping that limit in the first place,
 * distinct from the 429 retry below, which handles it if it happens anyway.
 */
const DEFAULT_PACING_MS = 1_100;
/** Bounded — an unbounded retry loop on a persistently rate-limited chat
 * would never finish, and ADR-007's "notified only after a successful send"
 * rule already means an exhausted chunk just re-sends the whole digest next
 * run rather than losing it (docs/11 B3). */
const DEFAULT_MAX_RETRIES = 3;
/** Defensive cap on how long a single `retry_after` wait is allowed to
 * sleep, regardless of what Telegram states — a malformed or unexpectedly
 * large value must not stall a run indefinitely. */
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;
/** Used when a 429 response carries no parseable `retry_after` at all —
 * conservative rather than zero, since the whole point is backing off. */
const DEFAULT_RETRY_AFTER_MS = 5_000;
/** Explicit per-request timeout (docs/audit AC-022) — without one, a
 * request that never resolves (a hung TCP connection, not an HTTP error
 * Telegram itself returns) could hold the delivery run's `RunLock` open
 * indefinitely, blocking every later scheduled run behind it. Same
 * AbortController pattern `GupyCollector`/`OpenRouterClient` already use. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Telegram responses are tiny. Bounding them prevents a broken or hostile
 * upstream from turning acknowledgement parsing into unbounded memory use. */
export const DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES = 64 * 1024;

export interface TelegramNotifierOptions {
  readonly pacingMs?: number;
  readonly maxRetries?: number;
  readonly retryAfterCapMs?: number;
  readonly transportRetryBaseMs?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly deliveryStore?: DeliveryCheckpointPort;
  readonly deliveryLeaseMs?: number;
  readonly now?: () => Date;
}

/** Base for the exponential backoff between transport retries (ADR-065).
 * Short on purpose: this covers a connection that never opened, and the run
 * holding the `RunLock` is waiting on it. */
const DEFAULT_TRANSPORT_RETRY_BASE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Node/undici error codes for a failure that happened *before* any request
 * byte could reach Telegram: the name never resolved, or the connection was
 * refused or had nowhere to go. A message cannot have been delivered over a
 * connection that was never established, so this is the one class of
 * transport failure that is safe to retry and safe to declare undelivered.
 *
 * Codes that mean the connection existed and then broke — `ECONNRESET`,
 * `EPIPE`, `ETIMEDOUT` — are deliberately absent: the request may have been
 * fully sent and acknowledged before the socket died, which is exactly the
 * `uncertain` case this list must not swallow.
 */
const NEVER_SENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);

/**
 * Whether a thrown `fetch` failure proves the message was never delivered.
 *
 * `fetch` reports connection failures as a `TypeError: fetch failed` whose
 * `cause` carries the real `code`, sometimes nested another level down, so
 * this walks the cause chain rather than reading one property. An
 * `AbortError` — this client's own timeout firing — is explicitly *not*
 * proof of anything: the request may well have arrived and been processed
 * while the response was still in flight, and treating that as undelivered
 * is how a digest gets sent twice (ADR-065).
 */
function isCertainlyUndelivered(cause: unknown): boolean {
  for (let current = cause, depth = 0; current != null && depth < 5; depth++) {
    const error = current as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return false;
    }
    if (
      typeof error.code === "string" &&
      NEVER_SENT_ERROR_CODES.has(error.code)
    ) {
      return true;
    }
    current = error.cause;
  }
  return false;
}

/**
 * Telegram's actual 429 body shape:
 * `{"ok":false,"error_code":429,"description":"...","parameters":{"retry_after":5}}`
 * (`retry_after` in seconds). Null on anything unparseable — the caller
 * falls back to `DEFAULT_RETRY_AFTER_MS` rather than guessing.
 */
function parseRetryAfterMs(bodyText: string): number | null {
  try {
    const body: unknown = JSON.parse(bodyText);
    const seconds = (body as { parameters?: { retry_after?: unknown } } | null)
      ?.parameters?.retry_after;
    return typeof seconds === "number" && seconds >= 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The plain-text-send capability, factored out so a caller (M10's
 * `executeStudyPlan`) can depend on "something that can send text" and be
 * given a fake in tests, without depending on the concrete `TelegramNotifier`
 * class or widening `NotifierPort` itself — that port's one method is
 * shaped around a `Digest`, and a study plan is not one, same reasoning
 * `sendText`'s own doc comment already gives.
 */
export interface TextNotifier {
  sendText(text: string): Promise<NotifyResult>;
}

const SECTION_SEPARATOR = "\n\n---\n\n";
const ENTRY_SEPARATOR = "\n\n";

/**
 * Greedily packs `parts` into chunks joined by `separator`, each no longer
 * than `limit`. A part that alone exceeds `limit` is passed through
 * unsplit — the caller is expected to have already tried splitting it more
 * finely before falling back to this.
 */
function pack(
  parts: readonly string[],
  separator: string,
  limit: number,
): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? `${current}${separator}${part}` : part;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Last-resort split for one pathological entry with no useful separators.
 * Iterating code points avoids cutting a UTF-16 surrogate pair in half. */
function splitAtomicPart(part: string, limit: number): string[] {
  if (part.length <= limit) return [part];
  const chunks: string[] = [];
  let current = "";
  for (const symbol of part) {
    if (current && current.length + symbol.length > limit) {
      chunks.push(current);
      current = "";
    }
    current += symbol;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits a rendered digest into `sendMessage`-sized chunks. Splits on
 * section boundaries first; a single section that alone exceeds the limit
 * (not expected at M6's posting volumes) is split further on its entry
 * boundaries instead of being sent oversized and rejected by Telegram.
 */
export function splitForTelegram(
  text: string,
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new Error("Telegram message limit must be an integer >= 2");
  }
  const sections = text.split(SECTION_SEPARATOR);
  const oversized = sections.some((section) => section.length > limit);
  if (!oversized) return pack(sections, SECTION_SEPARATOR, limit);

  const finer = sections.flatMap((section) => {
    const entries =
      section.length > limit ? section.split(ENTRY_SEPARATOR) : [section];
    return entries.flatMap((entry) => splitAtomicPart(entry, limit));
  });
  return pack(finer, ENTRY_SEPARATOR, limit);
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Telegram response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * A direct, dumb Telegram client (docs/02-architecture.md) — no framework,
 * no agent, no dependency on anything else running. Failure is returned as a
 * value, never thrown, matching CollectorPort and ScorerPort (principle 1):
 * a delivery failure must not crash the caller, which decides whether to
 * retry.
 */
export class TelegramNotifier implements NotifierPort, TextNotifier {
  private readonly pacingMs: number;
  private readonly maxRetries: number;
  private readonly retryAfterCapMs: number;
  private readonly transportRetryBaseMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly deliveryStore: DeliveryCheckpointPort | undefined;
  private readonly deliveryLeaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    options: TelegramNotifierOptions = {},
  ) {
    this.pacingMs = options.pacingMs ?? DEFAULT_PACING_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryAfterCapMs =
      options.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
    this.transportRetryBaseMs =
      options.transportRetryBaseMs ?? DEFAULT_TRANSPORT_RETRY_BASE_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_TELEGRAM_MAX_RESPONSE_BYTES;
    this.deliveryStore = options.deliveryStore;
    this.deliveryLeaseMs = options.deliveryLeaseMs ?? 30 * 60_000;
    this.now = options.now ?? (() => new Date());
    for (const [name, value] of [
      ["pacingMs", this.pacingMs],
      ["maxRetries", this.maxRetries],
      ["retryAfterCapMs", this.retryAfterCapMs],
      ["transportRetryBaseMs", this.transportRetryBaseMs],
      ["timeoutMs", this.timeoutMs],
      ["maxResponseBytes", this.maxResponseBytes],
      ["deliveryLeaseMs", this.deliveryLeaseMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Telegram ${name} must be a non-negative number`);
      }
    }
    if (this.timeoutMs === 0 || this.maxResponseBytes === 0) {
      throw new Error(
        "Telegram timeoutMs and maxResponseBytes must be positive",
      );
    }
  }

  async notify(digest: Digest): Promise<NotifyResult> {
    const text = renderDigestText(digest);
    const chunks = splitForTelegram(text);
    if (!this.deliveryStore) return this.sendChunks(chunks);

    const contentHash = createHash("sha256").update(text).digest("hex");
    const channelKey = createHash("sha256")
      .update(`telegram:${this.config.chatId}`)
      .digest("hex");
    let prepared;
    try {
      prepared = this.deliveryStore.prepare(
        channelKey,
        contentHash,
        chunks,
        this.now(),
      );
    } catch (cause) {
      return {
        ok: false,
        error: {
          message: "Could not prepare durable Telegram delivery",
          cause,
        },
      };
    }
    if (prepared.chunks.every((chunk) => chunk.state === "confirmed")) {
      // A process can crash after confirming the final chunk and before
      // closing the operation. The transport work is already complete; make
      // the persisted operation agree and clear any abandoned lease.
      this.deliveryStore.complete(prepared.operationId, this.now());
      return { ok: true };
    }
    if (
      prepared.chunks.some(
        (chunk) => chunk.state === "sending" || chunk.state === "uncertain",
      )
    ) {
      return {
        ok: false,
        error: {
          message:
            `Telegram delivery ${prepared.operationId} has an uncertain chunk; ` +
            "reconcile it before retrying",
        },
      };
    }

    const owner = randomUUID();
    if (
      !this.deliveryStore.claim(
        prepared.operationId,
        owner,
        this.now(),
        this.deliveryLeaseMs,
      )
    ) {
      return {
        ok: false,
        error: {
          message: `Telegram delivery ${prepared.operationId} is already owned by another worker`,
        },
      };
    }

    let sentThisAttempt = 0;
    try {
      for (const chunk of prepared.chunks) {
        if (chunk.state === "confirmed") continue;
        if (sentThisAttempt > 0) await sleep(this.pacingMs);
        // Refresh the lease before every potentially slow network call. A
        // large digest must not become claimable halfway through delivery.
        if (
          !this.deliveryStore.claim(
            prepared.operationId,
            owner,
            this.now(),
            this.deliveryLeaseMs,
          )
        ) {
          return {
            ok: false,
            error: {
              message: `Telegram delivery ${prepared.operationId} ownership was lost`,
            },
          };
        }
        this.deliveryStore.startChunk(
          prepared.operationId,
          chunk.index,
          this.now(),
        );
        const result = await this.sendMessageDetailed(chunk.body);
        if (!result.ok) {
          if (result.uncertain) {
            this.deliveryStore.markChunkUncertain(
              prepared.operationId,
              chunk.index,
              result.error.message,
              this.now(),
            );
          } else {
            this.deliveryStore.failChunk(
              prepared.operationId,
              chunk.index,
              result.error.message,
              this.now(),
            );
          }
          return {
            ok: false,
            error: {
              message:
                `Telegram delivery ${prepared.operationId} chunk ${chunk.index} failed: ` +
                result.error.message,
              ...(result.error.cause === undefined
                ? {}
                : { cause: result.error.cause }),
            },
          };
        }
        this.deliveryStore.confirmChunk(
          prepared.operationId,
          chunk.index,
          result.messageId,
          this.now(),
        );
        sentThisAttempt += 1;
      }
      this.deliveryStore.complete(prepared.operationId, this.now());
      return { ok: true };
    } finally {
      this.deliveryStore.release(prepared.operationId, owner, this.now());
    }
  }

  /**
   * Plain-text send, for the M8 scheduler's alerts (`docs/08-observability.md`)
   * — delivered through this same client rather than a separate channel, so
   * there is nothing extra to configure or keep alive. Not part of
   * `NotifierPort`: that port's one method is shaped around a `Digest`, and
   * an alert is not one — this is a sibling capability of the concrete
   * Telegram client, not a new abstraction.
   */
  async sendText(text: string): Promise<NotifyResult> {
    return this.sendChunks(splitForTelegram(text));
  }

  /**
   * Paced per docs/11-known-issues.md B3: a pause before every chunk after
   * the first, not only on failure — the point is staying under Telegram's
   * rate limit in the first place, not just recovering after tripping it.
   */
  private async sendChunks(chunks: readonly string[]): Promise<NotifyResult> {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(this.pacingMs);
      const result = await this.sendMessage(chunks[i]!);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private async sendMessage(text: string): Promise<NotifyResult> {
    const result = await this.sendMessageDetailed(text);
    return result.ok ? { ok: true } : result;
  }

  private async sendMessageDetailed(text: string): Promise<
    | { readonly ok: true; readonly messageId: number | null }
    | {
        readonly ok: false;
        readonly error: { readonly message: string; readonly cause?: unknown };
        readonly uncertain: boolean;
      }
  > {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      let bodyText = "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.chatId, text }),
          signal: controller.signal,
        });
        if (response.ok || response.status === 429) {
          bodyText = await readBoundedBody(
            response,
            this.maxResponseBytes,
            controller.signal,
          );
        }
      } catch (cause) {
        // ADR-065. Every thrown `fetch` failure used to land here as
        // `uncertain: true`, which blocked the retry path entirely
        // (`sendDurable` refuses to re-send an operation holding an
        // uncertain chunk) and required a manual reconcile that, in
        // practice, nobody performs at 03:00. A digest carrying a
        // 100%-match posting was delayed a full day this way on
        // 2026-08-25.
        //
        // A connection that never opened is different in kind: the message
        // provably did not arrive, so retrying cannot duplicate it.
        if (isCertainlyUndelivered(cause)) {
          if (attempt < this.maxRetries) {
            await sleep(this.transportRetryBaseMs * 2 ** attempt);
            continue;
          }
          // Retries exhausted, but still provably undelivered — `failed`,
          // not `uncertain`, so the next run re-sends rather than halting
          // on a chunk no human will ever reconcile.
          return {
            ok: false,
            error: { message: "Telegram request failed", cause },
            uncertain: false,
          };
        }
        // A timeout, or a connection that broke mid-flight: the request may
        // have been received. Unchanged behaviour, and deliberately so.
        return {
          ok: false,
          error: { message: "Telegram request failed", cause },
          uncertain: true,
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        const retryAfterMs =
          parseRetryAfterMs(bodyText) ?? DEFAULT_RETRY_AFTER_MS;
        if (attempt < this.maxRetries) {
          await sleep(Math.min(retryAfterMs, this.retryAfterCapMs));
          continue;
        }
        return {
          ok: false,
          error: {
            message: `Telegram request failed: 429, exhausted ${this.maxRetries} retries`,
          },
          uncertain: false,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          error: {
            // Do not echo a third-party body into logs/alerts. It is not
            // needed to classify the failure and may contain user content.
            message: `Telegram request failed: ${response.status}`,
          },
          uncertain: response.status >= 500,
        };
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch (cause) {
        return {
          ok: false,
          error: {
            message: "Telegram returned an invalid success body",
            cause,
          },
          uncertain: true,
        };
      }
      if (
        body === null ||
        typeof body !== "object" ||
        (body as { ok?: unknown }).ok !== true
      ) {
        return {
          ok: false,
          error: {
            message: "Telegram returned ok:false in a success response",
          },
          uncertain: true,
        };
      }
      const messageId = (body as { result?: { message_id?: unknown } }).result
        ?.message_id;
      if (!Number.isInteger(messageId)) {
        return {
          ok: false,
          error: {
            message: "Telegram success response omitted a valid message_id",
          },
          uncertain: true,
        };
      }
      return {
        ok: true,
        messageId: messageId as number,
      };
    }

    // Unreachable — the loop above always returns before exhausting its
    // bound (the 429 branch returns once attempt === maxRetries). Kept for
    // TypeScript's control-flow analysis, not a real code path.
    return {
      ok: false,
      error: { message: "Telegram request failed: exhausted retries" },
      uncertain: false,
    };
  }
}

/**
 * The one HTTP-fetch-with-retries every collector uses (CLAUDE.md §6's
 * "polite collector behavior": explicit timeout, exponential backoff, honest
 * `User-Agent`).
 *
 * Extracted because all five collectors carried a byte-identical copy of it,
 * differing only in the source name inside one error message — and therefore
 * carried the same two defects five times over.
 *
 * **The deadline used to end at the response headers.** Each copy cleared its
 * `AbortController` timer in a `finally` that runs the moment `fetch`
 * resolves, then handed the caller a `Response` whose body was read
 * afterwards with no deadline of its own:
 *
 * ```ts
 * const response = await this.fetchWithBackoff(url); // timer already cleared
 * body = await response.json();                      // unbounded
 * ```
 *
 * A source that sends headers and then stalls the body therefore ignored the
 * configured 10–20s bound entirely and fell back to undici's default 300s
 * `bodyTimeout` — per request, per retry. NerdIn and InfoJobs fetch one
 * detail page per card, so a stalled source could consume the whole 4h
 * collection window and leave the `RunLock` held behind it. Reading the body
 * inside the same deadline is the fix, and it also means a body-read failure
 * is now retried like any other transport failure instead of aborting the
 * page outright.
 *
 * **There was no size bound at all.** `TelegramNotifier` has
 * `readBoundedBody`; the collectors had nothing, so a broken or hostile
 * upstream turned `.text()` into unbounded memory on a box shared with four
 * other services (CLAUDE.md §5). `DEFAULT_MAX_RESPONSE_BYTES` is measured,
 * not guessed: the largest real bodies observed on 2026-08-29 are Gupy at
 * `limit=100` (302 KB) and NerdIn's listing HTML (221 KB), so 8 MB is ~26×
 * the worst real case — generous enough that no legitimate response is at
 * risk, small enough to bound the failure.
 */

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Thrown when a response exceeds `maxResponseBytes`. Deliberately not
 * retried: the size is a property of the response, so a second attempt
 * produces the same one. */
export class ResponseTooLargeError extends Error {
  constructor(source: string, maxBytes: number) {
    super(`${source} response exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export interface FetchedBody {
  readonly ok: boolean;
  readonly status: number;
  /** Carried through because four collectors already print it alongside the
   * status in their `CollectionResult.error.message`. */
  readonly statusText: string;
  /** The full response body as text. Callers parse it themselves —
   * `JSON.parse` for a JSON endpoint, an HTML pass for a scrape — because
   * `Response.json()` would have to run outside the deadline this function
   * exists to hold. */
  readonly body: string;
}

export interface FetchWithDeadlineOptions {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly backoffDelaysMs: readonly number[];
  readonly userAgent: string;
  /** Names the source in error messages ("Gupy responded 503"). */
  readonly source: string;
  readonly maxResponseBytes?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the whole body as text under `signal`, refusing anything over
 * `maxBytes`.
 *
 * The abort is raced explicitly rather than relied on through the stream:
 * `signal` aborting mid-body does surface on `reader.read()`, but only once
 * the underlying socket notices, which is precisely what a stalled peer
 * prevents.
 */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  source: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });

  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ResponseTooLargeError(source, maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
    // Free the socket rather than leaving a half-drained body pinned to the
    // connection pool — this path is reached on every abort and size refusal.
    await response.body.cancel().catch(() => undefined);
  }
}

/**
 * Fetches `url` and returns its body, retrying transient failures with the
 * caller's backoff schedule.
 *
 * Retried: a thrown `fetch` failure (network, DNS, timeout) and a 5xx.
 * Returned as-is: any status below 500, including a 4xx — the request itself
 * is wrong, and repeating it wastes the source's time for no different
 * outcome. Never retried: `ResponseTooLargeError`, which is deterministic.
 *
 * Throws the last error when the schedule is exhausted, matching what every
 * collector's own copy did. Each collector already wraps this in the
 * `CollectionResult`-returning contract `CollectorPort` requires (principle
 * 1) — this function is below that boundary, not at it.
 */
export async function fetchWithDeadline(
  url: string,
  options: FetchWithDeadlineOptions,
): Promise<FetchedBody> {
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.backoffDelaysMs.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetchImpl(url, {
        headers: { "User-Agent": options.userAgent },
        signal: controller.signal,
      });
      if (response.ok || response.status < 500) {
        // Still inside the deadline, which is the whole point: the timer is
        // cleared by the `finally` only after this resolves.
        const body = await readBoundedText(
          response,
          maxResponseBytes,
          controller.signal,
          options.source,
        );
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          body,
        };
      }
      // A 5xx body is not read: it is not the payload, and draining it would
      // spend the deadline on something no caller looks at.
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`${options.source} responded ${response.status}`);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    const delay = options.backoffDelaysMs[attempt];
    if (delay !== undefined) await sleep(delay);
  }

  throw lastError;
}

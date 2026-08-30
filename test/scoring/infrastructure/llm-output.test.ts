import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  normalizeModelOutput,
  parseModelOutputWithRetries,
} from "../../../src/scoring/infrastructure/llm-output";
import { LlmTransportError } from "../../../src/scoring/infrastructure/openrouter-client";

const Schema = z.object({
  status: z.enum(["met", "partial", "not_met"]),
});

describe("normalizeModelOutput", () => {
  it("passes through already-clean JSON unchanged", () => {
    expect(normalizeModelOutput('{"status":"met"}')).toBe('{"status":"met"}');
  });

  it("strips a markdown fence with a json language tag", () => {
    const raw = '```json\n{"status":"met"}\n```';
    expect(normalizeModelOutput(raw)).toBe('{"status":"met"}');
  });

  it("strips a bare markdown fence with no language tag", () => {
    const raw = '```\n{"status":"met"}\n```';
    expect(normalizeModelOutput(raw)).toBe('{"status":"met"}');
  });

  it("trims prose surrounding the JSON object", () => {
    const raw = 'Here is the result:\n{"status":"met"}\nHope that helps!';
    expect(normalizeModelOutput(raw)).toBe('{"status":"met"}');
  });

  it("trims to the outermost array when the JSON is a list", () => {
    const raw = 'Sure, here you go: [{"status":"met"}] — done.';
    expect(normalizeModelOutput(raw)).toBe('[{"status":"met"}]');
  });

  it("returns the trimmed input unchanged when no bracket is found", () => {
    expect(normalizeModelOutput("  not json at all  ")).toBe("not json at all");
  });
});

describe("parseModelOutputWithRetries — success", () => {
  it("returns the parsed data on the first valid attempt", async () => {
    const ask = vi.fn(async () => '{"status":"met"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt");

    expect(result).toEqual({ ok: true, data: { status: "met" }, attempts: 1 });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("recovers on the second attempt after a truncated first response", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status": "met"')
      .mockResolvedValueOnce('{"status":"partial"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("partial");
      expect(result.attempts).toBe(2);
    }
  });

  it("recovers from an invented enum value on retry", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"probably"}')
      .mockResolvedValueOnce('{"status":"met"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
  });

  it("feeds the validation error back into the retry prompt", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"probably"}')
      .mockResolvedValueOnce('{"status":"met"}');
    await parseModelOutputWithRetries(Schema, ask, "original prompt");

    const secondCallPrompt = ask.mock.calls[1]?.[0] as string;
    expect(secondCallPrompt).toContain("original prompt");
    expect(secondCallPrompt).toContain("invalid");
  });
});

describe("parseModelOutputWithRetries — exhausted retries, never throws", () => {
  it("returns ok:false after maxRepairAttempts on truncated JSON that never parses", async () => {
    const ask = vi.fn(async () => '{"status": "met"');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", {
      maxRepairAttempts: 3,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_output");
      expect(result.attempts).toBe(3);
      expect(result.lastError).toContain("not valid JSON");
    }
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("returns ok:false after maxRepairAttempts when the model repeats the same invalid enum", async () => {
    const ask = vi.fn(async () => '{"status":"maybe"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", {
      maxRepairAttempts: 3,
    });

    expect(result.ok).toBe(false);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("treats a rejected ask() call as a failed attempt rather than throwing, and retries it", async () => {
    vi.useFakeTimers();
    try {
      const ask = vi
        .fn()
        .mockRejectedValueOnce(new Error("network unreachable"))
        .mockResolvedValueOnce('{"status":"met"}');

      const promise = parseModelOutputWithRetries(Schema, ask, "prompt");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exhausts the transport budget and returns ok:false when ask() always rejects", async () => {
    vi.useFakeTimers();
    try {
      const ask = vi.fn().mockRejectedValue(new Error("timeout"));
      const promise = parseModelOutputWithRetries(Schema, ask, "prompt", {
        maxTransportAttempts: 2,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("transport_failed");
        expect(result.lastError).toContain("timeout");
      }
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves safe provider diagnostics when transport retries are exhausted", async () => {
    const ask = vi.fn().mockRejectedValue(
      new LlmTransportError("provider failed", "providerError", {
        errorType: "provider_unavailable",
        provider: "Chutes",
        model: "deepseek/test",
        finishReason: "error",
        generationId: "gen-1",
        status: 200,
        latencyMs: 42,
      }),
    );
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", {
      maxTransportAttempts: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "transport_failed",
      diagnostic: {
        kind: "transport_failed",
        category: "providerError",
        errorType: "provider_unavailable",
        provider: "Chutes",
        model: "deepseek/test",
        finishReason: "error",
        generationId: "gen-1",
        httpStatus: 200,
        lastAttemptLatencyMs: 42,
      },
    });
  });

  it("respects a custom maxRepairAttempts", async () => {
    const ask = vi.fn(async () => "not json");
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", {
      maxRepairAttempts: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempts).toBe(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeModelOutput picks the delimiter that actually parses", () => {
  it("finds JSON preceded by prose containing a bracket", () => {
    // A real Stage A shape. Taking the earliest delimiter unconditionally
    // sliced from the `[` in the prose, producing text that could never
    // parse — and each occurrence burned the whole 3-attempt repair budget
    // before landing the posting in the review section as invalid_output.
    const raw =
      'Analisando os requisitos [ver lista], segue o JSON:\n{"requirements":[{"text":"a"}]}';
    expect(normalizeModelOutput(raw)).toBe('{"requirements":[{"text":"a"}]}');
  });

  it("finds JSON preceded by prose containing a brace", () => {
    const raw = 'Formato {chave: valor}. Resposta:\n[{"text":"a"}]';
    expect(normalizeModelOutput(raw)).toBe('[{"text":"a"}]');
  });

  it("still returns a genuine top-level array unchanged", () => {
    expect(normalizeModelOutput('[{"a":1}]')).toBe('[{"a":1}]');
    expect(normalizeModelOutput("Segue: [1,2,3]")).toBe("[1,2,3]");
  });

  it("still strips fences around a plain object", () => {
    expect(normalizeModelOutput('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("falls back to the first candidate when neither parses", () => {
    // Unchanged behaviour: let JSON.parse fail downstream, where the failure
    // is classified and retried.
    expect(normalizeModelOutput("{nao e json")).toBe("{nao e json");
  });
});

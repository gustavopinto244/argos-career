import { describe, expect, it } from "vitest";
import { percentageOf } from "../../../src/market/domain/percentage";

describe("percentageOf", () => {
  it("returns 0-100, not 0-1 — the whole point of ADR-078 Amendment 1", () => {
    // The defect this replaces: 3 of 20 was stored as 0.15 under a field
    // named `percentage`, so an MCP consumer reading it as a percentage was
    // wrong by 100×.
    expect(percentageOf(3, 20)).toBe(15);
  });

  it("gives 100 for a share of the whole, not 1", () => {
    expect(percentageOf(7, 7)).toBe(100);
  });

  it("rounds to one decimal place rather than carrying float noise", () => {
    // 1/63 is 1.5873015873015872 exactly — unreadable in a payload a
    // person opens, and recoverable from `count` and the denominator that
    // ship beside it.
    expect(percentageOf(1, 63)).toBe(1.6);
    expect(percentageOf(2, 3)).toBe(66.7);
    expect(percentageOf(1, 3)).toBe(33.3);
  });

  it("returns 0 for an empty denominator instead of NaN", () => {
    expect(percentageOf(0, 0)).toBe(0);
    expect(percentageOf(5, 0)).toBe(0);
  });

  it("returns 0 for a zero numerator", () => {
    expect(percentageOf(0, 40)).toBe(0);
  });
});

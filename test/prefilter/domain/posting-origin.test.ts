import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import {
  isNationalPosting,
  partitionByOrigin,
} from "../../../src/prefilter/domain/posting-origin";

const NOW = new Date("2026-08-26T12:00:00Z");

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "remote",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    homeCountry: "BR",
    sourceDefaultCountry: { gupy: "BR", ciee: "BR" },
    ...overrides,
  } as Criteria;
}

describe("isNationalPosting (ADR-068)", () => {
  it("trusts the posting's own country over the source default", () => {
    // A source fact beats an assumption about the source — the whole reason
    // `country` was added rather than deriving nationality from `source`.
    expect(
      isNationalPosting(posting({ source: "gupy", country: "US" }), criteria()),
    ).toBe(false);
    expect(
      isNationalPosting(posting({ source: "gupy", country: "BR" }), criteria()),
    ).toBe(true);
  });

  it("falls back to the source's country when the posting states none", () => {
    // The case that covers the entire existing corpus: Brazilian platforms
    // that publish no country at all.
    expect(isNationalPosting(posting({ country: null }), criteria())).toBe(
      true,
    );
  });

  it("treats a wholly unknown origin as international, not national", () => {
    // The conservative direction: an unplaceable posting competes for the
    // capped budget rather than consuming the uncapped one.
    expect(
      isNationalPosting(
        posting({ source: "unlisted-source", country: null }),
        criteria(),
      ),
    ).toBe(false);
  });

  it("compares case- and whitespace-insensitively on both sides", () => {
    expect(isNationalPosting(posting({ country: " br " }), criteria())).toBe(
      true,
    );
    expect(
      isNationalPosting(
        posting({ source: "x", country: null }),
        criteria({ sourceDefaultCountry: { x: "br" }, homeCountry: "BR" }),
      ),
    ).toBe(true);
  });

  it("ignores a country the domain could not normalize", () => {
    // `createPosting` turns "Brazil" into null rather than guessing "BR",
    // so this posting is placed by its source, not by its unusable string.
    const stored = posting({ country: "Brazil" });
    expect(stored.country).toBeNull();
    expect(isNationalPosting(stored, criteria())).toBe(true);
  });
});

describe("partitionByOrigin (ADR-068)", () => {
  it("splits the two buckets and preserves input order within each", () => {
    const a = posting({ sourceId: "a", country: "BR" });
    const b = posting({ sourceId: "b", country: "US" });
    const c = posting({ sourceId: "c", country: "BR" });
    const d = posting({ sourceId: "d", country: "PT" });

    const { national, international } = partitionByOrigin(
      [a, b, c, d],
      criteria(),
    );

    expect(national.map((p) => p.sourceId)).toEqual(["a", "c"]);
    expect(international.map((p) => p.sourceId)).toEqual(["b", "d"]);
  });

  it("handles an all-national corpus, which is production today", () => {
    const { national, international } = partitionByOrigin(
      [posting({ sourceId: "a" }), posting({ sourceId: "b" })],
      criteria(),
    );
    expect(national).toHaveLength(2);
    expect(international).toEqual([]);
  });
});

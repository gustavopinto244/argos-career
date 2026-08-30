import { describe, expect, it } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { Criteria } from "../../../src/prefilter/domain/criteria";
import { rankForScoring } from "../../../src/prefilter/domain/rank-for-scoring";

const NOW = new Date("2026-08-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "remote",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

function criteria(): Criteria {
  return {
    // Production's real value (`config/criteria.yaml`, ADR-066). Omitting it
    // used to leave the still-listed key `NaN`, which silently disabled the
    // primary sort and let the ADR-066 test below pass for the wrong reason.
    stillListedWithinHours: 30,
    tracks: {
      dev: ["backend"],
      security: ["segurança"],
      automation: ["suporte"],
      data: ["dados"],
    },
    trackExclusions: { dev: [], security: [], automation: [], data: [] },
    trackWeights: {
      dev: 1.0,
      security: 1.0,
      automation: 0.7,
      data: 0.7,
      unknown: 0.4,
    },
  } as unknown as Criteria;
}

describe("rankForScoring (ADR-068)", () => {
  it("puts the most recent posting first", () => {
    const old = posting({
      sourceId: "old",
      publishedAt: daysAgo(10),
      lastSeenAt: daysAgo(10),
    });
    const fresh = posting({
      sourceId: "fresh",
      publishedAt: daysAgo(1),
      lastSeenAt: daysAgo(1),
    });

    expect(
      rankForScoring([old, fresh], criteria(), NOW).map((p) => p.sourceId),
    ).toEqual(["fresh", "old"]);
  });

  it("uses firstSeenAt when the source states no publishedAt", () => {
    // The same fallback `isTooOld` uses — an undated posting must not sort
    // as if it had no age at all.
    const undatedOld = posting({
      sourceId: "undated-old",
      publishedAt: null,
      firstSeenAt: daysAgo(9),
      lastSeenAt: daysAgo(9),
    });
    const undatedNew = posting({
      sourceId: "undated-new",
      publishedAt: null,
      firstSeenAt: daysAgo(2),
      lastSeenAt: daysAgo(2),
    });

    expect(
      rankForScoring([undatedOld, undatedNew], criteria(), NOW).map(
        (p) => p.sourceId,
      ),
    ).toEqual(["undated-new", "undated-old"]);
  });

  it("breaks a same-day tie by track weight, dev before automation", () => {
    const support = posting({
      sourceId: "support",
      title: "Estágio em Suporte",
      publishedAt: daysAgo(1),
    });
    const dev = posting({
      sourceId: "dev",
      title: "Estágio em Backend",
      publishedAt: daysAgo(1),
    });

    expect(
      rankForScoring([support, dev], criteria(), NOW).map((p) => p.sourceId),
    ).toEqual(["dev", "support"]);
  });

  it("does not let track weight override recency", () => {
    // A perfectly-matched but stale posting is still a probably-closed one.
    const staleDev = posting({
      sourceId: "stale-dev",
      title: "Estágio em Backend",
      publishedAt: daysAgo(10),
      lastSeenAt: daysAgo(10),
    });
    const freshSupport = posting({
      sourceId: "fresh-support",
      title: "Estágio em Suporte",
      publishedAt: daysAgo(1),
      lastSeenAt: daysAgo(1),
    });

    expect(
      rankForScoring([staleDev, freshSupport], criteria(), NOW).map(
        (p) => p.sourceId,
      ),
    ).toEqual(["fresh-support", "stale-dev"]);
  });

  it("ranks an unknown-track posting below a classified one on a tie", () => {
    const unknown = posting({
      sourceId: "unknown",
      title: "Estágio em Administrativa",
      publishedAt: daysAgo(1),
    });
    const known = posting({
      sourceId: "known",
      title: "Estágio em Backend",
      publishedAt: daysAgo(1),
    });

    expect(
      rankForScoring([unknown, known], criteria(), NOW).map((p) => p.sourceId),
    ).toEqual(["known", "unknown"]);
  });

  it("is stable and total — equal keys keep their input order", () => {
    const a = posting({ sourceId: "a", publishedAt: daysAgo(1) });
    const b = posting({ sourceId: "b", publishedAt: daysAgo(1) });
    const c = posting({ sourceId: "c", publishedAt: daysAgo(1) });

    expect(
      rankForScoring([a, b, c], criteria(), NOW).map((p) => p.sourceId),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [
      posting({
        sourceId: "old",
        publishedAt: daysAgo(10),
        lastSeenAt: daysAgo(10),
      }),
      posting({ sourceId: "fresh", publishedAt: daysAgo(1) }),
    ];
    rankForScoring(input, criteria(), NOW);
    expect(input.map((p) => p.sourceId)).toEqual(["old", "fresh"]);
  });

  it("returns an empty array unchanged", () => {
    expect(rankForScoring([], criteria(), NOW)).toEqual([]);
  });

  it("ranks a still-listed old posting above a stale newer one (ADR-066)", () => {
    // The inconsistency this fixes: ADR-066 rescues a posting the source is
    // STILL listing, however old its publication date — and ranking on that
    // date alone sent exactly those to the bottom, making them the first
    // casualties of a cancel or the international cap.
    const stillListed = posting({
      sourceId: "still-listed",
      publishedAt: daysAgo(21),
      lastSeenAt: daysAgo(0),
    });
    const goneButNewer = posting({
      sourceId: "gone-but-newer",
      publishedAt: daysAgo(5),
      lastSeenAt: daysAgo(5),
    });

    expect(
      rankForScoring([goneButNewer, stillListed], criteria(), NOW).map(
        (p) => p.sourceId,
      ),
    ).toEqual(["still-listed", "gone-but-newer"]);
  });

  it("orders by publication date among postings sharing one lastSeenAt", () => {
    // The shape production actually produces, which the old key could not
    // order at all: a sweep stamps one `lastSeenAt` across the whole batch
    // (2,091 of 2,768 rows shared a single value), and no row in the real
    // corpus has a publication date later than its last sighting. The old
    // `Math.max(publishedAt ?? firstSeenAt, lastSeenAt)` therefore collapsed
    // to a constant here, and ordering fell through to track weight and then
    // arbitrary input order.
    const sweptAt = daysAgo(0);
    const older = posting({
      sourceId: "older",
      publishedAt: daysAgo(20),
      lastSeenAt: sweptAt,
    });
    const newer = posting({
      sourceId: "newer",
      publishedAt: daysAgo(2),
      lastSeenAt: sweptAt,
    });

    expect(
      rankForScoring([older, newer], criteria(), NOW).map((p) => p.sourceId),
    ).toEqual(["newer", "older"]);
  });

  it("does not bury a source that sweeps less often behind a fresher sighting", () => {
    // Indeed runs on its own twice-daily systemd timer while the rest sweep
    // every 4h (ADR-009). Comparing `lastSeenAt` as a raw timestamp would
    // rank every Indeed posting below an equally-aged one seen more
    // recently; comparing it as ADR-066's window does not, so the newer
    // publication still wins.
    const indeedNewer = posting({
      sourceId: "indeed-newer",
      publishedAt: daysAgo(1),
      lastSeenAt: new Date(NOW.getTime() - 11 * 60 * 60 * 1000),
    });
    const gupyOlder = posting({
      sourceId: "gupy-older",
      publishedAt: daysAgo(9),
      lastSeenAt: NOW,
    });

    expect(
      rankForScoring([gupyOlder, indeedNewer], criteria(), NOW).map(
        (p) => p.sourceId,
      ),
    ).toEqual(["indeed-newer", "gupy-older"]);
  });
});

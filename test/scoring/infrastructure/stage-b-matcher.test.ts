import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  Db,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { MatchesRepository } from "../../../src/persistence/infrastructure/matches-repository";
import { Profile } from "../../../src/profile/domain/profile";
import { hashRequirements } from "../../../src/scoring/domain/requirements-hash";
import { Requirement } from "../../../src/scoring/domain/types";
import { LlmTransportError } from "../../../src/scoring/infrastructure/openrouter-client";
import { StageBMatcher } from "../../../src/scoring/infrastructure/stage-b-matcher";

let dir: string;
let db: Db;
let matchesRepo: MatchesRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-stage-b-"));
  db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  matchesRepo = new MatchesRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-14T03:00:00Z");

function profile(): Profile {
  return {
    courseName: "Sistemas de Informação",
    institution: "Universidade Exemplo",
    courseStart: new Date("2026-03-01"),
    courseEnd: new Date("2029-12-01"),
    englishLevel: "intermediate",
    minimumStipend: "R$ 1500",
    maxWeeklyHours: "30",
    workAvailability: "40h remoto, disponível dias úteis.",
    competencies: [
      {
        name: "Node.js",
        tracks: ["dev"],
        aliases: [],
        evidence: ["Built atlas-manager's HTTP layer in Node.js."],
      },
    ],
    resumeVariants: [
      { id: "backend", tracks: ["dev"], competencyNames: ["Node.js"] },
    ],
  };
}

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    text: "Node.js experience",
    category: "language",
    weight: "mandatory",
    ...overrides,
  };
}

describe("StageBMatcher.match — cache", () => {
  it("calls the model once per requirement and caches the result on a miss", async () => {
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches).toEqual([
        {
          requirement: requirement(),
          status: "met",
          evidence: "Built atlas-manager's HTTP layer in Node.js.",
        },
      ]);
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(
      matchesRepo.find(
        "fp1",
        "hash1",
        "b-v6",
        "unknown",
        hashRequirements([requirement()]),
      ),
    ).toEqual(result.ok ? result.matches : null);
  });

  it("never calls the model on a cache hit", async () => {
    matchesRepo.upsert(
      "fp1",
      "hash1",
      "b-v6",
      "unknown",
      hashRequirements([requirement()]),
      [{ requirement: requirement(), status: "not_met", evidence: null }],
      NOW,
    );
    const ask = vi.fn(async () => '{"status":"met","evidence":"x"}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("does not trust a cached match list whose count no longer matches the current requirements (docs/audit PR-013)", async () => {
    // A row whose requirementsHash key matches but whose stored `matches`
    // array does not -- the exact "structurally valid JSON, wrong content"
    // corruption PR-013 names (a restore/manual edit, not a mock scenario
    // this test simulates by writing an internally-inconsistent row
    // directly). requirementsHash alone cannot catch this: it only proves
    // *a* set of requirements produced this hash, not that the stored
    // matches actually correspond to it element-for-element.
    matchesRepo.upsert(
      "fp1",
      "hash1",
      "b-v6",
      "unknown",
      hashRequirements([requirement()]),
      [], // zero matches for a one-requirement key -- a count mismatch.
      NOW,
    );
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    // Falls through to a real model call rather than trusting the
    // mismatched cache row.
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("does not trust a cached match whose evidence is no longer applicable", async () => {
    matchesRepo.upsert(
      "fp1",
      "hash1",
      "b-v6",
      "unknown",
      hashRequirements([requirement()]),
      [
        {
          requirement: requirement(),
          status: "met",
          evidence: "Fabricated but structurally valid evidence.",
        },
      ],
      NOW,
    );
    const ask = vi.fn(async () => '{"status":"not_met","evidence":null}');

    const result = await new StageBMatcher(ask, matchesRepo).match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, cacheHit: false });
  });

  it("treats a different profileHash as a cache miss (ADR-007)", async () => {
    matchesRepo.upsert(
      "fp1",
      "hash1",
      "b-v2",
      "unknown",
      hashRequirements([requirement()]),
      [{ requirement: requirement(), status: "met", evidence: "old" }],
      NOW,
    );
    const ask = vi.fn(async () => '{"status":"not_met","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash2",
      () => NOW,
    );

    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches[0]?.status).toBe("not_met");
  });

  it("returns matches for multiple requirements, one model call each", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
      )
      .mockResolvedValueOnce('{"status":"not_met","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [
        requirement({ text: "Node.js experience A" }),
        requirement({ text: "B" }),
      ],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches.map((m) => m.status)).toEqual(["met", "not_met"]);
    }
  });

  it("returns ok:true with an empty match list, no model calls, for an empty requirement list", async () => {
    const ask = vi.fn(async () => '{"status":"met","evidence":"x"}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      matches: [],
      cacheHit: false,
      evidenceRejectedCount: 0,
    });
  });

  it("does not reuse a cached match produced by a different model (docs/audit AC-007)", async () => {
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcherA = new StageBMatcher(
      ask,
      matchesRepo,
      "b-v2",
      undefined,
      "model-a",
    );
    const matcherB = new StageBMatcher(
      ask,
      matchesRepo,
      "b-v2",
      undefined,
      "model-b",
    );

    await matcherA.match("fp1", [requirement()], profile(), "hash1", () => NOW);
    expect(ask).toHaveBeenCalledTimes(1);

    // Same fingerprint, profileHash, promptVersion and requirements -- only
    // the model differs. Switching LLM_MODEL must not silently reuse the
    // other model's match as if it were this one's.
    await matcherB.match("fp1", [requirement()], profile(), "hash1", () => NOW);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached match when the requirement set changes, even with the same fingerprint (docs/audit AC-007)", async () => {
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    await matcher.match("fp1", [requirement()], profile(), "hash1", () => NOW);
    expect(ask).toHaveBeenCalledTimes(1);

    // Simulates Stage A re-extracting and producing a different requirement
    // set for the same posting (fingerprint unchanged) -- the old cached
    // match must not be reused just because fingerprint/profileHash/
    // promptVersion still line up.
    await matcher.match(
      "fp1",
      [requirement({ text: "Docker experience" })],
      profile(),
      "hash1",
      () => NOW,
    );
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("resumes from per-requirement checkpoints after a partial provider failure", async () => {
    const requirements = [
      requirement({ text: "Node.js experience" }),
      requirement({ text: "English intermediate" }),
    ];
    const firstAsk = vi
      .fn()
      .mockResolvedValueOnce(
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
      )
      .mockRejectedValueOnce(
        new LlmTransportError("request too large", "requestError", {
          status: 413,
        }),
      );
    const firstMatcher = new StageBMatcher(firstAsk, matchesRepo, undefined, 1);

    const failed = await firstMatcher.match(
      "fp1",
      requirements,
      profile(),
      "hash1",
      () => NOW,
    );
    expect(failed).toMatchObject({ ok: false, permanent: false });
    expect(firstAsk).toHaveBeenCalledTimes(2);

    const resumedAsk = vi.fn(async () =>
      Promise.resolve('{"status":"not_met","evidence":null}'),
    );
    const resumedMatcher = new StageBMatcher(
      resumedAsk,
      matchesRepo,
      undefined,
      1,
    );
    const resumed = await resumedMatcher.match(
      "fp1",
      requirements,
      profile(),
      "hash1",
      () => NOW,
    );

    expect(resumedAsk).toHaveBeenCalledTimes(1);
    expect(resumed).toMatchObject({
      ok: true,
      cacheHit: false,
      matches: [{ status: "met" }, { status: "not_met" }],
    });

    const wholeCacheAsk = vi.fn();
    const cached = await new StageBMatcher(wholeCacheAsk, matchesRepo).match(
      "fp1",
      requirements,
      profile(),
      "hash1",
      () => NOW,
    );
    expect(wholeCacheAsk).not.toHaveBeenCalled();
    expect(cached).toMatchObject({ ok: true, cacheHit: true });
  });
});

describe("StageBMatcher.match — ADR-005: evidence:null forces not_met", () => {
  it("coerces a met with evidence:null to not_met, ignoring the model's claimed status", async () => {
    const ask = vi.fn(async () => '{"status":"met","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("not_met");
      expect(result.matches[0]?.evidence).toBeNull();
      expect(result.evidenceRejectedCount).toBe(0);
    }
  });

  it("coerces a partial with evidence:null to not_met as well", async () => {
    const ask = vi.fn(async () => '{"status":"partial","evidence":null}');
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matches[0]?.status).toBe("not_met");
  });
});

describe("StageBMatcher.match — evidence provenance (docs/audit AC-008)", () => {
  it("coerces a met with fabricated evidence to not_met, exactly like evidence:null", async () => {
    // The real-world scenario the finding names: a prompt-injected
    // instruction in the posting returns syntactically valid JSON with
    // invented evidence. MatchOutputSchema only checks that evidence is a
    // non-empty string, so this must be caught downstream, not by the
    // schema -- SECURITY.md's claim that fabricated evidence "cannot"
    // manufacture a match was previously not enforced anywhere in the code.
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Led a team of 50 engineers at a Fortune 500 company."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("not_met");
      expect(result.matches[0]?.evidence).toBeNull();
      expect(result.evidenceRejectedCount).toBe(1);
    }
  });

  it("keeps a met with a real, verbatim profile quote as met — guards against a blanket false negative", async () => {
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("met");
      expect(result.matches[0]?.evidence).toBe(
        "Built atlas-manager's HTTP layer in Node.js.",
      );
    }
  });

  it("accepts a real quote even with the prompt's '- [Competency] ' tag still attached", async () => {
    const ask = vi.fn(
      async () =>
        '{"status":"met","evidence":"- [Node.js] Built atlas-manager\'s HTTP layer in Node.js."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("met");
      expect(result.matches[0]?.evidence).toContain(
        "Built atlas-manager's HTTP layer in Node.js.",
      );
    }
  });

  it("does not cache a match built from fabricated evidence as if it were a real met", async () => {
    const ask = vi.fn(
      async () => '{"status":"met","evidence":"Invented credential."}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo);

    await matcher.match("fp1", [requirement()], profile(), "hash1", () => NOW);

    const cached = matchesRepo.find(
      "fp1",
      "hash1",
      "b-v6",
      "unknown",
      hashRequirements([requirement()]),
    );
    expect(cached?.[0]?.status).toBe("not_met");
    expect(cached?.[0]?.evidence).toBeNull();
  });
});

describe("StageBMatcher.match — failure, never throws", () => {
  it("returns ok:false with matching_failed after retries are exhausted, caching nothing", async () => {
    const ask = vi.fn(async () => "not json");
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result).toEqual({
      ok: false,
      reason: "matching_failed",
      attempts: 3,
      permanent: false,
      diagnostic: {
        kind: "output_invalid_json",
        lastAttemptLatencyMs: expect.any(Number),
      },
    });
    expect(
      matchesRepo.find("fp1", "hash1", "b-v6", "unknown", "any-hash"),
    ).toBeNull();
  });

  it("discards results for requirements already matched when a later one fails", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"met","evidence":"x"}')
      .mockResolvedValue("not json");
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement({ text: "A" }), requirement({ text: "B" })],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result.ok).toBe(false);
    expect(
      matchesRepo.find("fp1", "hash1", "b-v6", "unknown", "any-hash"),
    ).toBeNull();
  });

  it("marks the failure permanent when the underlying cause is a permanent transport error (docs/audit PR-007)", async () => {
    const ask = vi.fn(async () => {
      throw new LlmTransportError("revoked key", "authError");
    });
    const matcher = new StageBMatcher(ask, matchesRepo);

    const result = await matcher.match(
      "fp1",
      [requirement()],
      profile(),
      "hash1",
      () => NOW,
    );

    expect(result).toEqual({
      ok: false,
      reason: "matching_failed",
      attempts: 1,
      permanent: true,
      diagnostic: {
        kind: "permanent_error",
        category: "authError",
        lastAttemptLatencyMs: expect.any(Number),
      },
    });
  });
});

describe("StageBMatcher.match — bounded concurrency (ADR-022)", () => {
  /** Resolves each call only when the test says so, so in-flight count is
   * observable rather than inferred from timing. */
  function controllableAsk() {
    let inFlight = 0;
    let peakInFlight = 0;
    const pending: (() => void)[] = [];
    const askedFor: string[] = [];

    const ask = vi.fn(async (prompt: string) => {
      // The requirement text is the only part that varies per call.
      askedFor.push(
        prompt.includes("REQ-") ? prompt.split("REQ-")[1]![0]! : "",
      );
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return '{"status":"met","evidence":"Built atlas-manager\'s HTTP layer in Node.js."}';
    });

    return {
      ask,
      askedFor,
      peak: () => peakInFlight,
      waiting: () => pending.length,
      releaseAll: () => {
        while (pending.length) pending.shift()!();
      },
    };
  }

  function requirements(count: number): Requirement[] {
    return Array.from({ length: count }, (_, i) =>
      requirement({ text: `REQ-${i} Node.js experience` }),
    );
  }

  it("keeps at most `concurrency` calls in flight", async () => {
    const c = controllableAsk();
    const matcher = new StageBMatcher(c.ask, matchesRepo, "b-v2", 3);

    const running = matcher.match(
      "fp1",
      requirements(9),
      profile(),
      "h",
      () => NOW,
    );

    // The warming call goes out alone first (see below); release it, then
    // let the pool fill and check it never exceeds the bound.
    await vi.waitFor(() => expect(c.waiting()).toBe(1));
    c.releaseAll();
    await vi.waitFor(() => expect(c.waiting()).toBe(3));
    c.releaseAll();
    await vi.waitFor(() => expect(c.waiting()).toBeGreaterThan(0));
    c.releaseAll();
    await vi.waitFor(() => expect(c.waiting()).toBeGreaterThan(0));
    c.releaseAll();

    const result = await running;
    expect(result.ok).toBe(true);
    expect(c.peak()).toBeLessThanOrEqual(3);
    expect(c.ask).toHaveBeenCalledTimes(9);
  });

  it("issues the first requirement alone, to warm the cached prefix", async () => {
    const c = controllableAsk();
    const matcher = new StageBMatcher(c.ask, matchesRepo, "b-v2", 8);

    const running = matcher.match(
      "fp1",
      requirements(8),
      profile(),
      "h",
      () => NOW,
    );

    // ADR-013's PROFILE_EVIDENCE prefix is only worth caching if something
    // populates it before the fan-out races the same miss eight ways.
    await vi.waitFor(() => expect(c.ask).toHaveBeenCalledTimes(1));
    expect(c.peak()).toBe(1);

    c.releaseAll();
    await vi.waitFor(() => expect(c.waiting()).toBe(7));
    c.releaseAll();

    await running;
  });

  it("preserves requirement order even when calls settle out of order", async () => {
    // Answers come back shortest-delay-first, which is the opposite of the
    // order they were issued in. Stage C reads matches positionally against
    // the requirement list, so a reordering here would silently mis-attribute
    // every answer.
    const order = ["2", "0", "3", "1"];
    // Four distinct, real evidence lines — one per requirement index — so
    // this test can still prove ordering by evidence content without
    // tripping the evidence-provenance check (docs/audit AC-008): a
    // fabricated "answer for N" string is now correctly rejected as
    // unverifiable, which would have made every match's evidence null
    // regardless of order.
    const evidenceForIndex = [
      "Built atlas-manager's HTTP layer in Node.js.",
      "Wrote Vitest integration tests for the API.",
      "Deployed the service with Docker Compose.",
      "Set up GitHub Actions CI for the project.",
    ];
    const profileWithFourEvidenceLines: Profile = {
      ...profile(),
      competencies: [
        {
          name: "Node.js",
          tracks: ["dev"],
          aliases: [],
          evidence: evidenceForIndex,
        },
      ],
    };
    let call = 0;
    const ask = vi.fn(async (prompt: string) => {
      const index = prompt.split("REQ-")[1]![0]!;
      const delay = order.indexOf(index) * 5;
      call += 1;
      await new Promise((r) => setTimeout(r, delay));
      return `{"status":"met","evidence":"${evidenceForIndex[Number(index)]}"}`;
    });

    const matcher = new StageBMatcher(ask, matchesRepo, "b-v2", 4);
    const result = await matcher.match(
      "fp1",
      requirements(4),
      profileWithFourEvidenceLines,
      "h",
      () => NOW,
    );

    expect(call).toBe(4);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches.map((m) => m.requirement.text)).toEqual([
        "REQ-0 Node.js experience",
        "REQ-1 Node.js experience",
        "REQ-2 Node.js experience",
        "REQ-3 Node.js experience",
      ]);
      expect(result.matches.map((m) => m.evidence)).toEqual(evidenceForIndex);
    }
  });

  it("stops asking once a requirement fails, and caches nothing", async () => {
    // The sequential loop returned on the first failure; concurrency must not
    // turn that into "ask all 20 anyway". Calls already in flight still
    // settle, so the bound is the assertion, not an exact count.
    const ask = vi.fn(async (prompt: string) =>
      prompt.includes("REQ-1 ")
        ? "not json at all"
        : '{"status":"met","evidence":"e"}',
    );
    const matcher = new StageBMatcher(ask, matchesRepo, "b-v2", 2);

    const result = await matcher.match(
      "fp1",
      requirements(20),
      profile(),
      "h",
      () => NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("matching_failed");
    expect(ask.mock.calls.length).toBeLessThan(20);
    expect(
      matchesRepo.find("fp1", "h", "b-v2", "unknown", "any-hash"),
    ).toBeNull();
  });
});

describe("October declared-evidence regressions", () => {
  it.each([
    [
      "Com formatura mínima prevista para 2028.2",
      "[Academic enrollment] Cursando o 2º período de Sistemas de Informação na Universidade Exemplo, com conclusão prevista para 2029.2.",
    ],
    [
      "Disponibilidade para atuar em escala híbrida na Barra da Tijuca - RJ",
      "[Work availability] Disponível para trabalho presencial ou híbrido no Rio de Janeiro.",
    ],
  ])("retains a supported model answer for %s", async (text, evidence) => {
    const ask = vi.fn(async () => JSON.stringify({ status: "met", evidence }));
    const result = await new StageBMatcher(ask, matchesRepo).match(
      "declared-regression",
      [requirement({ text, category: "availability", weight: "blocking" })],
      {
        ...profile(),
        workAvailability:
          "Disponível para trabalho presencial ou híbrido no Rio de Janeiro.",
      },
      "hash",
      () => NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("met");
      expect(result.evidenceRejectedCount).toBe(0);
    }
  });
});

describe("explicit start and internship duration declarations", () => {
  it.each([
    [
      "Disponibilidade para início imediato",
      "[Start availability] Disponível para início imediato.",
    ],
    [
      "Disponibilidade mínima para 18 meses de estágio",
      "[Internship duration] Disponível para compromisso mínimo de 18 meses de estágio.",
    ],
  ])("accepts confirmed evidence for %s", async (text, evidence) => {
    const confirmed = {
      ...profile(),
      startAvailability: "Disponível para início imediato.",
      minimumInternshipMonths: 18,
    };
    const ask = vi.fn(async () => JSON.stringify({ status: "met", evidence }));
    const result = await new StageBMatcher(ask, matchesRepo).match(
      "confirmed-availability",
      [requirement({ text, category: "availability", weight: "blocking" })],
      confirmed,
      "confirmed-hash",
      () => NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matches[0]?.status).toBe("met");
      expect(result.evidenceRejectedCount).toBe(0);
    }
  });
});

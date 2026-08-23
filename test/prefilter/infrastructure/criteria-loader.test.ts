import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CriteriaValidationError,
  loadCriteria,
} from "../../../src/prefilter/infrastructure/criteria-loader";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-criteria-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_YAML = `
titleBlocklist: [sênior, pleno]
titleRequired: [estágio, estagiário]
location:
  cities: [Rio de Janeiro]
  allowRemote: true
blockedCompanies: []
minKeywordAdherence: 1
tracks:
  dev: [backend, node]
  security: [segurança, firewall]
  automation: [automação, devops]
  data: [análise de dados]
trackWeights:
  dev: 1.0
  security: 1.0
  automation: 0.7
  data: 0.7
  unknown: 0.4
scoring:
  weights:
    mandatory: 65
    desirable: 20
    trackAlignment: 15
  thresholds:
    apply: 70
    review: 45
  minExtractedRequirements: 1
  blockingCapScore: 35
  unknownTrackCapScore: 50
`;

function writeCriteria(contents: string): string {
  const filePath = join(dir, "criteria.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

describe("loadCriteria", () => {
  it("loads and validates a well-formed criteria file", () => {
    const criteria = loadCriteria(writeCriteria(VALID_YAML));
    expect(criteria.titleRequired).toContain("estágio");
    expect(criteria.trackWeights.dev).toBe(1.0);
  });

  it("throws naming the file path when the file does not exist", () => {
    const missing = join(dir, "does-not-exist.yaml");
    expect(() => loadCriteria(missing)).toThrowError(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("throws CriteriaValidationError naming the exact field on schema failure", () => {
    const filePath = writeCriteria(
      VALID_YAML.replace(
        "titleRequired: [estágio, estagiário]",
        "titleRequired: []",
      ),
    );

    let caught: unknown;
    try {
      loadCriteria(filePath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CriteriaValidationError);
    expect((caught as Error).message).toContain(filePath);
    expect((caught as Error).message).toContain("titleRequired");
  });
});

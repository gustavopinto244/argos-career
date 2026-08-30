import { classifyTrack } from "../../prefilter/domain/classify-track";
import { Criteria } from "../../prefilter/domain/criteria";
import { Db } from "../../persistence/infrastructure/db";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../../persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { normalizePostingContent } from "../../scoring/domain/posting-content-hash";
import { hashRequirements } from "../../scoring/domain/requirements-hash";
import {
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_VERSION,
} from "../../scoring/infrastructure/prompts";
import { buildScoringConfig } from "../../scoring/infrastructure/scoring-config";
import { DEFAULT_MAX_DESCRIPTION_CHARS } from "../../scoring/infrastructure/stage-a-extractor";
import { computeScore } from "../../scoring/domain/score";
import { Match, Requirement } from "../../scoring/domain/types";
import { CorpusEntry } from "../domain/types";

/**
 * Assembles `CorpusEntry[]` from `postings` + `extractions` + `matches` —
 * the one I/O module M10's pure aggregation/gap-analysis functions run
 * over. Verdict recomputation here mirrors exactly what `ApiScorer` does
 * for a live scoring call (`classifyTrack` -> `computeScore`), just against
 * already-cached data instead of a fresh LLM call — the same Stage C
 * function, not a second implementation of "how do I score a posting."
 *
 * Reads the extraction/match cache one posting at a time, through the same
 * `find()` each stage's own live path uses (docs/audit PR-017) — not a bulk
 * scan filtered after the fact. A bulk scan can only check dimensions that
 * are the same for every row in the query (`promptVersion`, `model`); it
 * cannot check `contentHash`, which is specific to each posting's own
 * current title/description, or `requirementsHash`, which is specific to
 * each posting's own current requirement set. Reusing `find()` per posting
 * makes this reader automatically as strict as Stage A/B's own cache
 * lookups, with no second, weaker compatibility check to keep in sync with
 * theirs.
 *
 * `findActive()` (not every row): a posting flagged as a similarity
 * duplicate (ADR-010) is the same real opening as its canonical sighting,
 * so counting it again would double-count one opening as two data points.
 * Pre-filter-rejected and `discard`-verdict postings are still included —
 * `findActive()` only excludes *duplicates*, not rejections
 * (`docs/05-domain-model.md`'s "corpus is not a cache").
 */
export class MarketRepository {
  constructor(
    private readonly db: Db,
    private readonly criteria: Criteria,
  ) {}

  /**
   * `model` identifies which model's cached answers to read (docs/audit
   * AC-007/PR-017) — the same value `LLM_MODEL` configured for the run that
   * actually produced them. A corpus assembled under a different model
   * value than the one that scored the postings simply finds nothing
   * cached for any of them, the same honest "not scored yet" a fresh
   * posting shows, rather than silently mixing two models' judgments.
   */
  loadCorpus(
    profileHash: string,
    model: string,
    /**
     * Same optional shape `computeScore` itself takes. Supplied, Stage C
     * can tell a posting blocked *only* by a not-yet-reached academic
     * period from a real rejection (ADR-053) and fills `periodGate`;
     * omitted, `periodGate` is null everywhere and nothing else changes —
     * `periodGate` is computed after `score` and `verdict` are final and
     * feeds neither, so passing this can never move a market-analysis
     * number.
     */
    academicContext?: { readonly courseStart: Date; readonly today: Date },
  ): CorpusEntry[] {
    const postingsRepo = new PostingsRepository(this.db);
    const postings = postingsRepo.findActive();
    const appliedAtByFingerprint = postingsRepo.findAppliedAtMap();
    const extractionsRepo = new ExtractionsRepository(this.db);
    const matchesRepo = new MatchesRepository(this.db);
    const scoringConfig = buildScoringConfig(this.criteria);

    return postings.map((posting) => {
      const { contentHash } = normalizePostingContent(
        posting.title,
        posting.description,
        DEFAULT_MAX_DESCRIPTION_CHARS,
      );
      const extraction = extractionsRepo.find(
        posting.fingerprint,
        STAGE_A_PROMPT_VERSION,
        model,
        contentHash,
      );
      const requirements: readonly Requirement[] =
        extraction?.requirements ?? [];

      const matches: readonly Match[] | null = matchesRepo.find(
        posting.fingerprint,
        profileHash,
        STAGE_B_PROMPT_VERSION,
        model,
        hashRequirements(requirements),
      );

      const outcome = matches
        ? computeScore(
            matches,
            classifyTrack(
              posting.title,
              this.criteria.tracks,
              this.criteria.trackExclusions,
            ),
            scoringConfig,
            academicContext,
          )
        : null;

      return {
        posting,
        requirements,
        matches,
        verdict: outcome?.verdict ?? null,
        // Same "no cached match data, nothing to derive from" null as
        // `verdict` — ADR-076's personal gap analysis is the first
        // consumer that needs these instead of discarding them.
        blockingFailure: outcome?.blockingFailure ?? null,
        criticalGaps: outcome?.criticalGaps ?? [],
        periodGate: outcome?.periodGate ?? null,
        appliedAt: appliedAtByFingerprint.get(posting.fingerprint) ?? null,
      };
    });
  }
}

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  executeListPostings,
  ListPostingsOutcome,
  ListPostingsParams,
} from "../../cli/main";
import { Db } from "../../persistence/infrastructure/db";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { Criteria } from "../../prefilter/domain/criteria";
import { Profile } from "../../profile/domain/profile";
import { CRITERIA, PROFILE } from "./config.provider";
import { DATABASE } from "./database.provider";

/**
 * The one implementation of "discard this posting" (M9-adjacent, pulled
 * forward from Phase 2 feedback work) — `PostingsController` (REST) and
 * `McpController` (MCP) both call this, matching the discipline
 * `RunsService` already established for stage re-execution.
 *
 * `NotFoundException` is a plain `Error` subclass with a `.message`, thrown
 * here rather than in the controller so it works outside an HTTP request
 * context too — the same translation `RunsService`'s docblock explains.
 */
@Injectable()
export class PostingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CRITERIA) private readonly criteria: Criteria,
    @Inject(PROFILE) private readonly profile: Profile,
  ) {}

  /** Read-only over the corpus (ADR-072) — the Hermes-facing "give me the
   * vagas so I can analyze them" query. Never scores anything, never spends
   * LLM budget: it reads whatever Stage A/B already cached, same as
   * `MarketService.studyPlan`. */
  list(params: ListPostingsParams): ListPostingsOutcome {
    return executeListPostings(this.db, this.criteria, this.profile, params);
  }

  /** The manual "applied" bookmark (ADR-072) — reversible, unlike `discard`. */
  markApplied(fingerprint: string) {
    const repo = new PostingsRepository(this.db);
    const found = repo.markApplied(fingerprint, new Date());
    if (!found) {
      throw new NotFoundException(`No posting with fingerprint ${fingerprint}`);
    }
    return { fingerprint, applied: true };
  }

  unmarkApplied(fingerprint: string) {
    const repo = new PostingsRepository(this.db);
    const found = repo.unmarkApplied(fingerprint);
    if (!found) {
      throw new NotFoundException(`No posting with fingerprint ${fingerprint}`);
    }
    return { fingerprint, applied: false };
  }

  /**
   * Marks a posting as permanently rejected by a human decision — never a
   * scoring outcome, and never touched by a profile edit or a re-run
   * (`postings-repository.ts`'s `discard`). `reason` is optional free text,
   * not read by anything downstream.
   */
  discard(fingerprint: string, reason: string | undefined) {
    const repo = new PostingsRepository(this.db);
    const found = repo.discard(fingerprint, new Date(), reason ?? null);
    if (!found) {
      throw new NotFoundException(`No posting with fingerprint ${fingerprint}`);
    }
    return { fingerprint, discarded: true };
  }
}

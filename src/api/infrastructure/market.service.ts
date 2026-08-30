import { Inject, Injectable } from "@nestjs/common";
import {
  executePersonalGapAnalysis,
  executeStudyPlan,
  PersonalGapAnalysisParams,
} from "../../cli/main";
import { TextNotifier } from "../../delivery/infrastructure/telegram-notifier";
import { Db } from "../../persistence/infrastructure/db";
import { Criteria } from "../../prefilter/domain/criteria";
import { Profile } from "../../profile/domain/profile";
import { Taxonomy } from "../../market/domain/taxonomy";
import { CRITERIA, PROFILE, TAXONOMY } from "./config.provider";
import { DATABASE } from "./database.provider";
import { NOTIFIER } from "./notifier.provider";

/**
 * The one implementation of "generate and deliver the study plan" (M10) —
 * `MarketController` (REST) and `McpController`'s `get_study_plan` tool
 * both call this, same shape as `RunsService` (M9): one service behind two
 * protocols, not two implementations that could drift apart.
 */
@Injectable()
export class MarketService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(NOTIFIER) private readonly notifier: TextNotifier,
    @Inject(CRITERIA) private readonly criteria: Criteria,
    @Inject(PROFILE) private readonly profile: Profile,
    @Inject(TAXONOMY) private readonly taxonomy: Taxonomy,
  ) {}

  /**
   * Real, on demand: reads the corpus and sends a real Telegram message,
   * same "on request" framing `docs/10-milestones.md` gives the study
   * plan — unlike `RunsService.deliver`, this never scores anything and
   * never spends LLM budget, it only reads what Stage A/B already cached.
   */
  studyPlan() {
    return executeStudyPlan(
      this.db,
      this.criteria,
      this.profile,
      this.taxonomy,
      this.notifier,
    );
  }

  /** ADR-076: read-only, no LLM spend, no delivery — reads what the
   * postings the operator applied to (or was discarded from for a real
   * competency gap) already say is missing. */
  personalGapAnalysis(params: PersonalGapAnalysisParams) {
    return executePersonalGapAnalysis(
      this.db,
      this.criteria,
      this.profile,
      this.taxonomy,
      params,
    );
  }
}

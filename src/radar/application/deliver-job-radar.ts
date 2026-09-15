import { Db } from "../../persistence/infrastructure/db";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { RunsRepository } from "../../persistence/infrastructure/runs-repository";
import { TextNotifier } from "../../delivery/infrastructure/telegram-notifier";
import { Posting } from "../../posting/domain/posting";
import { keywordMatchesText } from "../../prefilter/domain/title-match";
import { JobRadarConfig } from "../domain/job-radar-config";
import { renderJobRadarText } from "../domain/render-job-radar";

export interface JobRadarDeliveryOutcome {
  readonly runId: string;
  readonly delivered: number;
  readonly error?: string;
}

function newestFirst(a: Posting, b: Posting): number {
  const aDate = (a.publishedAt ?? a.firstSeenAt).getTime();
  const bDate = (b.publishedAt ?? b.firstSeenAt).getTime();
  return bDate - aDate;
}

/**
 * Places one vacancy from each configured category first when available, then
 * includes every remaining vacancy in newest-first order.
 */
export function selectJobRadarPostings(
  postings: readonly Posting[],
  config: JobRadarConfig["delivery"],
): Posting[] {
  const ordered = [...postings].sort(newestFirst);
  const selected: Posting[] = [];
  const selectedFingerprints = new Set<string>();

  for (const category of config.requiredCategories) {
    const match = ordered.find(
      (posting) =>
        !selectedFingerprints.has(posting.fingerprint) &&
        category.terms.some((term) => keywordMatchesText(posting.title, term)),
    );
    if (match) {
      selected.push(match);
      selectedFingerprints.add(match.fingerprint);
    }
  }

  for (const posting of ordered) {
    if (!selectedFingerprints.has(posting.fingerprint)) selected.push(posting);
  }

  return selected;
}

/**
 * Delivers new, non-duplicate postings without reading a candidate profile or
 * calling a scorer. Claims prevent concurrent runs from sending the same
 * postings; a failed Telegram send releases every claim for a later retry.
 */
export async function deliverJobRadar(
  db: Db,
  notifier: TextNotifier,
  config: JobRadarConfig,
  now: () => Date = () => new Date(),
  triggeredBy = "internal",
): Promise<JobRadarDeliveryOutcome> {
  const postings = new PostingsRepository(db);
  const runs = new RunsRepository(db);
  const runId = runs.start("scoreAndDeliver", now(), triggeredBy);
  const claimed = db.transaction((tx) =>
    new PostingsRepository(tx).claimForScoring(runId, now()),
  );
  const selected = selectJobRadarPostings(claimed, config.delivery);

  try {
    const result = await notifier.sendText(
      renderJobRadarText({
        label: config.search.label,
        location: config.search.location,
        postings: selected,
      }),
    );
    if (!result.ok) {
      postings.releaseUnresolvedClaims(runId);
      runs.finish(runId, now(), "failed", {
        deliveredCount: 0,
        failureReason: result.error.message,
      });
      return { runId, delivered: 0, error: result.error.message };
    }

    const deliveredAt = now();
    postings.markNotifiedMany(
      selected.map((posting) => posting.fingerprint),
      deliveredAt,
    );
    runs.finish(runId, deliveredAt, "success", {
      deliveredCount: selected.length,
      filteredCount: claimed.length,
      scoredCount: 0,
    });
    return { runId, delivered: selected.length };
  } catch (cause) {
    postings.releaseUnresolvedClaims(runId);
    const message = cause instanceof Error ? cause.message : String(cause);
    runs.finish(runId, now(), "failed", {
      deliveredCount: 0,
      failureReason: message,
    });
    throw cause;
  }
}

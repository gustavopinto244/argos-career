import { Db } from "../../persistence/infrastructure/db";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { RunsRepository } from "../../persistence/infrastructure/runs-repository";
import { TextNotifier } from "../../delivery/infrastructure/telegram-notifier";
import { Posting } from "../../posting/domain/posting";
import { isSimpleJobAllowed } from "../domain/simple-job-filter";
import { JobRadarConfig } from "../domain/job-radar-config";
import { renderJobRadarText } from "../domain/render-job-radar";

export interface JobRadarDeliveryOutcome {
  readonly runId: string;
  readonly delivered: number;
  readonly error?: string;
}

export const MAX_VACANCIES_PER_MESSAGE = 20;

function newestFirst(a: Posting, b: Posting): number {
  const aDate = (a.publishedAt ?? a.firstSeenAt).getTime();
  const bDate = (b.publishedAt ?? b.firstSeenAt).getTime();
  return bDate - aDate;
}

/** Filters eligibility before ordering vacancies for delivery. */
export function selectJobRadarPostings(
  postings: readonly Posting[],
  config: JobRadarConfig["delivery"],
): Posting[] {
  return postings
    .filter((posting) => isSimpleJobAllowed(posting, config))
    .sort(newestFirst);
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

  let delivered = 0;
  try {
    const batches: Posting[][] = [];
    for (
      let index = 0;
      index < selected.length;
      index += MAX_VACANCIES_PER_MESSAGE
    ) {
      batches.push(selected.slice(index, index + MAX_VACANCIES_PER_MESSAGE));
    }
    if (!batches.length) batches.push([]);
    for (const [index, batch] of batches.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
      const result = await notifier.sendText(
        renderJobRadarText({
          label: config.search.label,
          location: config.search.location,
          postings: batch,
        }),
      );
      if (!result.ok) {
        postings.releaseUnresolvedClaims(runId);
        runs.finish(runId, now(), "failed", {
          deliveredCount: delivered,
          failureReason: result.error.message,
        });
        return { runId, delivered, error: result.error.message };
      }
      postings.markNotifiedMany(
        batch.map((posting) => posting.fingerprint),
        now(),
      );
      delivered += batch.length;
    }
    const deliveredAt = now();
    postings.releaseUnresolvedClaims(runId);
    runs.finish(runId, deliveredAt, "success", {
      deliveredCount: delivered,
      filteredCount: selected.length,
      scoredCount: 0,
    });
    return { runId, delivered };
  } catch (cause) {
    postings.releaseUnresolvedClaims(runId);
    const message = cause instanceof Error ? cause.message : String(cause);
    runs.finish(runId, now(), "failed", {
      deliveredCount: delivered,
      failureReason: message,
    });
    throw cause;
  }
}

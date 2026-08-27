import { asc, eq, sql } from "drizzle-orm";
import { Db } from "./db";
import { pendingAlerts } from "./schema";

export type PendingAlertRow = typeof pendingAlerts.$inferSelect;

/**
 * The queue of alerts whose send failed, held until the channel recovers
 * (ADR-067, `docs/11-known-issues.md` B20).
 *
 * Deliberately small: `queue`, `list`, `remove`. Redelivery policy —
 * ordering, phrasing, how many go out at once — belongs to the caller
 * (`SchedulerService.sendAlerts`), not here.
 */
export class PendingAlertsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Records an alert that could not be sent.
   *
   * Upserts on `text`, so an alert raised repeatedly while the channel is
   * down occupies one row with a growing `occurrences` rather than N rows.
   * The alerting conditions are level-triggered (docs/08) — "source X has
   * delivered nothing" is re-derived and re-raised every cycle — so without
   * this the queue would grow without bound during any real outage, and
   * redelivery would then spam the same sentence back.
   *
   * `firstQueuedAt` is written once and never moved: it is what lets the
   * redelivered message say how long the condition has been unreported.
   */
  queue(text: string, now: Date, error: string | null): void {
    this.db
      .insert(pendingAlerts)
      .values({
        text,
        firstQueuedAt: now,
        lastQueuedAt: now,
        occurrences: 1,
        lastError: error,
      })
      .onConflictDoUpdate({
        target: pendingAlerts.text,
        set: {
          lastQueuedAt: now,
          occurrences: sql`${pendingAlerts.occurrences} + 1`,
          lastError: error,
        },
      })
      .run();
  }

  /**
   * Queued alerts, oldest first, capped at `limit`.
   *
   * Oldest-first because a redelivery that only ever drains the newest would
   * starve the alert that has been waiting longest — which is also the one
   * most likely to describe a still-unfixed problem. The cap bounds how much
   * a single recovery cycle sends: Telegram is rate-limited per chat
   * (docs/11 B3), and a long outage must not turn recovery into a flood that
   * trips it.
   */
  list(limit: number): PendingAlertRow[] {
    return this.db
      .select()
      .from(pendingAlerts)
      .orderBy(asc(pendingAlerts.firstQueuedAt))
      .limit(limit)
      .all();
  }

  /** Drops a row once its alert has actually been delivered. */
  remove(id: number): void {
    this.db.delete(pendingAlerts).where(eq(pendingAlerts.id, id)).run();
  }

  /** How many alerts are waiting. Used to tell the operator that a recovery
   * cycle drained only part of the backlog. */
  count(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(pendingAlerts)
      .get();
    return row?.n ?? 0;
  }
}

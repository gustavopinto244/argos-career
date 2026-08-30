import { desc, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { ApplicationEvent } from "../domain/application-event";
import { Db } from "../../persistence/infrastructure/db";
import { applicationEvents } from "../../persistence/infrastructure/schema";

export type ApplicationEventRow = typeof applicationEvents.$inferSelect;

export function parseApplicationEventMetadata(
  row: Pick<ApplicationEventRow, "metadata">,
): Readonly<Record<string, unknown>> | null {
  if (!row.metadata) return null;
  try {
    const parsed: unknown = JSON.parse(row.metadata);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Append-only per-posting application history (ADR-075). Mirrors
 * `PostingEventsRepository` (docs/audit AC-019/AC-027's precedent): no
 * `update`/`delete` method exists on purpose — a correction is a later row,
 * never an edit to history.
 */
export class ApplicationEventsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Returns `true` when this was a new fact, `false` when an identical one
   * (same posting, same kind, same `occurredAt`) was already recorded.
   *
   * Idempotent on purpose: the only thing stopping a re-report is the Gmail
   * `flagged` marker the Hermes outcome-tracking skill sets *after* a
   * successful record, which is external and best-effort — if it fails to
   * apply, or the run dies between the two steps, the next run reads the
   * same email and reports the same event again. Absorbing that is
   * strictly better than a duplicate row or a thrown constraint error, and
   * the boolean is what lets a caller report "recorded" and "already
   * known" honestly rather than claiming both are new.
   */
  record(
    event: ApplicationEvent,
    metadata?: Readonly<Record<string, unknown>> | null,
  ): boolean {
    const result = this.db
      .insert(applicationEvents)
      .values({
        id: ulid(),
        fingerprint: event.fingerprint,
        kind: event.kind,
        note: event.note,
        occurredAt: event.occurredAt,
        recordedBy: event.recordedBy,
        metadata:
          metadata === undefined || metadata === null
            ? null
            : JSON.stringify(metadata),
      })
      .onConflictDoNothing()
      .run();
    return result.changes > 0;
  }

  /** A posting's full application history, most recent first. */
  findByFingerprint(fingerprint: string): ApplicationEventRow[] {
    return this.db
      .select()
      .from(applicationEvents)
      .where(eq(applicationEvents.fingerprint, fingerprint))
      .orderBy(desc(applicationEvents.occurredAt))
      .all();
  }
}

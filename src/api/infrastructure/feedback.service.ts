import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ApplicationEventKind,
  createApplicationEvent,
} from "../../feedback/domain/application-event";
import {
  ApplicationEventsRepository,
  parseApplicationEventMetadata,
} from "../../feedback/infrastructure/application-events-repository";
import { Db } from "../../persistence/infrastructure/db";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { DATABASE } from "./database.provider";

export interface RecordApplicationEventInput {
  readonly fingerprint: string;
  readonly kind: ApplicationEventKind;
  readonly note?: string | undefined;
  /** ISO 8601. Defaults to now if omitted. */
  readonly occurredAt?: string | undefined;
}

export interface ApplicationEventView {
  readonly kind: string;
  readonly note: string | null;
  readonly occurredAt: string;
  readonly recordedBy: string;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

/**
 * Phase 2's first slice (ADR-075) — the operator or Hermes recording a fact
 * about a posting's application lifecycle (a response, an interview, an
 * outcome). Deliberately does not touch `postings.appliedAt` (ADR-072):
 * that toggle stays exactly as it is, and this service's events start
 * *after* applying, never duplicating it.
 *
 * This repository never reads email itself and never will — a caller (the
 * operator directly, or Hermes having read its own Gmail entirely outside
 * this codebase) is what supplies the fact; this only records it.
 */
@Injectable()
export class FeedbackService {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  record(
    input: RecordApplicationEventInput,
    recordedBy: string,
  ): {
    readonly fingerprint: string;
    readonly kind: ApplicationEventKind;
    readonly recorded: boolean;
  } {
    const postingsRepo = new PostingsRepository(this.db);
    if (!postingsRepo.findByFingerprint(input.fingerprint)) {
      throw new NotFoundException(
        `No posting with fingerprint ${input.fingerprint}`,
      );
    }

    // The domain factory rejects a malformed body with a plain `Error`,
    // which NestJS maps to a bare 500 "Internal server error" — telling the
    // caller the server broke when in fact their input was wrong, and
    // giving them nothing to correct. Translating here is the same split
    // `PostingsService` already draws with `NotFoundException`: the domain
    // stays free of HTTP concepts, and the service decides what the wire
    // should say. `cause` is kept so the real reason still reaches the log.
    let event;
    try {
      event = createApplicationEvent({
        fingerprint: input.fingerprint,
        kind: input.kind,
        note: input.note,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        recordedBy,
      });
    } catch (cause) {
      throw new BadRequestException(
        cause instanceof Error ? cause.message : "Invalid application event",
        { cause },
      );
    }

    const recorded = new ApplicationEventsRepository(this.db).record(event);
    // `recorded: false` means this exact fact was already known — reporting
    // it as a fresh record would let a caller (or the Hermes skill) claim
    // it found something new when it re-read the same email.
    return { fingerprint: event.fingerprint, kind: event.kind, recorded };
  }

  /** A posting's full application-event history, most recent first. Reads
   * cleanly as an empty list for a posting with no events, or one that
   * doesn't exist — this is a read, not an assertion that the posting is
   * real. */
  list(fingerprint: string): readonly ApplicationEventView[] {
    return new ApplicationEventsRepository(this.db)
      .findByFingerprint(fingerprint)
      .map((row) => ({
        kind: row.kind,
        note: row.note,
        occurredAt: row.occurredAt.toISOString(),
        recordedBy: row.recordedBy,
        metadata: parseApplicationEventMetadata(row),
      }));
  }
}

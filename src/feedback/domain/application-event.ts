/**
 * Phase 2's first slice (ADR-075, `docs/01-vision-and-scope.md`'s "Record
 * what was applied to and what got a response"): a timeline of what
 * happened to a posting after the operator applied to it.
 *
 * Deliberately excludes `applied` itself — `postings.appliedAt` (ADR-072)
 * already owns that fact as a reversible toggle, and this module has no
 * opinion on it. `application-events-repository.ts` joins the two by
 * fingerprint when a full timeline is needed; this domain module models
 * only what comes after.
 */
export const APPLICATION_EVENT_KINDS = [
  "response_received",
  "interview_scheduled",
  "rejected",
  "offer",
  "withdrawn",
] as const;

export type ApplicationEventKind = (typeof APPLICATION_EVENT_KINDS)[number];

export interface ApplicationEvent {
  readonly fingerprint: string;
  readonly kind: ApplicationEventKind;
  /** Free text, optional. Never read by any scoring or matching path — the
   * same discipline `Posting`'s own `discardReason` follows. */
  readonly note: string | null;
  /** When the real-world event happened, not when it was recorded. */
  readonly occurredAt: Date;
  /** Non-secret principal id of whoever reported this (ADR-047's
   * `principalId` shape) — Hermes or the operator's own call. */
  readonly recordedBy: string;
}

export type CreateApplicationEventInput = {
  fingerprint: string;
  kind: ApplicationEventKind;
  // `| undefined` explicit, not just `?:` — a Zod-parsed optional's output
  // type is `T | undefined`, which `exactOptionalPropertyTypes` treats as
  // distinct from a merely-absent property (same reasoning `CollectParams`
  // already documents in `src/api/infrastructure/runs.service.ts`).
  note?: string | null | undefined;
  occurredAt: Date;
  recordedBy: string;
};

/**
 * Enforces the invariants at construction: `fingerprint`/`recordedBy`
 * non-empty, `kind` a recognized value, `note` trimmed to `null` when blank.
 * Same "domain factory rejects invalid input, ports return failure as a
 * value" split `createPosting` already draws — this is ordinary
 * validation, not a pipeline stage principle 1 requires to survive a
 * throw.
 */
export function createApplicationEvent(
  input: CreateApplicationEventInput,
): ApplicationEvent {
  const fingerprint = input.fingerprint.trim();
  const recordedBy = input.recordedBy.trim();
  const note = input.note?.trim();

  if (!fingerprint) {
    throw new Error("ApplicationEvent.fingerprint must not be empty");
  }
  if (!recordedBy) {
    throw new Error("ApplicationEvent.recordedBy must not be empty");
  }
  if (!APPLICATION_EVENT_KINDS.includes(input.kind)) {
    throw new Error(`ApplicationEvent.kind is not recognized: ${input.kind}`);
  }

  return {
    fingerprint,
    kind: input.kind,
    note: note ? note : null,
    occurredAt: input.occurredAt,
    recordedBy,
  };
}

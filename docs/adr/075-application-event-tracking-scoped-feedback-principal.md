# ADR-075 — Application-event tracking for the operator and Hermes, scoped by a new `feedback` principal

## Status

Accepted

## Date

2026-08-30

## Context

Phase 2 is defined verbatim in `docs/01-vision-and-scope.md`: "Record what
was applied to and what got a response, and feed that back into weighting."
Nothing does this today. ADR-072 built `postings.appliedAt` — a manual,
reversible bookmark — and explicitly rejected building the fuller feedback
loop as "disproportionate to the actual request" at the time, while
predicting the seam: "if Phase 2 is ever built for real, this column is the
natural seed of it — reusable, not a false start."

This is that moment. The operator wants to know which of their applications
got a response, an interview, an outcome — and wants Hermes (the external
agent on Aquila) able to report that, since Hermes reads its own Gmail on
its own authority, entirely outside this codebase. Nothing in this repository
reads or will read email; that is a deliberate, permanent boundary, not a
phase-1 limitation. This ADR is only about how ArgosCareer records a fact
some other authority — the operator, or Hermes acting on its own judgment —
already knows.

Hermes today authenticates as `admin` to call `mark_applied`/`unmark_applied`
(the only credential those tools accept). Granting Hermes a _new_ capability
— writing corpus facts derived from its own autonomous reading of private
email — under that same all-powerful key would concentrate exactly the kind
of trust ADR-047 was written to avoid: "a credential copied to a host-side
source collector could permanently discard postings, invoke unrelated
sources, or spend model and Telegram budget." A key that can report "I got a
rejection" should not, by the same stroke, be able to discard the whole
corpus or trigger a paid scoring run.

## Considered options

### Option A — require `admin` for the new capability

Zero new credential plumbing; Hermes keeps using the key it already holds
for `mark_applied`. Rejected: it continues concentrating trust exactly where
ADR-047 already argued against it, and it means the _new_ trust this ADR
grants (autonomous writes derived from unsupervised email reading) arrives
with no narrower boundary than the operator's own full administrative
access.

### Option B — a new `feedback` principal kind (chosen)

A new `API_FEEDBACK_KEY`, a new `AuthPrincipal` variant
`{ id, kind: "feedback" }`, scoped at the REST layer to `GET /health` and
`POST /mcp` only, and — inside `mcp.controller.ts` — to exactly
`list_postings`, `mark_applied`, `unmark_applied`,
`record_application_event`, `list_application_events`. Never
`discard_posting`, never any `run_*` tool, never `get_study_plan` (spends
LLM/Telegram budget).

### Option C — extend the `automation` principal kind

`automation` already reaches `POST /mcp` and triggers pipeline stages.
Rejected: it would conflate "runs a scheduled pipeline stage" with "writes
corpus facts derived from autonomous private-data reading" — two materially
different trust levels ADR-047's own capability-scoping reasoning argues
should stay separate. A leaked automation credential today can trigger a
collection/scoring/delivery cycle; folding feedback-writing into the same
key widens that blast radius for no operational reason.

## Decision

**Option B.**

Add `application_events` — an append-only table, mirroring `posting_events`
structurally (no `update`/`delete`, a correction is a later row) — recording
`kind` (`response_received | interview_scheduled | rejected | offer |
withdrawn`), `note` (free text, never read by any pipeline code, same
discipline as `postings.discardReason`), `occurredAt`, and `recordedBy` (the
reporting principal's non-secret id, ADR-047's `principalId` shape).

**Deliberately excludes `applied` as a kind.** `postings.appliedAt`
(ADR-072) already owns that fact as a reversible toggle; duplicating it here
would create two sources of truth — one reversible, one append-only — for
the same question. `application_events` starts at whatever happens _after_
applying. A full timeline for a posting is `postings.appliedAt IS NOT NULL`
joined with this table's rows for that fingerprint; nothing needs both
models to agree about the same fact.

New MCP tools: `record_application_event` (write, gated to
`admin`/`feedback`) and `list_application_events` (read, open to any
principal that can already read `list_postings` — no email content is ever
in this table, so there is nothing this read exposes that the write side
didn't already accept). REST symmetry on `PostingsController` —
`POST`/`GET /postings/:fingerprint/application-events` — for the same
reason `mark_applied`/`discard` already have it: a single-posting action the
operator plausibly wants to make by hand, seeing a rejection email
themselves before Hermes notices. Only `admin` reaches these REST routes
(`feedback` is REST-scoped to `/health` and `/mcp` only), so `recordedBy` on
a REST-originated event is always the operator's own principal id.

**A gap this decision surfaced and closes in the same change:** before this
ADR, every principal able to reach `POST /mcp` (`admin`, `automation`) also
had matching REST-level access to `run_collect`/`run_dedup`/`run_deliver`/
`get_study_plan`/`cancel_run`, so those five MCP tools needed no per-tool
`requirePrincipalKind` check — the REST-layer allowlist already did the
job. `feedback` breaks that invariant: it reaches `POST /mcp` with **no**
matching REST access to any of those five. Left unchecked, `feedback` would
have silently inherited the ability to trigger collection, scoring, and
delivery through MCP alone. All five tools now carry an explicit
`requirePrincipalKind(principal, ["admin", "automation"])` check, changing
nothing for `admin` or `automation` (both already had this access) and
closing it for `feedback` and any future non-privileged principal.

## Consequences

**What this makes easy:** Hermes (or the operator) can say "this posting
got a rejection" or "I have an interview Thursday" and have it land as a
real, queryable fact — Question 2 of the vision (feeding this back into
weighting) now has real data to eventually calibrate against, once there is
enough of it.

**What this still does not do, on purpose:** no email is ever read by this
codebase. No message is ever drafted or sent (Phase 3, its own future ADR).
No scoring weight is recalibrated from outcome history — there is no real
data yet, and building a recalibration mechanism ahead of that data would
repeat the exact mistake M7's calibration protocol exists to prevent.

**Migration cost, stated plainly:** Hermes must be issued `API_FEEDBACK_KEY`
and reconfigured to use it for `mark_applied`/`unmark_applied`/the two new
tools, in place of the admin key it uses for those calls today. This is a
real deployment step outside this repository (on Aquila, wherever Hermes's
own credentials live) — not automatic, not silent. If Hermes needs
`run_collect`/`run_deliver`/etc. for some other reason, it still needs a
separate `automation` or `admin` credential for that; this change narrows
which key covers feedback-recording, it does not consolidate Hermes onto
one key.

**Reversible.** Drop `application_events`, remove the two MCP tools and two
REST routes, remove the `feedback` `AuthPrincipal` variant and its
`ApiKeyGuard` wiring, and revert `mark_applied`/`unmark_applied` to
`admin`-only. Nothing else reads this table yet.

**Verified by reverting.** Excluding `applied` from the kind enum,
`feedback`'s access to `mark_applied`, the `feedback` REST branch in
`api-key.guard.ts`, and the new `requirePrincipalKind` checks on
`run_collect`/`run_dedup`/`run_deliver` were each reverted independently;
each reversion makes a corresponding test fail (one of them at compile
time — removing the `feedback` REST branch left `authorizeRequest`'s
final `source-ingest`-only fallthrough trying to read `.source` off a
`feedback` principal, which `tsc` itself rejects before any test runs).

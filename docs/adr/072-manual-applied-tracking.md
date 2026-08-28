# ADR-072 — A manual, reversible "applied" bookmark, not the Phase 2 feedback loop

## Status

Accepted

## Date

2026-08-28

## Context

The operator asked for the Hermes MCP surface to expose the postings corpus
itself — company, title, score, verdict — so it can be pulled for personal
data analysis instead of only triggering pipeline stages. That request came
with an explicit filter requirement: separate postings already applied to
from the rest.

Nothing in the domain tracks that. `docs/05-domain-model.md` records this as
a deliberate absence — "Application state. Nothing tracks what was applied
to; that is Phase 2 feedback and would pull the non-goal of automatic
application closer" — and `docs/10-milestones.md` lists "Phase 2 feedback
(what was applied to, what got a response)" under "Out of v1". CLAUDE.md §2
separately rules out automatic application as a non-goal (ban risk; the
bottleneck is finding the posting, not applying).

The operator was told this before agreeing to proceed, per CLAUDE.md §15
("disagree when I am wrong … if a request contradicts the principles in §7
or the non-goals in §2, say so before doing it"). They chose to proceed with
the smallest version of the field rather than defer the whole idea.

## Considered options

### Option A — do nothing; filter by `verdict` instead

`apply`/`review`/`discard` already exist and need no schema change. Rejected:
`verdict` is the scorer's recommendation, not the fact of having applied. A
posting scored `apply` that the operator never acted on, and a `review`
posting they did apply to anyway, are both misrepresented by this proxy —
the filter the operator asked for is a fact about their own behavior, not
about the model's opinion of the posting.

### Option B — full Phase 2 feedback loop

Track application date, outcome (rejected/interview/offer), and recruiter
response. This is what `docs/10-milestones.md` scopes as Phase 2 and
explicitly defers — it needs its own data model, its own UI/analysis
surface, and reopens "does tracking outcomes tempt automating the next step"
in a way a single boolean does not. Rejected for now as disproportionate to
the actual request (a filter, not an outcome-tracking feature).

### Option C — a minimal, reversible manual bookmark (chosen)

One nullable `appliedAt` column on `postings`, set/cleared by a human action
(`mark_applied`/`unmark_applied`), with no outcome, no automation, no
recruiter-response tracking. Filterable by `list_postings`.

## Decision

Add `postings.appliedAt` (nullable timestamp). Expose it as:

- `list_postings` MCP tool — filters on `applied: boolean`, alongside
  `verdict`, `track`, and `sinceDays`. This is the actual point of the
  change: Hermes can now pull the corpus, with score and verdict, for
  external analysis, which the MCP server had no tool for at all before
  this ADR (`get_health`/`list_runs`/`get_run` expose only run metadata).
- `mark_applied` / `unmark_applied` MCP tools, and symmetric REST routes
  `POST`/`DELETE /postings/:fingerprint/applied` — the operator, not only
  Hermes, can flip this directly, the same reasoning `discard`'s REST route
  already follows.

Unlike `discardedAt` (write-once, deliberately no "undo" — a human's
rejection is final), `appliedAt` is a **toggle**: marking "applied" by
mistake is a plausible slip, and reversing it should not require a direct
database edit.

No REST listing endpoint (`GET /postings`) is added. The operator explicitly
asked for the read surface to be MCP-only — Hermes is meant to be the
consumer of the corpus, not a second REST client for it.

## Consequences

**What this makes easy:** the actual ask — asking Hermes "quais das vagas
que passaram no filtro eu já apliquei" and getting a real answer, and doing
so without opening the SQLite file directly.

**What this does not do, on purpose:** no application is ever submitted by
this system (the CLAUDE.md §2 non-goal stands untouched — this only records
a fact the operator states about themselves). No outcome, response, or
interview state is tracked. No analytics reads this field yet; it exists
only as data and as a filter.

**What this commits the project to:** `docs/05-domain-model.md`'s "nothing
tracks application state" is no longer quite true and needs a one-line
update pointing here. If Phase 2 is ever built for real, this column is the
natural seed of it — reusable, not a false start — but building on it is a
new decision, not implied by this one.

**Cost of reversing:** low. Drop the column, remove the three MCP tools and
the two REST routes; nothing else in the pipeline reads `appliedAt` (it
plays no role in dedup, scoring, or delivery).

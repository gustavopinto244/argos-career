# ADR-076 — Phase 3 redefined: personal gap analysis over applied/discarded postings, generated communication dropped

## Status

Accepted

## Date

2026-08-30

## Context

`docs/01-vision-and-scope.md` defined Phase 3 as "Generated communication —
resume prose, cover letters, recruiter messages, application-form answers."
The operator corrected this in conversation, in their own words: the
system's real value is **post-candidature**, where every claim can be
grounded in something that actually happened; the four communication
artifacts are all **pre-candidature**, exactly where "a model writing about
your experience will eventually write something you did not do" — a risk
`docs/01-vision-and-scope.md` already named for question 3 — is least
checkable, because there is no real outcome yet to check it against.

What the operator actually wants: given the postings they **applied** to,
see the skill gaps those postings exposed; have Hermes keep documenting
rejections, offers and interviews into a real database; and later run the
same gap analysis over postings **discarded specifically for missing
competency**, not merely off-track ones — with a standing interest in
security, infrastructure and cloud.

This is not new ground. It is a personalization of Question 2 ("what do I
need to improve?"), which M10 already answers market-wide, plus completing
Phase 2's own event coverage (ADR-075 built `application_events` with
`rejected`/`interview_scheduled`/`offer` kinds already defined, but no skill
yet detects and records them).

## Considered options

### Option A — Keep Phase 3 as generated communication, build it later

Rejected outright by the operator, not merely deprioritized. The reasoning
given is structural, not a scheduling preference: these artifacts are
pre-candidature and therefore ungroundable in real outcome data. Recorded
as **dropped**, not deferred, so a future session does not silently pick
this back up as "the next thing" — `docs/10-milestones.md` and
`docs/01-vision-and-scope.md` are both updated to say so explicitly.

### Option B — A wholly new gap-analysis engine, separate from M10's

Rejected. `gapAnalysis` (`src/market/domain/gap-analysis.ts`) already does
exactly the aggregation needed — taxonomy-skill frequency in a set of
postings, minus what the profile covers — it was only ever scoped to
"market-wide, high-compatibility postings" inside itself. Building a second
implementation would duplicate logic already tested and risk the two
drifting apart.

### Option C — Generalize `gapAnalysis` by moving its verdict filter to the caller (chosen)

`gapAnalysis` stops deciding what counts as "in scope" and runs over
whatever `entries` it receives. Each caller supplies its own scope:
`composeStudyPlan` (M10, unchanged behavior) filters to `apply`/`review`
before calling it; the new personal case filters to postings the operator
applied to, or postings discarded specifically for an unmet mandatory or
blocking requirement.

The "discarded" scope is deliberately narrower than "every `discard`
verdict": a posting can be `discard` purely for being off-track
(`unknownTrackCapScore`) while every real requirement was met — that is not
a competency gap, and counting it as one would tell the operator to learn
something they already have. `blockingFailure`/`criticalGaps` (already
computed by Stage C, previously discarded by `MarketRepository.loadCorpus`
after reading only `verdict` off the result) are what make this
distinction possible; they are now carried on `CorpusEntry`.

## Decision

**Option A** for scope (drop generated communication, redefine Phase 3), and
**Option C** for the technical shape.

New MCP tool `get_personal_gap_analysis(scope: "applied" | "discarded",
track?)`, read-only, no LLM spend, no delivery — unlike `get_study_plan` it
never sends a Telegram message; it returns data for Hermes to read and
discuss with the operator directly. Scoped to the `feedback` principal
(alongside `admin`/`automation`) — the same least-privilege reasoning
ADR-075 already applied: this is exactly the kind of self-improvement
insight that principal exists to serve, and it has no side effect
`get_study_plan`'s admin/automation restriction was actually guarding
against (a real send).

Outcome-tracking completion (interviews/rejections/offers) is Hermes-side
work — a new skill using `record_application_event`, the tool ADR-075
already built and left this exact gap named in its own "Out of scope"
section. No ArgosCareer schema or API change is needed for that half.

## Consequences

**What this makes easy:** "what am I missing, based on what I actually
tried" and "what am I missing, based on what I couldn't get past" are now
real, queryable answers — Question 2 personalized, rather than only
market-wide.

**What stays out, on purpose:** any recalibration of scoring weights from
this data — there is real outcome data now (Phase 2 shipped it), but still
not _enough_ of it to calibrate against without repeating the mistake M7's
own protocol exists to prevent. Any drafting or sending of communication —
dropped, not merely postponed, for the reason stated above.

**Reversible.** `gapAnalysis`'s verdict-filter move is a small, mechanical
change with `composeStudyPlan`'s existing behavior pinned by its own test
suite. The new tool, `CorpusEntry`'s two extra fields, and
`personal-gap-scope.ts` can all be removed without touching Phase 1 or
Phase 2's own surface — nothing else reads `blockingFailure`/`criticalGaps`/
`appliedAt` on `CorpusEntry` yet.

**Verified by reverting.** `personal-gap-scope.ts`'s discard-scope
competency check, `MarketRepository`'s new fields, and `gapAnalysis`'s own
filter-removal were each reverted independently; each reversion makes a
corresponding test fail. The MCP-level scope pass-through is checked by a
test that reuses the _same_ fixture across `scope: "applied"` and `scope:
"discarded"` calls specifically so a hardcoded/ignored parameter would be
caught — two tests built from differently-shaped fixtures would not have
caught that class of bug.

---

## Amendment 1 — the three follow-ups the review left open, closed (2026-08-30)

The Phase 2+3 review (PRs #185/#186) named three things it measured and
deliberately did not fix. On the operator's instruction all three were
closed, and two of them turned out to have a cleaner fix than the review
had assumed.

**1. The `discarded` scope admitted postings blocked only by academic
period.** The review argued a fix meant importing `detectPeriodGate`'s
heuristic into the scope for no measured gain. That was the wrong shape.
The actual cause is that `MarketRepository.loadCorpus` called
`computeScore` _without_ the academic context, so `periodGate` was null
there by construction — the same "loadCorpus computes a full `ScoreOutcome`
and throws most of it away" defect this ADR already fixed once for
`blockingFailure`/`criticalGaps`. Passing the context and carrying
`periodGate` onto `CorpusEntry` uses Stage C's own output instead of a
second copy of its heuristic.

Purely additive, and pinned by a test: `periodGate` is computed _after_
`score` and `verdict` are final and feeds neither, so supplying the context
cannot move a market-analysis number.

Note what this does and does not catch. `detectPeriodGate` only fires when
the uncapped `rawScore` already clears `review` — so it excludes exactly
the postings that matter here, the ones that look like a good match and
are blocked only by timing. The low-scoring period/course-gated postings
the review measured (25 of them, Educação Física and Fisioterapia
listings) are still admitted — and still contribute exactly zero taxonomy
skills, which is why they were never the interesting half.

**2. The `applied` scope counted postings Stage A/B never scored.**
Measured at zero impact then (6 of 6 applied postings had cached matches)
but latent. Now excluded from the denominator and reported as
`unanalyzedPostingCount`, so a smaller `scopedPostingCount` is
explainable rather than looking like postings went missing. Silently
dropping them would have been the worse fix.

**3. `application_events` had no uniqueness constraint.** The review
called this acceptable because append-only is deliberate. Append-only and
"the same fact recorded twice" are not the same thing, though: the only
guard against a re-report was the Gmail `flagged` marker the Hermes
outcome-tracking skill sets _after_ a successful record — external,
best-effort, and skipped entirely if the run dies between the two steps.

A unique index on `(fingerprint, kind, occurredAt)` plus
`onConflictDoNothing` makes a re-report idempotent instead of duplicating.
`recordedBy` is deliberately outside the key — the operator recording a
rejection by hand and Hermes reporting the same one are one fact, not
two — and so is `note`, where the first wording wins. Append-only is
intact: a genuinely different event, including a correction at a different
`occurredAt`, still lands as its own row. `record()` now returns whether
the write was new, so a caller can say "already known" instead of claiming
every re-read found something.

Verified against production before migrating: zero existing duplicate
groups, so the constraint could be added without a data repair.

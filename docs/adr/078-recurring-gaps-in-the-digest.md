# ADR-078 — The digest says which of a posting's gaps have already cost you others

## Status

Accepted

## Date

2026-08-30

## Context

ADR-076 redefined Phase 3 around personal gap analysis and built
`get_personal_gap_analysis`, which answers "across the postings I applied
to / was discarded from, what am I missing?" It is a good answer and
nothing reads it.

The tool has to be asked. Asking requires already suspecting there is
something to ask about, which is exactly the knowledge the tool exists to
supply. Meanwhile the digest — the one artefact the operator reads every
day, and the whole point of the under-10-minutes goal — already prints a
`Lacunas:` line per posting and says nothing about whether any of those
gaps has ever mattered.

That gap between the two is the whole finding. A posting's own
`criticalGaps` cannot distinguish a skill the operator has never needed
from one that has now blocked them three times; both render identically.
The distinction only exists across postings, and the aggregation that
computes it was already built and already deployed.

**Measured against production, 2026-08-30:**

| Personal `discarded` scope | Value                               |
| -------------------------- | ----------------------------------- |
| Postings in scope          | 20                                  |
| Distinct skills            | 11                                  |
| Top skill                  | Python, 3 postings                  |
| Next                       | Go 2, PHP 2, then eight skills at 1 |

Small, but real and already differentiating: Python at 3 is a study
priority, and the eight skills at 1 are noise the operator should ignore.
That is precisely the judgement a single posting cannot support.

## Considered options

### Option A — Leave it to `get_personal_gap_analysis`

Rejected. The tool is a pull; the fact is only useful as a push, at the
moment the operator is deciding whether to apply. Requiring them to think
"I should check my aggregate history" while reading a posting is requiring
them to do the system's job.

### Option B — A separate gap section in the digest

Rejected. It would restate `get_personal_gap_analysis` as a block of text
detached from any posting, adding length to the digest without helping the
decision in front of the reader. The value is in the adjacency: this
posting, this gap, this history.

### Option C — One line per posting, under its own `Lacunas` (chosen)

`Lacuna recorrente: Python (3 vagas)`, printed only when at least one of
that posting's own critical gaps also appears in the personal `discarded`
history.

## Decision

**Option C.**

**The join is the taxonomy skill, not the requirement text.** Requirement
wording is free-form model output — "Conhecimento em Python", "Python
(desejável)" and "Rotinas em Python" are one gap only after all three
collapse onto a canonical term. This is the same reason `gapAnalysis`
counts skills rather than strings, and reusing that machinery means the
new code is a lookup, not a second aggregation that could drift from the
first.

**It reads `criticalGaps`, not every requirement.** A skill the profile
already has is not a gap however often it appears, and `computeCriticalGaps`
has already excluded unverifiable traits — "proatividade" is not something
to go and learn.

**The scope is `discarded`, not `applied`.** The line claims a skill has
_cost_ the operator postings. A posting they applied to anyway does not
support that claim; one they were discarded from for an unmet mandatory
requirement does. `discardedForCompetencyEntries` (ADR-076) already draws
that line correctly, including its exclusion of period gates — "you are in
period 2" is not a competency gap.

**Absent, not empty, when unavailable.** `recurringGaps` is optional on
`ScoredPosting`. `executeDeliver` gained an optional `taxonomy` parameter;
without it the analysis never runs and the line never prints, so the CLI's
own `deliver` command and every pre-existing test and fixture are
unaffected. The scheduler reads the taxonomy from `TAXONOMY_PATH` in
`onModuleInit`, the same way it already sources criteria and profile;
`RunsService` injects the `TAXONOMY` token `ApiModule` already provides.

**One corpus pass per digest, not one per posting.**
`executePersonalGapAnalysis` aggregates once; `recurringGapsFor` is then a
pure in-memory lookup per entry.

**A failure here must not cost a delivery.** The aggregation reads the
whole corpus, including old rows the scoring loop never touches, so it has
failure modes the rest of the run does not. It is wrapped: on error the
digest goes out without the line, and the reason is logged rather than
swallowed. A digest that reaches the phone matters more than an annotation
on it.

## Consequences

**What this makes easy:** the operator sees, while deciding on a posting,
whether its gaps are one-offs or the thing that keeps blocking them —
turning M10's aggregate into a decision input rather than a report they
have to remember to request.

**What it does not do:** it does not change any score, verdict or ranking.
The line is annotation. Feeding gap frequency back into scoring weights
remains explicitly out of scope (ADR-076) until there is enough real data
to calibrate against — 20 postings is not it.

**It grows with use.** At 20 discarded postings the line will fire rarely.
That is correct: with no history there is no recurrence to report, and the
feature should be quiet until it has something true to say.

**Reversible.** Drop the `recurringGaps` field, its computation in
`executeDeliver` and its renderer branch; `recurringGapsFor` and its tests
delete cleanly, and nothing else reads any of it.

**Verified by reverting.** Stubbing the history lookup fails the
`executeDeliver` integration test; removing the renderer branch fails the
render test.

**Noted, not fixed:** `GapAnalysisEntry.percentage` holds a _fraction_
(0.15), not a percentage. `render-study-plan.ts` multiplies correctly, so
the Telegram output is right, but `get_personal_gap_analysis` returns the
raw field over MCP, where a consumer reading `0.15` as "0.15%" would be
wrong by 100×. Out of scope here — this decision reads only `count` — and
recorded so it is not rediscovered.

# ADR-058 — Give `Work availability` evidence its own requirement vocabulary

## Status

Accepted

## Date

2026-08-22

## Context

`workAvailability` was added to `Profile` as a fourth declared field
(commit `c174e40`) to close the gap `docs/11-known-issues.md` B9 identified:
postings routinely require a work mode ("Disponibilidade para atuar em
modelo híbrido ou remoto") and the profile could not evidence one.
`evidence-catalog.ts` renders it into the Stage B prompt under its own tag,
`[Work availability]`, exactly like the three fields beside it.

That change was verified as far as the prompt: the line is generated and the
model can see it. When the model then still answered `not_met`, B9 recorded
the conclusion that this was "the calibration-measured ~0.4 correlation
ceiling already known about this model/prompt pairing, not a defect in this
change."

**That conclusion was wrong, and the real cause is a hard bug.**
`isEvidenceApplicableToRequirement` (ADR-049's PR-005 guard) resolves a
quote's tag against `FIXED_TAG_TERMS` for declared fields, and falls through
to a competency lookup otherwise. `FIXED_TAG_TERMS` has entries for
`Academic enrollment`, `English level`, `Availability` and `Compensation` —
and **never got one for `Work availability`**. So the lookup fell through,
searched `profile.competencies` for a competency named "Work availability",
found none, and returned `false`.

Measured directly against the real profile, no model involved:

```
REQUIREMENT: "Disponibilidade para atuar em modelo híbrido ou remoto"
  [Availability]       real=true applicable=true    ← weekly hours, says nothing about work mode
  [Work availability]  real=true applicable=false   ← the line that answers it
```

The evidence was real, quotable, shown to the model — and rejected 100% of
the time, for every requirement that could ever exist. A model answering
`met` correctly had its answer coerced to `not_met`. The field was
structurally dead from the day it was added.

## Considered options

### Give `Work availability` the same vocabulary as `Availability`

Simplest, and wrong. `Availability`'s terms are hours-shaped
("disponibilidade", "horas semanais", "carga horaria"). Sharing them means a
weekly-hours requirement could be answered with the work-mode line and vice
versa — two different facts, mutually unable to satisfy each other's
requirements, collapsed into one.

### Merge the two profile fields into one declared field

Would remove the tag mismatch by removing the tag. Rejected: they are
genuinely different facts a posting asks about separately, and merging them
loses the ability to answer one without over-claiming the other.

### Its own work-mode vocabulary (chosen)

An entry keyed exactly as the catalog tags it, carrying work-mode terms only.

## Decision

`FIXED_TAG_TERMS` gains a `"Work availability"` entry containing work-mode
vocabulary only — `presencial`, `hibrido`, `remoto`, `remota`, `home
office`, `teletrabalho`, `modelo de trabalho`, `local de trabalho`,
`onsite`, `on site`, `hybrid`, `remote` — and deliberately **not** the
generic `disponibilidade` that `Availability` owns.

That keeps the two declared fields answering their own questions:

| requirement                | `Availability` | `Work availability` |
| -------------------------- | -------------- | ------------------- |
| "modelo híbrido ou remoto" | true           | **true**            |
| "30 horas semanais"        | true           | false               |
| "Conhecimento em Node.js"  | false          | false               |

Verified end to end on the real Smarthis posting with a cold Stage B run
(`npm run score:one -- <fp> --cold`, 12 real calls, $0.00095): the
requirement moved `not_met` → `met` and **`mandatoryCoverage` went 75% →
100%**.

## Consequences

**What this makes easy:** the work-mode requirement is extremely common in
this corpus — B9 called it "likely the single highest-leverage one to close"
— and the profile can now actually answer it.

**A general lesson this encodes, worth more than the fix:** adding a
declared field to `Profile` is not one change but two. The catalog renders
it; the guard must also learn its tag. Nothing linked those two tables, so
the omission was silent and total. A future declared field will hit exactly
this unless the tag sets are kept in sync — the honest structural fix is to
derive one from the other, which is deliberately not attempted here because
it touches `evidence-catalog.ts`'s shape.

**What this does not fix:** Smarthis still scores 50.00 `review`, not
because of coverage — that is now 100% — but because
`unknownTrackCapScore` caps it. Its title names no technology, so
`classifyTrack` returns `unknown`. Uncapped it would score **79.4**, and
with a `dev` track **88.4 → `apply`**. That is a separate, now precisely
located problem, recorded in B9 with the measurement behind it.

**Reversal cost:** trivial. Delete the table entry.

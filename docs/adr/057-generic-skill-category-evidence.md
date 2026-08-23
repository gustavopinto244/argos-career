# ADR-057 — Admit evidence when a requirement names a skill category

## Status

Accepted

## Date

2026-08-22

## Context

`docs/11-known-issues.md` B9's last open thread was the Smarthis posting:
hand-scored 100, computed 43.8, because its central technical requirement
matched `not_met` even though the profile plainly evidences programming
work. Three prompt-level explanations were tried and all three were wrong —
`a-v5` (a real fix, for a different defect), `b-v5` (reverted, measured
regression), and provider routing (ADR-056, a real and separate bug).

The actual cause was found deterministically, with no model involved, by
running the real guards against the real requirement and the real profile:

```
REQUIREMENT: "Conhecimento em pelo menos uma linguagem de programação, como
.NET, Python, PHP, Java, C#, VBA, VBScript, entre outras (...)"

[Node.js]    real=true  applicable=false
[TypeScript] real=true  applicable=false
```

The quotes are genuine profile lines (`isKnownProfileEvidence` passes).
They are rejected by `isEvidenceApplicableToRequirement`, the PR-005/ADR-049
lexical guard, which requires the quoted competency's **name or an alias**
to appear literally in the requirement text. The requirement enumerates
examples and says "entre outras" — among others — and never contains the
tokens "Node" or "TypeScript". `StageBMatcher` therefore coerces a correct
`met` to `not_met` with `evidence: null`, which is exactly the row stored.

Confirmed at the call level too: replicating the pipeline's exact prompt and
both guards, the model answered `met` on 13/13 usable calls, quoting
Node.js/TypeScript — every one discarded by the guard.

This is a false negative in a deliberately conservative security control,
and it is the error direction `docs/04-scoring-model.md` explicitly weights
worst: "a missed good posting costs more than a reviewed bad one."

## Considered options

### Loosen provenance to fuzzy/substring matching

Rejected outright. `evidence-provenance.ts` already argues this at length:
"a quote that is _close_ to a real profile line but not identical is exactly
as unverifiable as one invented outright." Provenance is what stops the
model manufacturing evidence, and it is untouched by this ADR.

### Add generic phrases to the profile's competency `aliases`

Would work with zero code change, but "linguagem de programação" is not an
alias for Node.js — it is a category Node.js belongs to. Encoding it as an
alias makes the profile lie about what the words mean, and would have to be
repeated on every competency.

### Match on the requirement's `category` field

`category` is free-text emitted by Stage A ("technical_skill", "tooling"),
not a controlled vocabulary, and it describes the requirement rather than
which competencies could satisfy it. Too weak a signal to gate evidence on.

### A per-track generic-category vocabulary (chosen)

A short, explicit list of phrases that genuinely mean "any skill of this
kind", mapped to the track whose competencies satisfy them.

## Decision

`GENERIC_SKILL_TERMS` is added to `evidence-provenance.ts`, beside the
existing `FIXED_TAG_TERMS` table it mirrors — same file, same function, same
strictly-lexical style (`includesTerm`, no fuzzy matching). A requirement
containing one of a track's terms admits evidence from any competency tagged
with that track.

The lists are deliberately short and category-naming: `linguagem de
programacao` / `programming language` (+ plurals) for `dev`, `seguranca da
informacao` / `information security` for `security`, empty for `automation`.
Bare `programacao` is **intentionally excluded** — it is common enough in
unrelated Portuguese phrasing to reproduce the false-positive shape
ADR-011/015 already fight in the pre-filter.

Provenance itself is unchanged: the quote must still be a verbatim,
exact-match profile line, so nothing here lets the model invent evidence.

## Consequences

**What this makes easy:** the very common posting shape "we want X, such as
[list], among others" now scores against what the candidate actually has,
instead of against whether the posting happened to name their specific tool.

**The security trade-off, stated plainly.** This widens the limitation
ADR-049 already documents — "a malicious requirement can repeat a relevant
token while directing the model to use unrelated evidence" — from specific
tool names to a handful of category phrases. A crafted posting containing
"linguagem de programação" can now surface any `dev` competency's evidence.
That is a real widening, accepted because the evidence must still be real
and quoted verbatim, the guard was never semantic proof, and the measured
cost of the status quo was rejecting correct matches on genuine postings.
The per-track scoping is what keeps it bounded: a `security` competency is
still not evidence for "a programming language", and that is regression-tested.

**What this does not fix:** Smarthis's computed score was **not** confirmed
to improve end to end. The calibration harness would not exercise a cold
Stage B call for it (see `docs/11-known-issues.md` B12), so this ADR claims
only what was actually verified — the guard now admits the evidence
(unit-level, deterministic) and the full pipeline decision resolves `met`
when replicated call-by-call (5/6). A real end-to-end number needs B12
resolved first.

**Reversal cost:** low. Delete the table and the four-line branch that reads
it; the name/alias rule is untouched underneath.

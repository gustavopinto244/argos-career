# ADR-059 — Derive the score's track from extracted requirements

## Status

Accepted

## Date

2026-08-22

## Context

`classifyTrack` reads the posting **title** and nothing else, and its result
is used for two different purposes that were never distinguished:

1. **The pre-filter's gate** (ADR-051) — decides whether a posting is worth
   spending an LLM call on, and therefore must run before any call is made.
2. **The score's `trackAlignment`** (`docs/04-scoring-model.md`) — 15% of
   the formula, plus `unknownTrackCapScore`, which caps an unknown-track
   posting at 50 outright.

Title-only is genuinely right for (1): it is the only information available
for free. For (2) it is simply the weaker of two available signals, because
by the time scoring runs, Stage A has already extracted the posting's stated
requirements.

The cost of conflating them was measured on the real corpus: **2,379 of
2,768 active postings (86%) classify `unknown` by title**, and a posting that
is genuinely on-track but whose title names no technology gets capped at 50
regardless of how well it actually matches. The worked example throughout
`docs/11-known-issues.md` B9 is "Programa de Estágio Smarthis | 2026" —
100% `mandatoryCoverage`, capped to 50.00 `discard`/`review` by a title that
mentions only a company name and a year.

## Considered options

### Classify on the raw description

Tried first, and **rejected on measurement**: 438 postings would newly
classify, and sampling them showed they are almost entirely off-track —
"Operador(a) de Caixa" and "Operador de Teleatendimento" as `dev`,
"Assistente de vendas" as `security`, "GERENTE DE MANUTENÇÃO E
REFRIGERAÇÃO" as all three. Job descriptions carry enough HR boilerplate
("sistemas", "segurança", "desenvolvimento", "TI") to trip every keyword
list. With `rejectUnknownTrack` on, each false positive is also a wasted
Stage A/B call.

### Change the pre-filter's classifier too

Rejected outright: the pre-filter runs before extraction exists, so there is
nothing better for it to read, and widening it is exactly the spend increase
ADR-018/051 exist to prevent.

### Union title tracks with requirement tracks

Rejected. A stray requirement could add a higher-weighted track to a posting
whose title was already unambiguous — changing scores that were never wrong.

### Fall back to extracted requirements only when the title yields nothing (chosen)

Strictly additive: a title that classifies is left completely alone.

## Decision

`resolveScoringTracks` (`api-scorer.ts`) computes the track that feeds
`computeScore`. When `classifyTrack` on the title returns anything, that
result is used unchanged. Only when it returns empty does it re-run
`classifyTrack` over the extracted requirement text — the posting's own
stated demands, with the boilerplate already removed by extraction, which is
precisely what makes this signal cleaner than the raw description.

**The pre-filter is untouched.** `applyPreFilter` still classifies on the
title, still gates spending on it, and `rejectUnknownTrack` still means what
it meant. This ADR splits one classifier into two _uses_, not two
classifiers.

`trackExclusions` still apply, now against the joined requirement text. One
excluded phrase vetoes that track for the whole posting — blunter than on a
title, and deliberately so: it errs toward `unknown`, the conservative
direction.

## Measurement

M7 protocol, one variable changed. `trackAlignment` is not part of any cache
key, so a fully-cached calibration run measures this change exactly, with no
new model calls and no cost:

|                     | before | after     |
| ------------------- | ------ | --------- |
| Correlation         | 0.468  | **0.621** |
| `apply` recall      | 25%    | **38%**   |
| `apply` precision   | 100%   | 100%      |
| `discard` precision | 50%    | 56%       |
| `discard` recall    | 86%    | 71%       |
| parse-failure       | 0%     | 0%        |

`apply` recall is the number B9 was opened about — "a missed good posting
costs more than a reviewed bad one" (`docs/04`) — and it improved without
costing any `apply` precision. `discard` recall fell as the mirror image:
raising track alignment raises scores, so fewer hand-labelled discards stay
below the cutoff, while `discard` _precision_ rose.

**One caveat, stated rather than hidden:** this run measures the track change
across all 18 postings plus ADR-058's availability fix on Smarthis alone,
whose Stage B cache was re-run cold in the same session. The other 17
postings' Stage B answers are unchanged, so their movement is track-only.

End to end on the worked example: **50.00 `review` → 88.33 `apply`**
(hand label 100), verified with a cold run — 14 real calls, $0.00117.

## Consequences

**What this makes easy:** the very common Brazilian posting whose title is a
programme name and a year ("Programa de Estágio X | 2026") is now scored on
what it actually asks for. That shape is not rare — it is how most large
internship programmes title their listings.

**What it makes harder / riskier:** scores now depend on Stage A's output in
one more place. A bad extraction previously affected only coverage; it can
now also move `trackAlignment` and, through `unknownTrackCapScore`, remove a
cap. The blast radius is bounded by the fallback being additive — a posting
that classified before cannot be changed by this at all.

**What it does not change:** the pre-filter's spend gate, `rejectUnknownTrack`,
`unknownTrackCapScore` itself, or any weight. A posting rejected pre-LLM
never reaches this code, so this cannot widen what gets scored — only how
already-scored postings are weighted.

**Reversal cost:** low. `resolveScoringTracks` is a pure, separately tested
function; reverting means passing `titleTracks` straight to `computeScore`.

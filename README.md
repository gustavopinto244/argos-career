# ArgosCareer

Collects internship postings, scores them against a master profile, and delivers
a ranked digest to Telegram every night.

Personal project. Built to cut weekly job-triage time to under 10 minutes, and to
be honest about what it can and cannot tell you.

> **Status: M10 done (preliminary).** Real scoring (stages A/B, calibrated
> against a preliminary 16-posting sample) is deployed and running
> unattended on Atlas: two independent crons, alerting, backup and restore,
> all verified for real, not just written. Local-model scoring
> (`OllamaScorer`) was evaluated and retired ([ADR-016](docs/adr/016-retire-ollama-scorer.md))
> — the hosted scorer is the permanent production adapter. An authenticated
> HTTP API and MCP server are live on Atlas over Tailscale
> ([ADR-017](docs/adr/017-tailscale-and-bearer-key-for-the-api-boundary.md)),
> for Hermes — on a different machine — to reach. A global skill taxonomy,
> market aggregation, gap analysis and an on-request study plan (CLI, REST,
> MCP) are built and run for real against the local corpus — honestly thin
> today, the same 16-posting sample M7's calibration cites, since Stage A
> still has not run at production volume. Milestone table below.

## What it answers

|       | Question                                              | Status                          |
| ----- | ----------------------------------------------------- | ------------------------------- |
| **1** | Which are the best postings for me right now?         | v1                              |
| **2** | What do I need to improve to be a better candidate?   | after calibration               |
| **3** | How should I present my profile for this opportunity? | v1 — recommends, does not write |

It starts as a job radar and grows into a career assistant driven by real market
data: the same corpus that ranks postings is what later says which skills the
market actually asks for, and which of them your profile cannot yet evidence.

## The problem

Searching for an internship means opening the same job boards every few days,
reading the same postings twice because nothing remembers what was already seen,
and rejecting the same senior roles a keyword filter keeps matching. The work is
not hard, it is repetitive — and the cost of postponing it is invisible until a
posting closes.

The bottleneck is finding and triaging postings, not applying to them.

## How it works

```
Scheduler → Collect → Normalize → Dedup → Pre-filter → Score → Telegram digest
           (every 4h)                  (84-97% cut)  (LLM, nightly, off-peak)
```

Collection runs every few hours, low volume, no LLM; scoring and delivery run
once nightly in an off-peak window (ADR-009). The digest goes out daily.
Decoupling the two shortens the discovery window from days to hours and keeps
request patterns unremarkable.

A deterministic pre-filter runs before any LLM call. Measured against real
collected data, it cuts 84-97% of postings up front depending on how narrowly
collection is targeted — this is what makes a 4B model on a GPU-less mini PC
viable at all.

### Scoring: the LLM does not produce the number

The obvious design — send resume and posting to a model, ask for a score out of
100 — fails three ways. It is not calibrated (almost everything lands between 65
and 85), it is not comparable across prompt versions, and holistic numeric
judgment is exactly where a small model diverges most from a large one.

So the model is given only the two jobs it is good at, and the arithmetic happens
in code:

| Stage              | Runs on  | Produces                                                         |
| ------------------ | -------- | ---------------------------------------------------------------- |
| **A — Extraction** | LLM      | Structured requirements: `{text, category, weight}`              |
| **B — Matching**   | LLM      | `met \| partial \| not_met`, **with a mandatory evidence quote** |
| **C — Score**      | **code** | A pure, deterministic, unit-tested number                        |

```
score = 65 × mandatoryCoverage + 20 × desirableCoverage + 15 × trackAlignment
```

The evidence quote is load-bearing. Without it the model hallucinates adherence —
it _wants_ to agree that you qualify, and with no obligation to point at anything
in your profile, it will. Requiring a verbatim quote turns an agreeable judgment
into a retrieval task with a checkable answer. `evidence: null` forces `not_met`,
enforced in code rather than requested in the prompt.

A failed knockout requirement caps the score at 35 — `partial` included, because
an ATS knockout question is binary.

Full model, thresholds and reasoning: [`docs/04-scoring-model.md`](docs/04-scoring-model.md)
and [ADR-005](docs/adr/005-llm-does-not-produce-the-score.md).

### What it honestly does not do

**This is not an ATS simulator.** Gupy ranks candidates with a proprietary,
opaque system, and no external project reproduces it.

The question this answers reliably is narrower:

> Does my resume demonstrate evidence for what this posting declares it wants?

Postings also lie by omission and copy boilerplate between roles, so the system
scores declared text, not the actual job. Every weight and cutoff above is
provisional — see Calibration below for what has and has not been measured.

### Calibration

**Preliminary — 18 hand-labelled postings, not the 50 the protocol calls for.**
Real Gupy volume for this search profile is thin (consistent with the
pre-filter's own 84–97% cut, [ADR-011](docs/adr/011-pre-filter-rules-and-thresholds.md)):
18 is what exists to label today (grew from 16 as more real postings
accumulated in the corpus). Expanding to 50 happens the same way, not on
demand — tracked in [`docs/10-milestones.md`](docs/10-milestones.md),
re-run from here whenever that happens.

| #   | Configuration                                                                                                                                                                                                   | n   | Scored | Parse-failure | Correlation           | Verdict recall (apply / review / discard)                                                                          | Cost                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------ | ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1   | `openrouter/free` auto-router                                                                                                                                                                                   | —   | —      | —             | n/a                   | Never produced a measurement — router swaps the underlying model every request, so "model" was never held constant |
| 2   | Any `:free` OpenRouter model                                                                                                                                                                                    | —   | —      | —             | n/a                   | Never produced a measurement — shared 50 req/day cap, one posting's match calls alone exceed it                    |
| 3   | `qwen3:4b` via `OllamaScorer`, local                                                                                                                                                                            | 16  | 2      | 88%           | n/a (too little data) | 0% / n/a / 0%                                                                                                      | not recorded (usage tracking added later) |
| 4   | `deepseek-v4-flash-0731` via `ApiScorer`, `b-v2` prompt — **inputs later found broken** (see below)                                                                                                             | 16  | 16     | 0%            | -0.097                | not recorded per-verdict — the aggregate correlation is what triggered the audit below                             | not recorded (usage tracking added later) |
| 5   | Same as #4, **after** the description backfill, `verifiable`-exclusion and `trackExclusions` fixes                                                                                                              | 16  | 16     | 0%            | **0.522**             | 0% / 0% / 100% (64% precision)                                                                                     | $0.0326                                   |
| 6   | Same as #5, **after** completing the profile's declared fields (English, availability) — worst-5-deviation subset only, not a full re-run                                                                       | 5   | 5      | 0%            | **0.835**             | 20% / n/a / n/a (100% precision)                                                                                   | $0.0059                                   |
| 7   | `a-v4`/`b-v4`, worksheet grown to 18 — baseline before [ADR-055](docs/adr/055-stage-a-v5-track-conditional-requirements.md)                                                                                     | 18  | 13     | 28%           | 0.357                 | 40% / 0% / 80% (apply 100% precision)                                                                              | $0.0305                                   |
| 8   | `a-v5`/`b-v4`, **only** the Stage A prompt changed from #7 (ADR-055 — merges track-conditional requirement branches)                                                                                            | 18  | 18     | 0%            | **0.468**             | 25% / 0% / 86% (apply 100% precision)                                                                              | $0.0272                                   |
| 9   | Same prompts as #8, **after** four scoring fixes: broken provider excluded (ADR-056), category-named and work-mode evidence admitted (ADR-057/058), score's track derived from extracted requirements (ADR-059) | 18  | 18     | 0%            | **0.621**             | 38% / 0% / 71% (apply 100% precision)                                                                              | $0.0000 (cached — see below)              |

**Configurations #1–#3 lost for infrastructure reasons, not model quality** —
worth keeping because the fix (`OllamaScorer` as a fixed local model,
`ApiScorer`/OpenRouter with a named, pinned model) is itself a documented
decision ([ADR-012](docs/adr/012-openrouter-as-the-api-scorer-provider.md),
[ADR-013](docs/adr/013-deepseek-v4-flash-and-cache-friendly-stage-b.md)).

**#4 → #5 and #7 → #8 are the deliberate, single-variable comparisons in this
table** — same model, only one thing changed each time. Auditing #4 posting-by-posting
(not just its aggregate correlation) found the -0.097 was almost entirely
broken inputs, not a bad model or a bad formula:

- **129 of 523 collected postings had a silently empty `description`** (a
  migration added the column without backfilling it) — Stage A extracted
  nothing from them, and the empty-category rule scored them near the top.
  Fixed by a data migration, not a rule change.
- **The profile could not evidence current academic enrollment** — the field
  existed but was never rendered as quotable text for stage B, so "cursando
  \<course\>" (the most common blocking requirement in this corpus) failed
  regardless of the real answer.
- **28% of mandatory/blocking requirements were unfalsifiable traits**
  ("dinamismo", "proatividade") that no portfolio can evidence — counted as
  failures, penalizing the best-fitting postings hardest.
- **`trackAlignment` correlated -0.022 on its own** — "desenvolvimento" and
  "segurança" are overloaded words in Portuguese job titles; 19% of the whole
  corpus was misclassified on those two words alone.

Full reasoning, what was fixed and — as important — **what was deliberately
left alone** (the empty-category rule itself, `trackAlignment`'s weight):
[ADR-014](docs/adr/014-calibration-input-integrity.md) and
[ADR-015](docs/adr/015-verifiable-requirements-and-track-exclusions.md).

**#5 → #6**: the same class of gap as the enrollment fix above turned out to
apply to three more fields — `englishLevel`, `maxWeeklyHours` and
`minimumStipend` had existed on `Profile` since M2 but were, likewise, never
rendered as evidence. Filling them in and wiring them up, plus adding evidence
for Office and AI-assisted tooling, was checked against only the five
worst-deviating postings from #5 rather than a full re-run — a real
improvement on that subset, not yet confirmed at n=16. The next full run is
deferred to 50 postings rather than spent re-confirming this on the same 16.

**Weights and thresholds** (`mandatory: 65, desirable: 20, trackAlignment: 15`,
`apply ≥ 70, review ≥ 45`) are **kept unchanged, deliberately** — not because
they are known to be right, but because the one complete measurement available
came from inputs later found broken, and 16 samples is too few to retune
against without overfitting to noise. Revisit once 50 labelled postings exist.

**#7 → #8**: only `STAGE_A_PROMPT_VERSION` changed, `a-v4` → `a-v5`
([ADR-055](docs/adr/055-stage-a-v5-track-conditional-requirements.md)) —
Stage B, weights and cutoffs held fixed. Correlation improved and every
posting parsed cleanly, but **the recall columns are not a clean
comparison and this table does not claim otherwise**: #7's 28%
parse-failure rate dropped 5 of 18 postings out of every metric entirely,
including each verdict's support count, so #7's recall is computed on a
smaller, non-random 13-posting sample while #8's covers all 18. The two
parse-failure rates are themselves very likely unrelated to the prompt
change — almost every retry in both runs' logs was a Stage B failure
(`b-v4`, unchanged between the two), most plausibly ordinary OpenRouter
provider variance between the two run times. What #7 → #8 does verify
directly, not just via the aggregate correlation: the real Smarthis
extraction that motivated the change collapses its two track-conditional
requirement branches into one alternative requirement under `a-v5`, on
every one of the runs where the extraction was cold — see ADR-055 for the
before/after data pulled straight from the database.

**#8 → #9** is four fixes measured together, not one at a time — stated
plainly rather than dressed up as a clean single-variable run. Three were
bugs with no judgement attached: a provider returning empty content
([ADR-056](docs/adr/056-exclude-broken-openrouter-providers.md)), and two
kinds of real profile evidence the applicability guard rejected outright
([ADR-057](docs/adr/057-generic-skill-category-evidence.md),
[ADR-058](docs/adr/058-work-availability-evidence-vocabulary.md) — the latter
made a declared profile field unusable for _every_ requirement from the day
it was added). The fourth is a real scoring-model change
([ADR-059](docs/adr/059-score-track-from-extracted-requirements.md)):
`trackAlignment` now falls back to Stage A's extracted requirements when the
title classifies nothing, which is 86% of this corpus.

`trackAlignment` is not part of any cache key, so #9 was computed from cached
Stage A/B output — no new model calls, hence $0. That makes it an exact
measurement of the track change and a stale one for anything needing the
model re-asked.

**`apply` recall is the number that matters here** (`docs/04`: "a missed good
posting costs more than a reviewed bad one"): 25% → 38%, with `apply`
precision holding at 100%. `discard` recall fell 86% → 71% as the mirror
image — raising alignment raises scores — while `discard` precision rose.
That is the trade this project says it wants.

A scoring system that has never been measured against ground truth is a number
generator. This one now has three real measurements, eight documented
structural fixes derived from auditing it, and a known amount of data still
missing before the next number means more than this one does.

## Stack

TypeScript · NestJS · Zod · Pino · Drizzle ORM + SQLite · Vitest + Supertest ·
Docker Compose · GitHub Actions

Deployed to a self-hosted Ubuntu Server mini PC (7.1 GB RAM, no GPU) within a
~150 MB at-rest budget, alongside services already running there.

Next.js was rejected: it is a UI framework and v1 is a headless batch service.
See [ADR-001](docs/adr/001-nestjs-as-application-framework.md).

## Milestones

| #   | Milestone                                                        | Status                                                    |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| M0  | Bootstrap — docs, CI, ADR practice, repository hygiene           | done                                                      |
| M1  | Domain entities, fingerprint, score computation (stage C)        | done                                                      |
| M2  | Master profile — Zod schema, loader, academic-period derivation  | done                                                      |
| M3  | Gupy collector with tolerant schema + fixture capture script     | done                                                      |
| M4  | Persistence — Drizzle + SQLite, migrations, dedup                | done                                                      |
| M5  | Deterministic pre-filter                                         | done                                                      |
| M6  | **Vertical slice** — Gupy → SQLite → Telegram with a stub scorer | done                                                      |
| M7  | Real scoring — stages A and B, versioned prompts, calibration    | done (preliminary, 16/50 samples)                         |
| M8  | Deployment — Docker Compose, scheduling, backup, alerting        | done (preliminary — local-model scoring retired, ADR-016) |
| M9  | HTTP API and MCP server                                          | done (preliminary — see below)                            |
| M10 | Market intelligence — skill taxonomy, gap analysis, study plan   | done (preliminary — see below)                            |

## Documentation

|                                                                    |                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                                           | Full project context and working agreement            |
| [`docs/01-vision-and-scope.md`](docs/01-vision-and-scope.md)       | Goals, non-goals, success criteria, honest limits     |
| [`docs/02-architecture.md`](docs/02-architecture.md)               | Pipeline, principles, ports, cadence, resource budget |
| [`docs/03-technical-decisions.md`](docs/03-technical-decisions.md) | ADR index and when an ADR is required                 |
| [`docs/04-scoring-model.md`](docs/04-scoring-model.md)             | The scoring model in full                             |
| [`docs/05-domain-model.md`](docs/05-domain-model.md)               | Entity boundaries and invariants                      |
| [`docs/06-glossary.md`](docs/06-glossary.md)                       | Domain vocabulary and the code/digest translation     |
| [`docs/07-testing-strategy.md`](docs/07-testing-strategy.md)       | Test levels, and the curated-fixture workflow         |
| [`docs/08-observability.md`](docs/08-observability.md)             | Logging, run records and alerting                     |
| [`docs/09-configuration.md`](docs/09-configuration.md)             | Secrets, profile and criteria                         |
| [`docs/10-milestones.md`](docs/10-milestones.md)                   | Acceptance criteria per milestone                     |

## Development

```bash
npm ci
npm run lint && npm run format:check && npm run typecheck && npm test
```

CI runs all four on Node 22 and 24. `main` is protected; work happens on a
branch per milestone and lands by squash merge with green CI.

The master profile (`config/profile.yaml`), the postings database and raw API
captures are gitignored — this repository is public and they contain personal
data. A structural example with fictional data ships in M2. The full boundary is
[ADR-004](docs/adr/004-public-repository-privacy-boundary.md).

## A note on collection

Every collector respects `robots.txt`, spaces requests ~1.5 s apart, identifies
itself with an honest `User-Agent` that is never forged to imitate a browser,
backs off exponentially and times out explicitly.

No collector is ever authenticated with a personal LinkedIn session or cookies.
Losing that account during an internship search would cost far more than anything
collecting from it could provide.

## License

MIT

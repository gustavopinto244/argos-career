# ArgosCareer — project context and working agreement

This file is the entry point for any session working on this repository. It
exists so that no future session depends on the prompt that started the project.
If something here contradicts what you were told elsewhere, this file wins;
if this file is wrong, fix it in the same pull request that proves it wrong.

Deeper material lives in `docs/`. This file is the map.

| Document                         | Read it when                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| `docs/01-vision-and-scope.md`    | Deciding whether something is in scope                       |
| `docs/02-architecture.md`        | Adding a stage, a port or an adapter                         |
| `docs/03-technical-decisions.md` | Writing an ADR, or wondering why something is the way it is  |
| `docs/04-scoring-model.md`       | Touching anything that produces a score                      |
| `docs/05-domain-model.md`        | Defining or changing an entity, or crossing a stage boundary |
| `docs/06-glossary.md`            | Naming something, or writing digest text                     |
| `docs/07-testing-strategy.md`    | Writing a test, or creating a fixture                        |
| `docs/08-observability.md`       | Adding a log line, a counter or an alert                     |
| `docs/09-configuration.md`       | Adding a setting, a secret or a criterion                    |
| `docs/10-milestones.md`          | Starting or finishing a milestone                            |
| `docs/11-known-issues.md`        | Something is broken, or you are picking up known breakage    |

---

## 1. What this is

A system that collects internship postings, evaluates how well they match a
master profile, and delivers a ranked digest to Telegram. Strictly personal use.

**Primary goal:** cut weekly job-triage time to under 10 minutes.

**Secondary goal:** be a portfolio centerpiece demonstrating layered
architecture, LLM integration, persistence, scheduling and deployment on
self-hosted infrastructure.

### The three questions

Long term, the system answers three questions automatically. Every module exists
to answer one of them.

|       | Question                                      | Answered by                                              | Status            |
| ----- | --------------------------------------------- | -------------------------------------------------------- | ----------------- |
| **1** | Which are the best postings for me right now? | Radar — collect, dedup, score, digest                    | v1, M1–M9         |
| **2** | What do I need to improve?                    | Market intelligence and gap analysis over the corpus     | M10 (preliminary) |
| **3** | How should I present my profile here?         | Resume-variant recommendation, highlights, missing terms | Output of M2 + M7 |

The chain, in dependency order — each link needs the one before it:

```
Radar → Corpus → Scoring → History → Market analysis
      → Gap analysis → Study plan → Resume recommendation
```

**Search profile:** back-end development **and** information security
internships (both priority 1, equally); infrastructure/automation (priority 2).
Rio de Janeiro and its metropolitan region, or remote.

Full detail: `docs/01-vision-and-scope.md`.

## 2. Non-goals — do not implement these, even when they look useful

| Out of scope                         | Reason                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Automatic job application            | Ban risk; the bottleneck is finding the posting, not applying                        |
| Per-posting resume generation        | Dropped from the roadmap, not deferred — ADR-076, docs/01                            |
| Web interface                        | Telegram is the interface in v1                                                      |
| Junior / entry-level roles           | Reconsidered and kept out — see `docs/01`; revisit at period 4                       |
| **Generating** resume or letter text | Recommending which resume to use is in; writing prose was Phase 3, dropped (ADR-076) |
| n8n as pipeline orchestrator         | Same error as a Hermes skill. ADR-008 places it correctly                            |
| Multi-user / SaaS                    | Personal product; auth and LGPD compliance with no upside                            |
| Scraping at scale                    | Not what this is for                                                                 |

## 3. Non-negotiable safety rule

**Never authenticate any collector with a personal LinkedIn session or cookies.**
Losing that account during an internship search is far worse than whatever is
gained by collecting from it. If a solution ever appears to require it, stop and
ask.

LinkedIn is P2 and public visitor endpoints only.

## 4. Stack — decided, do not reopen without an ADR

- TypeScript, Node 24 (`engines: >=22.12.0` — below that, `require(esm)` is
  behind a flag and `nodenext` semantics do not hold)
- **NestJS** — its DI container imposes ports-and-adapters naturally (ADR-001)
- **Zod** (validation, including LLM output), **Vitest** + Supertest (tests),
  **Drizzle ORM + SQLite** (persistence)
- Logging is NestJS's built-in `Logger` — human-readable, not structured.
  Pino was named here for a long time and never installed; `docs/08` records
  what that costs and what would justify adding it.
- `@nestjs/schedule` for scheduling
- Docker Compose for deployment, GitHub Actions for CI

Next.js was rejected: it is a UI framework, and v1 is a headless batch service.
Reconsider in Phase 3 as a dashboard.

Module system is CommonJS on `nodenext` resolution, not the ESM used in
`atlas-manager` (ADR-002 and its amendment).

## 5. Production environment

Personal server "Atlas": mini PC, Ubuntu Server, 7.1 GB RAM, no GPU. Measured at
rest: 1.0 GB used, 6.1 GB available, 4 GB swap untouched. Already running
`atlas-manager` (Node/systemd), Nginx, cloudflared, and two Docker containers
(portfolio 5.4 MiB, task-manager 45.3 MiB).

**There is no fixed memory budget** (ADR-020). The old ~150 MB cap existed for
one reason: a local model was going to run on this box, and paging during
inference would have destroyed latency and could have taken the machine with
it. `OllamaScorer` was retired in ADR-016 and `ApiScorer` calls a hosted model
over HTTP, so the failure mode the cap defended against no longer exists.

**Measured for real, 2026-08-15: 54.8 MiB at rest** — the whole container,
after M10. What replaces the cap is the constraint that was always the real
one: Atlas is shared. `atlas-manager`, Nginx, cloudflared, portfolio and
task-manager run beside this, and 6.1 GB is what the four of them leave free.
Spend it where it buys something — a headless browser for a source that has no
API is now a legitimate call, not a budget violation — and check `docker stats`
after, rather than trusting a number written before the workload existed.

## 6. Job sources

| Source                   | Priority | Strategy                                                                                              |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| **Gupy**                 | P0       | HTTP client in TS. Public JSON endpoint: `https://employability-portal.gupy.io/api/v1/jobs` (no auth) |
| **Google Jobs / Indeed** | P1       | Ephemeral Python container (`--rm`) running `python-jobspy`; prints JSON and exits. Zero RAM at rest  |
| **LinkedIn**             | P2       | Public visitor endpoints only — see §3                                                                |
| **Long tail**            | P3       | n8n workflow behind `N8nCollector` (ADR-008). Never the orchestrator, never on the critical path      |

**The Gupy response schema is unverified.** No request has been made from this
repository. Before trusting the adapter, `npm run fixture:gupy` (M3) must hit the
real API, record the response to `test/fixtures/gupy-raw.json` (gitignored) and
print the keys of the first item. Until then, write the Zod schema tolerantly:
`.passthrough()`, optional fields.

**A headless browser is allowed** where a source has no usable API (ADR-020).
It was never forbidden by name; the ~150 MB budget forbade it in practice, and
that budget is gone. Reach for HTTP first — it is faster, cheaper and does not
break on a layout change — but a browser is a tool, not a transgression.

**Polite collector behavior**, required of every adapter: respect `robots.txt`,
~1.5 s between requests, an honest `User-Agent` that identifies what it is —
never forged to imitate a browser — exponential backoff, explicit timeout. A
discreet collector is a collector that keeps working.

**One named exception: Indeed, via `python-jobspy` (ADR-028).** The
library's Indeed scraper hardcodes a User-Agent impersonating Indeed's own
mobile app — verified in its source, not configurable — and queries
`apis.indeed.com`, whose `robots.txt` disallows everything. Both violate the
rule above. Accepted knowingly, scoped to this one library's Indeed path
only — it licenses nothing else, for any other source. Full reasoning,
including why this is decided differently from Glassdoor's identical
`robots.txt` fact (ADR-020, no exception), in ADR-028.

## 7. Architecture

```
Scheduler → Collect (adapters) → Normalize → Dedup → Pre-filter
          → Score (LLM) → Deliver (Telegram) → Feedback (Phase 2)
```

**Four principles. When in doubt, they decide.**

1. **A broken source does not bring down the pipeline.** A collector NEVER
   propagates an exception — it returns a `CollectionResult` with `error` set and
   an empty list.
2. **Every stage is independently re-runnable.** Scoring already-collected
   postings without re-collecting is a requirement, not a nicety.
3. **Profile and criteria are data, not code.** Changing search strategy must not
   require changing the application.
4. **The LLM engine is a replaceable detail.** Swapping local for API is a
   configuration change, not a refactor.

**Ports:** `CollectorPort`, `ScorerPort`, `NotifierPort`.

**Cadence** (ADR-009): collection runs **every few hours**, low volume, no LLM.
Scoring and delivery run **once nightly**, in a configured off-peak window
(default `03:00 America/Sao_Paulo`) — the only window the model runs in, and
the only time the digest is delivered. **Daily**, not twice a week.

**Dedup:** `sha256(normalize(company) + normalize(title) + normalize(city))`,
where normalize = lowercase, strip accents, strip punctuation, collapse
whitespace. Second layer by textual similarity between postings from the same
company in the same window. A posting already seen is never reprocessed and never
re-notified.

**Deterministic pre-filter before the LLM** — measured at 84-97% (city-dependent,
docs/02) and is what
makes a local model viable at all: title blocklist (senior, pleno, especialista,
coordenador, gerente, tech lead, III, IV), title requirement (estágio /
estagiário / intern / trainee), location, blocked companies, expired posting,
minimum keyword adherence.

Full detail: `docs/02-architecture.md`.

## 8. Scoring model — the core component

The system compares **the master profile** against **the requirements the posting
declares**.

**Do not ask the LLM for the score.** Three stages instead:

- **A — Extraction** _(LLM)_: reads the posting, returns structured requirements
  `{text, category, weight, verifiable}` where
  `weight ∈ {blocking, mandatory, desirable}`. Cacheable per posting.
  `verifiable: false` marks a requirement no portfolio can evidence
  ("proatividade", "dinamismo") — stage C excludes those from scoring entirely
  rather than counting them as failures (ADR-015).
- **B — Matching** _(LLM)_: per requirement, `met | partial | not_met`, **with a
  mandatory evidence quote** from the profile. `evidence: null` forces `not_met`.
  Cacheable per (posting, profile hash).
- **C — Score** _(code)_: pure, deterministic, unit-tested, no I/O, no LLM.

```
statusWeight = { met: 1.0, partial: 0.5, not_met: 0.0 }
score = 65 × mandatoryCoverage
      + 20 × desirableCoverage
      + 15 × trackAlignment
```

Empty category → coverage 1. A **blocking** requirement overrides everything: if
one fails, the score is capped at 35 and `blockingFailure` records which.
`partial` also blocks — an ATS knockout question is binary.

`trackAlignment` is a configured weight per track, looked up from the posting's
track, which the **pre-filter classifies deterministically** by keyword before
any LLM call. `dev` and `security` share `1.0` because they are equal first
priorities; `automation` is `0.7`; `unknown` is `0.4` and deliberately non-zero.
Highest weight wins when a posting matches several tracks.

**Verdict:** ≥70 `apply` · 45–69 `review` · <45 `discard`.

**Invalid LLM output is a normal outcome, not an exception** (ADR-006):
normalize → validate with Zod → bounded retries → typed failure result. A
posting that cannot be scored goes to the review section with `lowConfidence`,
never dropped and never throwing. `ScorerPort` returns a result type, matching
`CollectorPort`.

All weights and cutoffs are configurable and **provisional until calibration**
(M7). Reasoning, the `lowConfidence` rule, the honest limits of the model and the
calibration protocol: `docs/04-scoring-model.md`, ADR-005 and ADR-006.

## 9. Master profile

`config/profile.yaml` is the **source of truth**; the resume PDFs are projections
of it, not the other way around. It is **gitignored** — see §12.

Competencies are tagged by track (`dev`, `security`, `automation`), each with
`aliases` and **mandatory `evidence`** (at least one, enforced in the Zod schema).

**The resumes undersell.** The dev resume does not mention `atlas-manager`, which
is the strongest artifact. The master profile must include these, absent from the
PDFs but real and verifiable at `github.com/gustavopinto244/atlas-manager`:

- Clean Architecture with a ports-and-adapters boundary between domain,
  application and infrastructure
- Three infrastructure adapters (PM2, Docker, Compose) behind a single use case
- 35 ADRs, versioned CHANGELOG, release documentation, 230+ commits, v1.0.0
- Vitest + Supertest in CI (not merely "Jest fundamentals")
- Zod at the HTTP boundary, Pino JSON logs integrated with journald
- Cloudflare Access + application-level RBAC, JWT/JWKS with `jose`
- Auditable history of administrative mutations
- systemd, Nginx, GitHub Actions

### Academic period — derive in code, never hardcode

Systems Information at Universidade La Salle - RJ, starting **March 2026**,
expected completion **December 2029**. Semester system, 8 periods.

A hardcoded period silently ages into a lie. Count **academic semester
boundaries**, not elapsed months — in the Brazilian calendar the first semester
starts around March and the second around August, so March→August (5 months)
would give period 1 when it is already period 2.

```
absoluteIndex(year, month) = year * 2 + (month >= 7 ? 1 : 0)
period = absoluteIndex(today) - absoluteIndex(start) + 1
```

**`month` is 1-indexed here.** `Date.getMonth()` is 0-indexed, so the boundary
must be written `>= 6` against it, or the result is off by a full semester.
Clamp to `[1, 8]` and handle dates before the start.

**Product consequence:** period 2 as of 2026.2, period 3 in 2027.1. Many postings
ask for "3rd/4th period onward" and some cap graduation at 2028 — both ends can
block. The digest must therefore put period-blocked postings in **their own
section** ("opens for you in 2027.1"). That is planning information, not a
rejection.

### Fields still to be filled in

Marked `⚠ VERIFY` in the profile and tracked in `docs/01-vision-and-scope.md`:
**English level** (absent from both resumes, and a frequent knockout criterion),
**minimum stipend**, **maximum weekly hours**.

## 10. Hermes Agent boundary

Hermes Agent (Nous Research) runs as a personal assistant on a **different
machine**, not Atlas. This means the boundary M9 builds is a real network
boundary, not a same-box integration: ArgosCareer exposes a stable,
**authenticated** HTTP API and MCP server that Hermes reaches over Tailscale,
not localhost — a fixed Bearer API key, checked with a timing-safe
comparison, applied globally so every route (REST and `/mcp` alike) is
authenticated by default. Settled in [ADR-017](docs/adr/017-tailscale-and-bearer-key-for-the-api-boundary.md),
next to the code that implements it, same as every other non-obvious M9
call — Cloudflare Access/JWT (`atlas-manager`'s pattern) is the documented
upgrade path if a second consumer or public exposure ever arrives, not
built now.

**Do not implement this pipeline as a Hermes skill.** It would be faster and it
would destroy the project: the core would become third-party tool configuration,
with no reviewable code of its own, tied to a v0.x project that ships every two
weeks.

**Correct boundary:** ArgosCareer exposes the API; Hermes is a **consumer,
never the critical path.** The nightly digest goes out through a direct, dumb
Telegram client that works with Hermes down — and, now, with Hermes's whole
machine unreachable.

## 11. Git workflow

**Branches.** `main` is protected, no direct pushes. One branch per milestone:
`feat/m3-gupy-collector`, `fix/...`, `docs/...`, `chore/...`.

**Commits — Conventional Commits, in English, frequent.** Commit at every green
checkpoint (typecheck + tests passing), not at the end of a milestone. A commit
that leaves the repository broken does not go in.

```
feat(collector): add Gupy adapter with tolerant schema
test(scoring): cover blocking-requirement cap
docs(adr): record ADR-007 on the dedup strategy
```

**Pull requests.** One per milestone, against `main`. The description states what
changes, why, how to test, and what was left out. No green CI, no merge. Squash
merge. **If a milestone exceeds ~15 files, split it in two.**

**ADRs.** Every non-obvious decision becomes an ADR in `docs/adr/`, in the same
commit as the code implementing it. Format: context, considered options,
decision, consequences. Template at `docs/adr/000-template.md`, index at
`docs/03-technical-decisions.md`.

**CI is mandatory from M0:** lint, format check, typecheck, tests.

## 12. Privacy — the repository is public

In `.gitignore` since before the repository had any other content:

```
config/profile.yaml     # phone, e-mail, full resume
*.db  *.sqlite          # collected postings
.env  .env.*
test/fixtures/*-raw.json
```

`config/profile.example.yaml` is committed with fictional data and the complete
structure. **Never** commit a Telegram bot token, an API key, or personal data.
If asked to do something that would expose any of it, say so before doing it.

The full boundary — what counts as publishable and what does not — is ADR-004.

## 13. Language

**The repository is in English**: code, identifiers, documentation, ADRs, commit
messages, pull requests, LLM prompts.

**The Telegram digest is in pt-BR.** It is runtime output, read by one person,
about Brazilian postings. See ADR-003.

## 14. Milestones

| #   | Milestone           | Delivers                                                                                           | Status                                                               |
| --- | ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| M0  | Bootstrap           | `CLAUDE.md`, `docs/`, `.gitignore`, CI, ADR template, README                                       | done                                                                 |
| M1  | Domain + stage C    | Entities, fingerprint, score computation, unit tests                                               | done                                                                 |
| M2  | Master profile      | Zod schema, loader, `profile.yaml`, period derivation                                              | done                                                                 |
| M3  | Gupy collector      | Adapter + `fixture:gupy` + schema fitted to the real response                                      | done                                                                 |
| M4  | Persistence         | Drizzle + SQLite, migrations, dedup, `runs` table                                                  | done                                                                 |
| M5  | Pre-filter          | Configurable deterministic rules                                                                   | done                                                                 |
| M6  | **Vertical slice**  | Gupy → SQLite → Telegram with `StubScorer`. A real posting on the phone                            | done                                                                 |
| M7  | Real scoring        | Stages A and B, versioned prompts in `prompts/`, 50 labelled postings, calibration table in README | done (preliminary — 16/50 labelled, see README)                      |
| M8  | Deployment          | Docker Compose on Atlas, scheduling, backup, broken-adapter alert                                  | done (preliminary — local-model scoring retired, ADR-016)            |
| M9  | API + Hermes        | HTTP endpoints, MCP server, integration                                                            | done (preliminary — Hermes integration itself untested, see docs/10) |
| M10 | Market intelligence | Skill taxonomy, aggregate market analysis, gap analysis, study plan                                | done (preliminary — thin real data, docs/10)                         |

P1/P2 sources (Google Jobs, Indeed, LinkedIn) come after M6, one per pull
request.

**Scorer adapters:** `StubScorer` (fixed score, tests) → `ApiScorer`
(production, ADR-012/013/016). A local-model adapter (`OllamaScorer`) was
built and evaluated during M7/M8 and retired: it never finished a real
calibration pass (88% parse-failure against `qwen3:4b`, ADR-014), Atlas
never had Ollama installed, and `ApiScorer`'s real measured cost and memory
footprint (M7/M8: cents per batch, 29.3 MiB at rest) made the local-model
case moot. See ADR-016 for the full reasoning and what would justify
revisiting it.

## 15. How to work on this project

- **Disagree when I am wrong.** If a request contradicts the principles in §7 or
  the non-goals in §2, say so before doing it.
- **Do not invent a fact that can be checked.** If an API's shape is unknown,
  write tolerant code and build the script that discovers it — do not guess and
  move on.
- **Flag unverified hypotheses** in the code and in the pull request.
- **Explain trade-offs**, not just the choice. I am learning NestJS.
- Code comments explain **why**, not what.
- This is a personal portfolio project built in free time, with no deadline.
  **Rigor over speed.**

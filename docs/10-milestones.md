# 10 — Milestones and acceptance criteria

The milestone list existed from M0 with no definition of "done", which makes a
milestone a topic rather than a commitment. This page defines completion.

## Rules

- **One pull request per milestone**, against `main`, squash-merged with green
  CI. Over ~15 files, split it.
- **A milestone is done when every criterion below is demonstrable**, not when
  the code exists. "Demonstrable" means a command someone can run or an artifact
  someone can look at.
- **Non-obvious decisions become ADRs in the same commit** as the code
  implementing them (`03-technical-decisions.md`).
- Milestones are sequential. M6 is the exception worth protecting: it is a
  vertical slice, and slices that get postponed become slices that never happen.
- **A deferral is not a defect.** What a milestone chose not to build belongs
  here, under that milestone. Something that is actually broken belongs in
  `11-known-issues.md`, which is ordered by when it was found rather than by
  what was planned.

## M0 — Bootstrap ✅

Delivered in PRs #1 and #2, hardened in #3 and #4.

- [x] `CLAUDE.md` answers what to build and what never to do, without the
      original prompt
- [x] `docs/01`–`10`, ADR template, ADRs 001–008
- [x] `.gitignore` excludes profile, database, `.env` and raw fixtures — from
      before any other file existed
- [x] CI green on Node 22 and 24: lint, format, typecheck, test

## M1 — Domain and stage C ✅

- [x] `Posting` and `RawPosting` as distinct types, with the invariants in
      `05-domain-model.md` enforced
- [x] Fingerprint as a pure, unit-tested function in the domain layer
- [x] Stage C score computation: pure, deterministic, no I/O
- [x] `CollectorPort`, `ScorerPort`, `NotifierPort` defined, all returning
      failure as a value
- [x] NestJS skeleton (`AppModule`, `main.ts`, built and boots for real) with
      the `domain` / `application` / `infrastructure` / `composition` layering
      established; domain imports no framework. `application`,
      `infrastructure` and `composition` folders are not scaffolded empty —
      they land per bounded context starting M2, when something needs them
- [x] Unit tests covering every scoring branch: blocking cap including
      `partial`, empty-category coverage, `lowConfidence`, verdict boundaries at
      exactly 45 and 70, `trackAlignment` including `unknown` and multi-track
- [x] **`--passWithNoTests` removed from `npm test`**
- [x] TypeScript 7 reassessed against Nest's `emitDecoratorMetadata` (ADR-002
      Amendment 2) — the metadata concern is unfounded, `typescript-eslint`
      refusing to run under TS 7.0 is the real blocker; staying on 6.0.3

## M2 — Master profile ✅

- [x] Zod schema for `config/profile.yaml`, rejecting a competency with no
      `evidence`
- [x] Loader failing loudly at startup with the file and field named
- [x] `config/profile.example.yaml` committed, fictional, structurally complete
      — guarded by a test asserting it stays valid against the schema
- [x] Real `config/profile.yaml` written, including the `atlas-manager` evidence
      absent from both resumes
- [x] Academic period derived at runtime, unit-tested at the two boundaries the
      0-indexed month bug would break: August 2026 → 2, March 2027 → 3.
      Also fixed to UTC getters after the local-timezone form failed under
      this sandbox's America/Sao_Paulo clock — see the commit
- [x] `⚠ VERIFY` fields present and visibly unanswered: English level, minimum
      stipend, maximum weekly hours
- [x] `resumeVariants` in the schema — named subsets of the profile, holding no
      prose (`05-domain-model.md`)

## M3 — Gupy collector ✅

- [x] `npm run fixture:gupy` hits the real API, writes
      `test/fixtures/gupy-raw.json` (gitignored), prints the first item's keys
- [x] Tolerant Zod schema fitted to the **observed** response, not a guess
- [x] Curated fixture committed, derived by hand from the raw capture, with
      recorded provenance (`07-testing-strategy.md`)
- [x] Adapter never throws — contract tests for non-200, timeout, malformed
      body, empty body, connection reset
- [x] Polite behavior verified: `robots.txt` (checked on both domains —
      neither exists), ~1.5 s interval, honest `User-Agent`, backoff, explicit
      timeout
- [x] `docs/02` updated: the Gupy schema moves out of "unverified assumptions"
      into a documented, verified shape

## M4 — Persistence ✅

- [x] Drizzle + SQLite, migrations runnable forward from empty — verified
      against a real file: both tables created from empty, re-run idempotent
- [x] Schema implementing the stage keys in ADR-007, writes as upserts
- [x] **`firstSeenAt` written once and never overwritten by re-collection**, with
      a test asserting a second upsert leaves it unchanged and moves
      `lastSeenAt` (ADR-007 amendment)
- [x] Rejected postings retained — the corpus is not a cache. Nothing in the
      codebase deletes a posting row; `markDuplicate` flags without removing
- [x] `runs` table with per-stage counts
- [x] Deduplication: fingerprint layer (the repository's unique index), then
      same-company similarity layer (ADR-010). Algorithm changed twice during
      development after being measured against the docs' own motivating
      example and failing it — see ADR-010's Considered options
- [x] Each stage invocable independently from the CLI — the actual test of
      principle 2. `dedup` re-scans the corpus with no collector and no
      network involved at all
- [x] Integration tests against a real temporary SQLite file
- [x] ADR recording the dedup algorithm and its similarity threshold
      (ADR-010), including a real false-positive found running against live
      data, not only the cases used to pick the threshold

## M5 — Pre-filter ✅

- [x] Every rule from `02-architecture.md`, each configurable in
      `config/criteria.yaml`
- [x] Deterministic track classification feeding `trackAlignment` — verified
      through the real `computeTrackAlignment` function, not reimplemented
- [x] `location` and `workMode` filtered as separate axes, both allowing
      `unknown` without silently discarding or accepting (ADR-011)
- [x] Every rejection records a reason (`05-domain-model.md`)
- [x] **The ~70% cut estimate measured** against real collected volume, and
      `docs/02` updated with the real number — turned out to be two numbers,
      97.1% nationwide and 84.2% city-narrowed, with the gap itself the
      actionable finding for M8's collection strategy
- [x] Unit tests per rule, plus ordering — 24 tests including 4 proving the
      short-circuit sequence on postings that fail multiple rules at once

## M6 — Vertical slice ✅ 🎯

The milestone that proves the project is real.

- [x] Gupy → SQLite → Telegram end to end with `StubScorer` — `argos collect`
      → `argos dedup` → `argos deliver`, run for real against the live Gupy
      API on 2026-08-14
- [x] **A real posting arrives on the phone** — 6 real postings, delivered
- [x] Digest in pt-BR per the `06-glossary.md` mapping
- [x] Period-blocked postings in their own section ("opens for you in
      2027.1") — the section renders and is tested, but nothing populates it
      with real data yet: no stage exists before M7 that reads a posting's
      text closely enough to detect a stated period requirement, so this
      section is honestly empty in every real run so far
- [x] Run summary in the digest: collected, deduped, filtered, scored, plus any
      source that failed
- [x] A posting already notified is never notified again (ADR-007)
- [x] One end-to-end test with a notifier double

**Real-run finding, folded back into `config/criteria.yaml`:**
`minKeywordAdherence` matches only against a posting's _title_ — `Posting`
has no `description` field yet — and real Gupy titles are short enough that
this rejected good, on-track matches (e.g. "Estágio em Desenvolvimento
Backend", remote). Set to `0` until `Posting` carries a description stage A
can read.

## M7 — Real scoring ✅ (preliminary)

**Done against 16 hand-labelled postings, not the 50 the protocol calls for.**
Real Gupy volume for this search profile is thin (consistent with ADR-011's
84–97% pre-filter cut) — 16 is what exists to label today. Closed rather than
left open-ended because every criterion below that does not explicitly depend
on sample size is demonstrable now; re-run from README's Calibration section
once 50 labelled postings exist, which happens as the corpus grows, not on
demand.

- [x] Stages A and B implemented, prompts versioned in `prompts/`
- [x] ADR-006 policy implemented and tested: fences, prose, truncation, invented
      enums, `met` with `evidence: null` → `not_met`
- [x] `ApiScorer` first, `OllamaScorer` second — in that order, because a
      15-minute local batch per iteration means calibration never finishes.
      `OllamaScorer` ended up built alongside `ApiScorer` rather than after
      it — pulled forward from M8 to avoid real API spend once OpenRouter's
      free-tier daily cap (50 requests/account) turned out to be too low to
      finish even one calibration pass
- [x] **16 real postings labelled by hand, before looking at model output** —
      50 deferred to whenever the corpus grows enough to label them; tracked
      above, not abandoned
- [x] Correlation and verdict precision/recall measured against a complete,
      stable configuration (`deepseek/deepseek-v4-flash-0731`, `b-v2` prompt):
      correlation 0.522, discard recall 100% (64% precision), apply recall 0%.
      Two earlier attempts against OpenRouter's free tier produced no
      measurement at all (auto-router instability, then a rate cap too low
      to finish one pass) — kept as rows in README's table rather than
      discarded, since the fix for both is itself a documented decision
      (ADR-012, ADR-013)
- [x] Parse-failure rate measured per candidate model (ADR-006): 88%
      (`qwen3:4b`/Ollama, request timeouts under CPU contention) vs. 0%
      (`deepseek-v4-flash-0731`/OpenRouter)
- [x] **Calibration table published in the README, including configurations
      that lost**
- [x] `seniority` and `experienceYears` extracted as fields, not inferred from
      the title alone (`05-domain-model.md`)
- [x] `recommendedVariant`, `highlights` and `missingTerms` emitted — pure
      functions over stage B output, no extra model call
- [x] Weights and thresholds explicitly kept with a reason (README's
      Calibration section): the one complete measurement came from inputs
      later found broken, and 16 samples is too few to retune against without
      overfitting to noise. **What did change**, from auditing that
      measurement posting-by-posting rather than from tuning the formula
      itself: a data backfill (129/523 postings had a silently empty
      `description`), quotable evidence for academic enrollment that existed
      as a field but was never rendered, excluding unfalsifiable trait
      requirements from coverage, and `trackAlignment` exclusion phrases for
      two words ("desenvolvimento", "segurança") that were misclassifying 19%
      of the corpus (ADR-014, ADR-015) — followed, after that measurement, by
      the same rendering gap found again in `englishLevel`, `maxWeeklyHours`
      and `minimumStipend`, fixed but only spot-checked against a 5-posting
      subset, not yet re-measured at n=16.

**Real findings, kept rather than discarded:**

- OpenRouter's `openrouter/free` auto-router changes the underlying model on
  every request. Calibrating against it measures nothing stable — the
  "model" variable was never held constant, which the protocol requires.
- OpenRouter's free tier caps at 50 requests/account/day, shared across every
  `:free` model. 16 postings × (1 extraction + several match calls each)
  exceeds that in a single run — the free tier cannot finish even one pass,
  let alone the several needed to compare configurations.
- `qwen3:4b` via `OllamaScorer` technically ran (unlike the two above) but
  hit an 88% parse-failure rate: a thinking model's hidden reasoning
  exceeded `OllamaClient`'s request timeout under CPU contention on
  non-dedicated hardware. Not evidence against `OllamaScorer` as the eventual
  production adapter (CLAUDE.md §14) — Atlas is dedicated hardware and the
  timeout is configurable — but evidence that a real run needs one or the
  other before it can complete.
- Auditing the first complete `deepseek-v4-flash-0731` run posting-by-posting,
  not just its aggregate correlation, is what actually found the structural
  fixes above. The aggregate number alone (-0.097) would have pointed at
  "recalibrate the weights"; the per-posting audit pointed at broken inputs
  and two rule gaps instead — see ADR-014 and ADR-015 for why that
  distinction mattered.

## M8 — Deployment ✅ (preliminary — see the two deferrals below)

**Done.** Three PRs, in order: scheduling + alerting (code, no infra) →
backup/restore → Docker Compose + real deployment + real measurements.
Every criterion below is demonstrable now; the two left unchecked are
deliberate deferrals with a stated reason, not gaps.

- [x] `schedule` and `alerts` sections added to `config/criteria.yaml` and
      `CriteriaSchema` (`docs/09-configuration.md`'s spec, now read by code)
- [x] Scheduling live in-process: `@nestjs/schedule` wired through
      `SchedulerService`, two independent crons per ADR-009 (collection every
      `schedule.collection.intervalHours`, score+deliver daily at
      `schedule.scoreAndDeliver.time`/`timezone`), registered dynamically
      via `SchedulerRegistry` since the expressions are only known once
      `criteria.yaml` loads. **Deployed and confirmed running on Atlas**,
      2026-08-15: the container logs the same "Scheduled: collection every
      4h, scoreAndDeliver daily at 03:00 America/Sao_Paulo" line verified
      locally, and a manual trigger of both cycles inside the real deployed
      container produced real `runs` rows (a `collect` of 50 real Gupy
      postings, 41 new; a `deliver` cycle that correctly found 0 postings
      past the pre-filter and still completed). The collection cron's next
      _automatic_ fire (server is UTC, `0 */4 * * *`) was ~3h out at
      deployment time — not sat through live; the manual trigger exercises
      the identical code path the cron calls, so this is the same evidence
      a wait would have produced, sooner.
- [x] Alerts from `08-observability.md` live: `evaluateCollectionHealth`
      (consecutive empty/errored collection runs), `evaluateDeliveryOutcome`
      (delivery failure, scoring failure rate), `evaluateMissedRuns` (missed
      `scoreAndDeliver` alerts on the first miss, missed `collection` alerts
      only after two — ADR-009's stated asymmetry). Delivered through
      `TelegramNotifier.sendText`, the same client as the digest.
- [x] Docker Compose on Atlas. Multi-stage `Dockerfile` (`better-sqlite3`
      compiles its native binding from source — no prebuilt binary for this
      platform, found in PR 2's restore rehearsal — so the build stage needs
      a C++ toolchain the runtime stage does not carry) and
      `compose.production.yaml` (no exposed ports; `config/profile.yaml`
      bind-mounted read-only, never baked into an image layer, ADR-004;
      `.env` is `env_file`, not `COPY`'d; `data/` and `backups/` are named
      volumes). **Deployed for real on Atlas**, 2026-08-15, via the same
      `~/apps/<name>/app` layout `portfolio` and `task-manager` already use.
- [x] `OLLAMA_KEEP_ALIVE=0` — **N/A, `OllamaScorer` retired (ADR-016)**.
      Deferred as of the M8 close-out above; superseded once it became clear
      the deferral had no path back — Ollama was never installed on Atlas,
      `OllamaScorer` never finished a real calibration pass (M7: 88%
      parse-failure), and `ApiScorer`'s real measured cost and memory
      footprint left no case for reopening it. Local-model scoring is no
      longer part of this project's roadmap; ADR-016 records what would
      have to be true to revisit it.
- [x] **Memory measured under real load**, `docs/02` updated with the real
      figure: **29.3 MiB at rest**, real `docker stats` on Atlas, well under
      the ~150 MB budget. A real `collect` and a real `deliver` cycle both
      left it unchanged — `ApiScorer` makes HTTP calls and holds nothing
      large in-process, so there is no local-model load/unload swing to
      measure. That `deliver` cycle found 0 postings past the pre-filter, so
      Stage A/B were not exercised under real traffic; genuine peak-under-
      scoring-load is the number to revisit once a night's cron actually has
      postings to score.
- [x] Database backup, and a restore actually rehearsed. `VACUUM INTO` a
      timestamped file (retention: 7), chained after the nightly
      `scoreAndDeliver` cycle. **Rehearsed for real on Atlas, 2026-08-15** —
      not just written: cloned the branch there, `npm ci` (found and fixed a
      real gap doing this: `better-sqlite3` compiles from source, no
      prebuilt binary for this platform, so `build-essential`/`python3`
      became a genuine dependency, installed on Atlas and worth remembering
      for PR 3's Dockerfile), collected 20 real Gupy postings, backed up,
      deleted the live database entirely (simulating total loss), restored
      from the backup, and confirmed all 20 postings came back — count and
      sample data both matched. Scratch directory cleaned up afterward; the
      real deployment (PR 3) starts clean.
- [ ] **n8n's memory footprint measured** — **not applicable this pass**. No
      `N8nCollector` exists in code yet (still in the "after M6" backlog,
      unimplemented), so there is nothing to measure.

## M9 — API and Hermes ✅ (preliminary — see the deferral below)

**Done.** Four PRs, in order: HTTP bootstrap + auth guard + read-only
inspection → stage re-execution → MCP server → Tailscale publish + ADR.
Every criterion below is demonstrable now; the one left unchecked is a
deliberate deferral with a stated reason, not a gap.

- [x] HTTP endpoints for stage re-execution and run inspection —
      `GET /health`, `GET /runs`, `GET /runs/:runId`, `POST /runs/collect`,
      `POST /runs/dedup`, `POST /runs/deliver`, all thin over one
      `RunsService` so REST has exactly one implementation of "run collect"
- [x] Health endpoint reporting last successful run per kind — verbatim to
      `docs/08-observability.md`'s spec, `{collect, dedup, scoreAndDeliver}`
- [x] MCP server — `POST /mcp`, six tools mirroring the REST routes
      (`get_health`, `list_runs`, `get_run`, `run_collect`, `run_dedup`,
      `run_deliver`), calling the same `RunsService`. Found and fixed a real
      SDK requirement while wiring it up: `StreamableHTTPServerTransport` in
      stateless mode cannot be reused across requests — a fresh
      `McpServer`/transport pair is built per request, not held for the
      app's lifetime, discovered by reproducing a 500 on every session's
      second message against a real running server, not a test artifact
- [ ] **Hermes consuming it — not exercised.** This session has no second
      Hermes instance, on a second tailnet-joined machine, to configure and
      drive a real cross-machine call against. What is verified for real
      instead, on Atlas itself over its own Tailscale IP
      (`100.112.68.45:3000`): the container is bound only to that interface
      (`docker port` confirms `3000/tcp -> 100.112.68.45:3000`, not
      `0.0.0.0`; no listener on `127.0.0.1:3000` belongs to it — that port
      is a pre-existing, unrelated host process), `GET /health` returns 200
      with a valid key and 401 with a missing or wrong one, and
      `POST /mcp`'s `initialize` call succeeds. The boundary is built and
      reachable; a real remote Hermes call is out of reach here, recorded
      honestly rather than assumed. "The nightly digest still working while
      Hermes is stopped" is trivially true today — nothing consumes the API
      yet — and stops being a meaningful test until Hermes exists to stop.
- [x] n8n consuming the API for side effects — **real as of PR #64
      (ADR-029):** the user's n8n workflow POSTs LinkedIn alert-email
      extractions to `POST /runs/collect/external`, the same
      `ApiKeyGuard`-authenticated boundary ADR-027 built for Indeed. This is
      the P2 LinkedIn source (`After M6`), not the P3 `N8nCollector` behind
      `CollectorPort` this criterion originally meant — that one still does
      not exist in code. Kept checked because the underlying claim ("n8n can
      consume this API for a real side effect") is now demonstrated for
      real, by a different source than first planned.
- [x] ADR recording the API boundary — [ADR-017](adr/017-tailscale-and-bearer-key-for-the-api-boundary.md):
      Tailscale over the existing Cloudflare Tunnel pattern (the only
      intended caller is one already-tailnet-joined machine, not the public
      internet), a fixed Bearer key over Cloudflare Access/JWT (one trusted
      consumer, simple and auditable, with the upgrade path documented).
      **Deployed for real on Atlas**, 2026-08-15, from the PR branch
      (`~/apps/argos-career/app`, the same layout `portfolio` and
      `task-manager` use): `docker compose up -d --build`, `API_KEY`
      generated on Atlas itself with `openssl rand -hex 32`,
      `ATLAS_TAILSCALE_IP` set to the confirmed interface IP. `POST
/runs/deliver` is deliberately reachable through this same
      boundary — real API spend and a real Telegram send, remotely
      triggerable by design, not a footgun left undocumented (ADR-017).

## M10 — Market intelligence and gap analysis ✅ (preliminary — thin real data, see below)

**Done.** Three PRs, in order: skill taxonomy → aggregate queries and gap
analysis → study plan delivery (CLI, REST, MCP). Every criterion below is
demonstrable now; real output is honestly thin for the same reason M7's
calibration sample was — recorded below, not hidden behind a big corpus
number that would overstate what the model has actually seen.

- [x] **Skill taxonomy**: `config/taxonomy.yaml`, canonical skill names with
      aliases, so `Postgres`, `PostgreSQL` and `postgre` count as one.
      Global, not derived from the profile — profile aliases would only
      count what is already known (`docs/01-vision-and-scope.md`)
- [x] Taxonomy applied retrospectively over stored stage A extractions,
      without re-running extraction (ADR-007) — `findSkills` runs over
      `extractions.requirements` as already cached, no LLM call
- [x] Aggregate queries over the corpus: most requested technologies,
      recurring competencies (one ranked list — the taxonomy already spans
      both), typical experience level, regions, companies hiring most,
      work-mode distribution
- [x] **Gap analysis**: skills frequent in high-compatibility postings
      (verdict `review`/`apply`) and absent from the profile, ranked by
      frequency
- [x] Time series over `firstSeenAt` (weekly buckets), answering how the
      market moved
- [x] Study plan ordered by measured demand, delivered to Telegram on
      request — `argos studyplan`, `POST /market/study-plan`,
      `get_study_plan` MCP tool, three surfaces over one `executeStudyPlan`
- [x] Aggregates computed over the **whole corpus including rejected
      postings** (`05-domain-model.md`) — `findActive()` only excludes
      similarity-duplicates (ADR-010), never pre-filter rejects or
      `discard`-verdict postings

**Real run, 2026-08-15, against the local corpus** (`npm run cli --
studyplan`, real Telegram send): **380 active postings** (523 collected,
143 marked similarity-duplicates), **16 with a current-prompt-version
Stage A extraction**, **1 high-compatibility posting** (verdict `review` or
`apply`), **1 gap identified**. The 16-extraction figure is the same M7
calibration sample this project has cited since M7 — Stage A still has not
run at volume in production (M9's close-out: the one real nightly `deliver`
cycle found 0 postings past the pre-filter), so market/gap-analysis output
today reflects a 16-posting sample, not the 380-posting corpus. This is not
a code gap: `aggregateCorpus`/`gapAnalysis` are correct over whatever data
exists, and correctly report `extractedCount`/`highCompatibilityCount`
alongside every percentage so a reader can see exactly how thin the sample
is rather than being shown a misleadingly precise-looking number. Growing
past this is a data problem — either the pre-filter/criteria let more
postings reach Stage A, or a deliberate broader extraction pass is run —
not a code problem this milestone leaves unsolved.

No ADR: neither of the two candidate decisions flagged in planning (reusing
the `review`/`apply` verdict cutoff for "high-compatibility," and the
taxonomy's whole-word/substring matching strategy) turned out to be costly
to reverse — both are pure-function implementation choices with nothing
persisted that would need migrating if either changed.

## After M6 — additional sources

One per pull request, each meeting the M3 criteria:

- [x] Google Jobs / Indeed via ephemeral `--rm` Python container — **Indeed
      only, live on Atlas since 2026-08-16** (ADR-027, ADR-028;
      `collectors/indeed/`, systemd-scheduled twice daily). Google Jobs
      itself was probed and returned zero results — not pursued, not
      implemented
- [x] LinkedIn, **not scraped** — the user's own opt-in job-alert emails,
      parsed by an n8n workflow the user controls and POSTed to the same
      `/runs/collect/external` boundary ADR-027 built for Indeed
      (`linkedin-alert-schema.ts`, `linkedin-alert-normalizer.ts`, ADR-029,
      PR #64). Never authenticates with a personal LinkedIn session or
      cookies (`CLAUDE.md` §3) — no LinkedIn endpoint is queried at all. The
      receiving side is in this repository and tested; which alert searches
      to subscribe to and wiring the n8n workflow itself are the user's own
      infrastructure, not tracked here. A real, permanent limit, not a gap:
      the alert email carries no description, so a LinkedIn posting always
      trips `lowConfidence` and caps at `review`, never `apply`
- [x] Sólides Vagas, via its own undocumented public JSON API (ADR-031;
      `solides-schema.ts`, `solides-normalizer.ts`, `solides-collector.ts`).
      Found by inspecting `vagas.solides.com.br`'s real network requests, not
      published anywhere — same "public JSON, no auth" shape as Gupy, meeting
      every M3 criterion: `npm run fixture:solides` against the real API,
      tolerant Zod schema, curated fixture with provenance
      (`solides-jobs.md`), contract tests for non-200/timeout/malformed/
      empty/connection-reset, `robots.txt` checked (the API host has none —
      a generic API-gateway 403, not a block), honest User-Agent, ~1.5s
      interval, backoff, explicit timeout. Registered in both
      `collector-registry.ts` and `normalizer-registry.ts`; nine queries
      added to `config/criteria.yaml` (three terms × the same three RJ-metro
      cities Gupy already queries). **Not yet run for real** — wired and
      unit-tested against a curated fixture, same honest status M3 itself
      records for Gupy before its own vertical-slice run; a real collection
      cycle, and the Gupy/Sólides overlap measurement `docs/02` flags as
      pending, are the natural next check
- [ ] Catho, via a real headless browser (ADR-032/033; `catho-schema.ts`,
      `catho-normalizer.ts`, `collectors/catho/`). No public API and no
      server-side search reaches this project (`robots.txt` disallows
      exactly that path) — sitemap-only candidate discovery
      (~6,800 title-matched postings nationwide, measured 2026-08-17),
      Playwright opening each one with a genuinely honest browser
      User-Agent, never a forged one (ADR-020). Breaks no CLAUDE.md §6
      rule, unlike Indeed's ADR-028 exception. Registered in
      `normalizer-registry.ts` only — ingestion is external
      (`POST /runs/collect/external`), same shape as Indeed/LinkedIn, never
      a `CollectorPort` entry.
      **Run for real and confirmed non-functional, 2026-08-17**
      (`docs/audit/AUDIT-PRE-DEPLOY-2026-08-17.md`): Catho blocks
      Playwright's default headless Chromium with the same `403`
      non-browser clients get — 0 of 10 real pages collected in a live
      test. Not a rule-honesty problem (a headless Chromium's UA is still
      genuine, ADR-020); a fingerprint-level block this collector does not
      yet get past. **Do not build/schedule on Atlas.** A separate repo
      audit (`docs/audit/AUDIT_REPORT.md` AC-001/AC-002) also found two
      real checkpoint bugs — an ID marked done before ingest was confirmed,
      and transient failures recorded as permanent expiration — fixed
      regardless of the block (ADR-033, `collectors/catho/state.ts`, 27
      tests), since they're correct to have whenever this collector does
      get unblocked
- [x] InfoJobs, via listing scrape + detail-page `application/ld+json`
      (ADR-063; `infojobs-schema.ts`, `infojobs-listing-parser.ts`,
      `infojobs-normalizer.ts`, `infojobs-collector.ts`). No JSON API found
      — the listing page is server-rendered HTML with no embedded job data
      (a scoped regex reads each result card's `data-id`/`data-href`, not a
      new HTML-parser dependency), but each detail page carries a clean,
      structured `schema.org/JobPosting` block. Location filtering is a
      friendly-URL suffix, found by reading the site's own facet links, not
      the legacy `?provincia=` query param (silently unfiltered). Meets
      every M3 criterion: `npm run fixture:infojobs` against the real site,
      tolerant Zod schema, curated fixture with provenance
      (`infojobs-jobs.md`), contract tests including one that caught a real
      bug before shipping (one failing detail page was aborting an entire
      collection cycle instead of being skipped per item), `robots.txt`
      checked (open for every path this collector queries), honest
      User-Agent, paced requests, backoff, explicit timeout. Registered in
      both `collector-registry.ts` and `normalizer-registry.ts`; four
      queries added to `config/criteria.yaml` (`estagio ti`/`estagiario ti`
      × Rio de Janeiro/remote, each measured live before being added).
      **Not yet run for real** — wired and unit-tested against a curated
      fixture, same honest status this project records for every source
      before its own first live collection cycle
- [x] NerdIn, an IT-only Brazilian board (ADR-071) — listing scrape +
      detail JSON-LD, the same shape as InfoJobs, but with
      `jobLocationType` and `addressCountry` stated by the source so
      `workMode` and `country` are read rather than inferred. One
      measured query (`estagi`, 9 returned / 2 passing). RemotIn and
      Programathor were investigated in the same pass and rejected —
      robots.txt and 100%-expired stock respectively. First real collection
      ran 2026-08-27: 9 returned, 0 schema-rejected, 2 persisted, 7 dropped
      by the collection recency window (a new source gets `backfillDays: 7`,
      and those were published 02–07/08)
- [ ] **NerdIn: set `alerts.sourceFreshnessHours.nerdin`** — due on or after
      **2026-09-03**, deliberately left unset at first (ADR-071). An unlisted
      source is simply not checked, and with 9 postings in live stock the
      real publication cadence was unknown; a window guessed on day one would
      alert on a source behaving normally, which is the noise ADR-064 had to
      remove for LinkedIn. Set it from a week of observed `first_seen_at`
      gaps, not from a wish — measure the longest real gap and add slack for
      one missed cycle, the way `gupy: 72` and `indeed: 36` were each
      derived. If a week of runs shows NerdIn delivering nothing at all, the
      decision is to park the query (as Sólides was), not to add a window to
      a dead source
- [ ] `N8nCollector` behind `CollectorPort`, with one long-tail source proving
      it (ADR-008). Workflow exported and committed to `n8n/`; core verified
      unaffected with n8n stopped

## Next up — agreed 2026-08-27

Three things, in the order they unblock each other. None is a milestone of
its own; they are the work that turns what already ships into something
exercised.

### 1. Watch the features that just landed, for a few days

Eleven PRs merged on 2026-08-26/27 changed what reaches the digest, and
several are verified only against one run. What needs a real week before it
can be called done:

- **Cost.** The 27/08 run scored 18 and cost US$0.023 against a 10-day
  baseline of 10.2 scored and US$0.005. Cost per _delivered_ posting went
  from US$0.00138 to US$0.00194 — on n=1, with 3 scoring failures in that
  run, so it is not conclusive. ADR-070 Amendment 3 roughly doubled what
  Indeed sends to the pre-filter, so the next runs are the real measurement.
  National scoring is uncapped by decision (ADR-068); this is monitored, not
  contained.
- **`stillListedWithinHours: 30`** (ADR-066) has no steady-state
  observation, and its accepted cost is a 67-day-old still-listed posting
  getting scored. If zombies turn out to be common, that is when an age
  ceiling gets argued for — with a measurement, not a guess.
- **NerdIn** (ADR-071) has 2 postings in the corpus and one collection
  behind it. `npm run report:supply -- --weeks 2` decides whether it stays;
  `onTrackInRegion: 0` means parking the query, as Sólides was.
- **The international path** (ADR-068) has never met a real foreign posting.
  It is unit-tested only, and `maxInternationalPerRun` is still `null`.

### 2. Run n8n on Atlas

Today n8n lives on the operator's own infrastructure, off Atlas, and its
only job is feeding LinkedIn alert emails into `/runs/collect/external`.

**Why this is next, concretely:** LinkedIn has never landed a posting —
37 items received across five real ingest runs, 37 rejected (docs/11 B15).
The cause is narrowed to one field: `normalizeLinkedinAlertJob` rejects when
`deriveSourceIdFromLink` finds no `/jobs/view/<digits>` in `link`. ADR-064
added `linkShape` so the next real delivery records the masked shape of that
value, but **no new delivery has arrived since**. With n8n on Atlas the
workflow's actual output becomes inspectable directly, which collapses a
wait-and-see into a look-and-fix.

Worth carrying over: ADR-008 places n8n behind `N8nCollector` as a P3
long-tail source and **never as the orchestrator, never on the critical
path**. Moving where it runs does not change that.

### 3. Give Hermes on Aquila something to do

M9 built the API and MCP server for exactly this and left the consuming half
unchecked (see the M9 deferral above): there was no second tailnet machine
to drive a real cross-machine call from. **There is now** — `aquila` is on
the tailnet.

This is what makes ADR-017's boundary real rather than theoretical: a fixed
Bearer key over Tailscale, timing-safe compared, every route authenticated
by default. The MCP tools (`get_health`, `list_runs`, `get_run`,
`run_collect`, `run_dedup`, `run_deliver`, `cancel_run`, `discard_posting`,
`get_study_plan`, and — added by ADR-072 specifically so Hermes has a real
corpus query to run, not only stage triggers — `list_postings`,
`mark_applied`, `unmark_applied`) have never been called by a real
consumer.

The constraint from CLAUDE.md §10 stands and is the point: **Hermes is a
consumer, never the critical path.** The nightly digest goes out through the
direct Telegram client and must keep working with Hermes — and Aquila —
entirely down.

## Where question 3 lands

"How should I present my profile?" is not a milestone of its own — it is output
that falls out of work already planned:

- **M2** adds `resumeVariants` to the profile schema
- **M7** emits `recommendedVariant`, `highlights` and `missingTerms`
- **M6/M7** render them in the digest entry

Generating prose is Phase 3 and stays out.

## Out of v1

Phase 2 feedback (what was applied to, what got a response) and Phase 3
generated communication — resume text, cover letters, recruiter messages.
Recorded in `01-vision-and-scope.md` so they stay out.

Junior and entry-level roles are also out, reconsidered and kept out; the
reasoning and the two observable conditions for revisiting are in
`01-vision-and-scope.md`.

# 03 — Technical decisions

Every non-obvious decision in this project becomes an Architecture Decision
Record in `docs/adr/`. This page is the index and the rules.

The practice is carried over from `atlas-manager`, where 35 ADRs turned out to be
the most useful thing in the repository — not because decisions get made better,
but because six months later the reasoning is still there and a decision can be
revisited on its merits instead of re-argued from memory.

## Index

| ADR                                                                           | Title                                                                               | Status     | Date       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ---------- |
| [001](adr/001-nestjs-as-application-framework.md)                             | Use NestJS as the application framework                                             | Accepted   | 2026-08-14 |
| [002](adr/002-commonjs-module-system.md)                                      | Build on CommonJS with a strict TypeScript configuration                            | Accepted   | 2026-08-14 |
| [003](adr/003-english-repository-language.md)                                 | Write the repository in English, deliver the digest in pt-BR                        | Accepted   | 2026-08-14 |
| [004](adr/004-public-repository-privacy-boundary.md)                          | Draw an explicit privacy boundary for a public repository                           | Accepted   | 2026-08-14 |
| [005](adr/005-llm-does-not-produce-the-score.md)                              | Keep score computation out of the LLM                                               | Accepted   | 2026-08-14 |
| [006](adr/006-llm-output-failure-policy.md)                                   | Treat invalid LLM output as a normal outcome                                        | Accepted   | 2026-08-14 |
| [007](adr/007-stage-re-execution-and-idempotency.md)                          | Make stages re-runnable through persisted state                                     | Accepted   | 2026-08-14 |
| [008](adr/008-n8n-as-pluggable-adapter.md)                                    | Use n8n as a pluggable adapter, never as the orchestrator                           | Accepted   | 2026-08-14 |
| [009](adr/009-nightly-batch-window.md)                                        | Confine scoring and delivery to a single nightly window                             | Accepted   | 2026-08-14 |
| [010](adr/010-similarity-dedup-algorithm.md)                                  | Character-bigram Dice similarity for layer 2 dedup                                  | Accepted   | 2026-08-14 |
| [011](adr/011-pre-filter-rules-and-thresholds.md)                             | Pre-filter rules, ordering, and the unknown-axis leniency rule                      | Accepted   | 2026-08-14 |
| [012](adr/012-openrouter-as-the-api-scorer-provider.md)                       | Use OpenRouter as the `ApiScorer` provider                                          | Accepted   | 2026-08-14 |
| [013](adr/013-deepseek-v4-flash-and-cache-friendly-stage-b.md)                | Calibrate against DeepSeek V4 Flash, reorder Stage B for prompt caching             | Accepted   | 2026-08-15 |
| [014](adr/014-calibration-input-integrity.md)                                 | Fix the inputs before spending another calibration run                              | Accepted   | 2026-08-15 |
| [015](adr/015-verifiable-requirements-and-track-exclusions.md)                | Score only what a candidate could evidence, and stop matching homonyms              | Accepted   | 2026-08-15 |
| [016](adr/016-retire-ollama-scorer.md)                                        | Retire `OllamaScorer`; `ApiScorer` is the permanent production adapter              | Accepted   | 2026-08-15 |
| [017](adr/017-tailscale-and-bearer-key-for-the-api-boundary.md)               | Tailscale networking and a fixed Bearer key for the HTTP/MCP boundary               | Accepted   | 2026-08-15 |
| [018](adr/018-collection-queries-as-configuration.md)                         | Ask the source a narrow question, and treat a cycle as one run                      | Accepted   | 2026-08-15 |
| [019](adr/019-collect-by-publication-recency.md)                              | Collect by publication recency, with a wider first run                              | Accepted   | 2026-08-15 |
| [020](adr/020-lift-the-memory-budget-allow-a-browser.md)                      | Lift the memory budget, allow a headless browser                                    | Accepted   | 2026-08-16 |
| [021](adr/021-enable-ciee-and-tighten-location-leniency.md)                   | Enable CIEE, and tighten the location leniency rule                                 | Accepted   | 2026-08-16 |
| [022](adr/022-bounded-concurrency-in-stage-b.md)                              | Run Stage B's requirement calls concurrently, bounded, warming the cache            | Accepted   | 2026-08-16 |
| [023](adr/023-manual-discard-independent-of-scoring.md)                       | A manual, permanent discard, independent of scoring and profile                     | Accepted   | 2026-08-16 |
| [024](adr/024-scheduler-overlap-guard.md)                                     | An in-process guard against two runs of the same kind overlapping                   | Accepted   | 2026-08-16 |
| [025](adr/025-unknown-track-score-cap.md)                                     | Cap the score of a posting that matches no configured track                         | Accepted   | 2026-08-16 |
| [026](adr/026-recalibrate-toward-track-fit.md)                                | Recalibrate the score weights toward track fit                                      | Accepted   | 2026-08-16 |
| [027](adr/027-indeed-via-external-jobspy-and-authenticated-ingest.md)         | Indeed via an external `jobspy` process, ingested through the API boundary          | Accepted   | 2026-08-16 |
| [028](adr/028-indeed-exception-to-the-polite-collector-rule.md)               | Accept, deliberately, that Indeed via jobspy breaks two collector rules             | Accepted   | 2026-08-16 |
| [029](adr/029-linkedin-alert-emails-via-n8n.md)                               | LinkedIn via the user's own job-alert emails, extracted by n8n                      | Accepted   | 2026-08-16 |
| [030](adr/030-cloudflare-tunnel-for-the-n8n-cloud-caller.md)                  | A Cloudflare Tunnel route, Bearer-only, for the n8n.cloud caller                    | Accepted   | 2026-08-16 |
| [031](adr/031-solides-collector.md)                                           | Add Sólides Vagas as a source, via its own undocumented public API                  | Accepted   | 2026-08-17 |
| [032](adr/032-catho-collector-headless-browser.md)                            | Add Catho as a source, via a real headless browser                                  | Parked     | 2026-08-17 |
| [033](adr/033-catho-checkpoint-state-machine.md)                              | A durable, five-state checkpoint for the Catho collector                            | Accepted   | 2026-08-17 |
| [034](adr/034-posting-events-append-only-log.md)                              | One append-only `posting_events` table for prefilter, score and delivery            | Accepted   | 2026-08-17 |
| [035](adr/035-llm-retry-taxonomy-backoff-and-circuit-breaker.md)              | Separate transport retry from output repair, add backoff and a circuit breaker      | Accepted   | 2026-08-17 |
| [036](adr/036-bound-and-sanitize-llm-inputs-and-outputs.md)                   | Bound and sanitize what reaches the model, and what the model's output reaches next | Accepted   | 2026-08-17 |
| [037](adr/037-unify-evidence-catalog-and-delimit-untrusted-prompt-content.md) | Unify the evidence catalog, and delimit untrusted content in both prompts           | Accepted   | 2026-08-17 |
| [038](adr/038-recoverable-scoring-failures-bounded-retry.md)                  | A scoring failure is reported, not notified, and retries up to a bounded ceiling    | Accepted   | 2026-08-17 |
| [039](adr/039-batch-fatal-permanent-errors-and-breaker-scope.md)              | Stop the batch on a permanent transport failure, narrow the circuit breaker's scope | Accepted   | 2026-08-17 |
| [040](adr/040-persisted-claim-as-scoring-admission-barrier.md)                | A persisted, atomic claim as the scoring admission barrier                          | Accepted   | 2026-08-17 |
| [041](adr/041-per-source-recovery-recency.md)                                 | Recovery recency is tracked per source, not per collect cycle                       | Accepted   | 2026-08-17 |
| [042](adr/042-composite-cache-identity-and-domain-validated-rows.md)          | Composite cache identity and domain-validated cache rows                            | Accepted   | 2026-08-17 |
| [043](adr/043-nullable-reconciliation-counts.md)                              | `receivedCount`/`schemaRejectedCount` are nullable, not default-zero                | Accepted   | 2026-08-17 |
| [044](adr/044-catho-exact-origin-allowlist-and-redirect-interception.md)      | Exact-origin allowlist and redirect interception for the Catho collector            | Accepted   | 2026-08-17 |
| [045](adr/045-catho-checkpoint-durability-and-quarantine-replay.md)           | Bounded incremental checkpoints, a state-file lock, and quarantine replay           | Accepted   | 2026-08-17 |
| [046](adr/046-rate-limit-the-shared-api-key.md)                               | Rate-limit the shared API key, enforced once regardless of protocol                 | Superseded | 2026-08-17 |
| [047](adr/047-scope-api-credentials-by-caller-capability.md)                  | Scope API credentials by caller and capability                                      | Accepted   | 2026-08-17 |
| [048](adr/048-checkpoint-telegram-delivery-with-manual-reconciliation.md)     | Checkpoint Telegram delivery with manual reconciliation                             | Accepted   | 2026-08-17 |
| [049](adr/049-bound-trace-and-resume-model-work.md)                           | Bound, trace, and resume model work                                                 | Accepted   | 2026-08-17 |
| [050](adr/050-bound-hot-path-work-and-batch-persistence.md)                   | Bound hot-path work and batch persistence                                           | Accepted   | 2026-08-17 |
| [051](adr/051-reject-unknown-track-postings-pre-llm.md)                       | Reject unknown-track postings before the LLM, behind a flag                         | Accepted   | 2026-08-17 |
| [053](adr/053-populate-period-blocked-digest-section.md)                      | Populate the period-blocked digest section                                          | Accepted   | 2026-08-19 |
| [054](adr/054-cooperative-run-cancellation.md)                                | Cooperative cancellation for `scoreAndDeliver`                                      | Accepted   | 2026-08-22 |
| [055](adr/055-stage-a-v5-track-conditional-requirements.md)                   | Stage A v5: merge track-conditional requirement branches                            | Accepted   | 2026-08-22 |
| [056](adr/056-exclude-broken-openrouter-providers.md)                         | Exclude measured-broken OpenRouter providers by name                                | Accepted   | 2026-08-22 |
| [057](adr/057-generic-skill-category-evidence.md)                             | Admit evidence when a requirement names a skill category                            | Accepted   | 2026-08-22 |
| [058](adr/058-work-availability-evidence-vocabulary.md)                       | Give `Work availability` evidence its own requirement vocabulary                    | Accepted   | 2026-08-22 |
| [059](adr/059-score-track-from-extracted-requirements.md)                     | Derive the score's track from extracted requirements                                | Accepted   | 2026-08-22 |
| [060](adr/060-indeed-multi-term-search.md)                                    | Multiple search terms per Indeed collection run                                     | Accepted   | 2026-08-23 |
| [061](adr/061-data-track.md)                                                  | A `data` track, weighted below `dev`/`security`                                     | Accepted   | 2026-08-23 |
| [062](adr/062-gupy-vacancy-type-filter.md)                                    | Filter Gupy queries by `vacancy_type_internship`                                    | Accepted   | 2026-08-23 |
| [063](adr/063-infojobs-collector.md)                                          | Add InfoJobs as a source, via listing scrape + detail JSON-LD                       | Accepted   | 2026-08-23 |
| [064](adr/064-diagnose-link-shape-and-retire-the-linkedin-freshness-alert.md) | Record a rejected link's shape; retire the LinkedIn freshness alert                 | Accepted   | 2026-08-26 |
| [065](adr/065-retry-telegram-sends-that-provably-never-left.md)               | Retry a Telegram send that provably never left                                      | Accepted   | 2026-08-26 |
| [066](adr/066-still-listed-outranks-the-age-rules.md)                         | "Still listed by the source" outranks the age rules                                 | Accepted   | 2026-08-26 |
| [067](adr/067-say-what-failed-and-queue-undeliverable-alerts.md)              | Say what failed, and hold an alert the channel could not carry                      | Accepted   | 2026-08-26 |
| [068](adr/068-national-postings-uncapped-international-budgeted.md)           | National postings uncapped, international ones budgeted                             | Accepted   | 2026-08-26 |
| [069](adr/069-probe-any-registered-source.md)                                 | Probe any registered source, and report region and origin                           | Accepted   | 2026-08-26 |
| [070](adr/070-indeed-remote-pass.md)                                          | An opt-in remote pass for Indeed, after measured dead ends                          | Accepted   | 2026-08-26 |
| [071](adr/071-nerdin-collector.md)                                            | Add NerdIn as a source; reject RemotIn and Programathor                             | Accepted   | 2026-08-27 |
| [072](adr/072-manual-applied-tracking.md)                                     | A manual, reversible "applied" bookmark, not the Phase 2 feedback loop              | Accepted   | 2026-08-28 |

## When an ADR is required

Write one when a decision is **non-obvious and costly to reverse**. In practice:

- Choosing between viable alternatives, where the loser had real merit
- Anything that constrains later work — a module system, a schema, a boundary
- Deviating from a convention this project or `atlas-manager` already follows
- Accepting a known trade-off, so the cost is recorded rather than rediscovered
- Rejecting something that looks like an obvious improvement, so it does not get
  re-proposed every few months

Do **not** write one for a decision with no real alternative, a choice that is
free to reverse, or a preference. A repository of ADRs recording that Prettier
uses two spaces is a repository where nobody reads the ADRs.

## Rules

**An ADR ships in the same commit as the code that implements it.** A decision
record written afterward is a summary; written alongside, it is the reasoning.

This is why the first five ADRs cover only the repository itself — framework,
module system, language, privacy boundary, and the scoring architecture that
shapes everything after it.

**The exception: a decision that constrains a milestone must be made before that
milestone starts.** ADR-006 and ADR-007 were written ahead of their code, on
purpose. ADR-006 changes the `ScorerPort` signature that M1 defines, and ADR-007
is a constraint on the schema M4 designs rather than a feature built on top of
one. Discovering either during implementation means rewriting what was already
built.

The test is whether the decision is _about_ the code or _upstream of_ it. If
implementation would settle the question, wait and write the ADR alongside. If
implementation would be shaped by the answer, decide first.

Deduplication's algorithm and similarity threshold, the pre-filter's rule set,
scorer adapter selection and the Hermes API boundary are all reasoned through in
`02-architecture.md` and `04-scoring-model.md` but remain the first kind — they
become ADRs in M4, M5, M7 and M9, next to the code.

**ADRs are immutable once accepted.** A decision that changes gets a new ADR that
supersedes the old one, and the old one is marked `Superseded by ADR-NNN` and
kept. The history of what was believed and when is the point; editing it away
leaves a document that is merely correct.

The exception is **amendment**, when new evidence refines a decision without
reversing it. The amendment is appended, the original text is left untouched, and
the `Status` line points at it. ADR-002 carries a worked example: it was accepted
with `moduleResolution: node16` and later amended to `nodenext` after measuring
that Node supports `require(esm)` unflagged from 22.12.0. The core decision —
CommonJS with a strict configuration — never changed, so it was an amendment
rather than a supersession.

The test for which one applies: if the _Decision_ section would now be wrong,
write a new ADR. If it would only be incomplete, amend.

**Numbering is sequential and never reused**, including for superseded records.

## Format

Copy `adr/000-template.md`. Sections: Status, Date, Context, Considered options,
Decision, Consequences.

Two sections carry most of the value and are the ones usually written badly:

**Considered options** must include the alternatives that were genuinely
plausible, with the reason each was rejected or deferred. An ADR listing one
option and choosing it documents nothing.

**Consequences** must include what the decision makes _harder_, and the cost of
reversing it. A consequences section containing only benefits means the analysis
is not finished.

## Decisions already made, recorded elsewhere

Some constraints are not ADRs because they were never open questions — they are
requirements. They live in `CLAUDE.md` and are listed here so nobody goes looking
for an ADR that does not exist:

- **No collector is ever authenticated with a personal LinkedIn session or
  cookies.** Not a trade-off; a rule.
- **No automatic job application.** A non-goal, with the reasoning in
  `01-vision-and-scope.md`.
- **The pipeline is not implemented as a Hermes skill.** Reasoned in
  `02-architecture.md`; becomes an ADR in M9 when the API boundary is built.
- **Polite collector behavior** — `robots.txt`, request interval, honest
  `User-Agent`, backoff, timeouts. A requirement on every adapter.

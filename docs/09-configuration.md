# 09 — Configuration

Principle 3 says profile and criteria are **data, not code**: changing search
strategy must not require changing the application. That principle only holds if
the configuration surface is defined, so this page defines it.

## The three kinds, and why they are separate

| Kind         | Lives in               | Committed                      | Changes                          |
| ------------ | ---------------------- | ------------------------------ | -------------------------------- |
| **Secrets**  | `.env`                 | No (`.env.example` is)         | Rarely                           |
| **Profile**  | `config/profile.yaml`  | No (`profile.example.yaml` is) | When the resume changes          |
| **Criteria** | `config/criteria.yaml` | **Yes**                        | Whenever search strategy changes |

The split is not arbitrary. Secrets must never be committed. The profile is
personal data (ADR-004). **Criteria are neither**, and committing them is what
makes the search strategy reviewable in git history — "why did I stop seeing
infra postings?" should be answerable with `git log`.

## Secrets — `.env`

Only credentials and endpoints belong here. Anything that is a _decision_ belongs
in `criteria.yaml`, where it can be diffed.

```
TELEGRAM_BOT_TOKEN=       # required
TELEGRAM_CHAT_ID=         # required
SCORER_ADAPTER=           # stub | api
LLM_API_KEY=              # required when SCORER_ADAPTER=api (OpenRouter, ADR-012)
LLM_BASE_URL=             # default https://openrouter.ai/api/v1
LLM_MODEL=                # OpenRouter model slug, e.g. deepseek/deepseek-v4-flash-0731
JOOBLE_API_KEY=           # parked/inert — no production collector reads it
N8N_WEBHOOK_URL=          # parked/inert — no production adapter reads it
N8N_WEBHOOK_TOKEN=        # parked/inert — no production adapter reads it
DATABASE_PATH=            # default ./data/argos.db
API_ADMIN_KEY=            # required — full-access Bearer credential (ADR-047)
API_KEY=                  # deprecated fallback for API_ADMIN_KEY during migration only
API_AUTOMATION_KEY=       # optional — operational REST/MCP caller, no ingest/discard
API_FEEDBACK_KEY=         # optional — Hermes reporting application feedback (ADR-075), MCP-only
INGEST_CATHO_API_KEY=     # optional — external ingest for source=catho only
INGEST_INDEED_API_KEY=    # optional — external ingest for source=indeed only
INGEST_LINKEDIN_API_KEY=  # optional — external ingest for source=linkedin only
API_PORT=                 # default 3000 — Tailscale-bound at the compose level
ATLAS_TAILSCALE_IP=       # compose-only (M9) — Atlas's `tailscale ip -4`, never read by the app
CRITERIA_PATH=            # default ./config/criteria.yaml
PROFILE_PATH=             # default ./config/profile.yaml
TAXONOMY_PATH=            # default ./config/taxonomy.yaml
BACKUPS_DIR=              # default ./backups
```

`.env.example` carries every key with a fictional or empty value and a comment.
It is the setup documentation, and it is committed.

### API credential capabilities and rotation

Every configured value must be unique. `ApiKeyGuard` refuses to start when two
principals share a credential, preventing an apparently source-scoped key from
silently inheriting a broader role.

| Credential                | Allowed capabilities                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_ADMIN_KEY`           | Every REST route and MCP tool, including permanent discard                                                                                                                                        |
| `API_AUTOMATION_KEY`      | Reads, collect, dedup, deliver and study plan; no external ingest or discard                                                                                                                      |
| `API_FEEDBACK_KEY`        | `POST /mcp` only — `list_postings`, `mark_applied`/`unmark_applied`, `record_application_event`/`list_application_events` (ADR-075); never `discard_posting` or any `run_*`/`get_study_plan` tool |
| `INGEST_CATHO_API_KEY`    | Only `POST /runs/collect/external` with `source: "catho"`                                                                                                                                         |
| `INGEST_INDEED_API_KEY`   | Only `POST /runs/collect/external` with `source: "indeed"`                                                                                                                                        |
| `INGEST_LINKEDIN_API_KEY` | Only `POST /runs/collect/external` with `source: "linkedin"`                                                                                                                                      |

Rotation is coordinated because the process accepts one current value per
principal: pause that caller's timer/workflow, generate a new value, update the
application and caller secret stores, restart the application, verify one
allowed request and one expected `403`, then resume the caller. A rotation
changes the short digest in `runs.triggeredBy`; that is expected and does not
expose either credential. Remove legacy `API_KEY` after all administrative
callers have moved to `API_ADMIN_KEY`.

## Profile — `config/profile.yaml`

The source of truth; the resume PDFs are projections of it. Gitignored.
Structure, Zod schema and `profile.example.yaml` land in M2.

Two rules from `CLAUDE.md` §9 that the schema enforces rather than documents:

- **Every competency carries at least one `evidence` entry.** Enforced in the
  schema, because a competency with no evidence produces `not_met` in stage B
  anyway — better to fail at load time than to silently deflate every score.
- **The academic period is derived, never stored.** The file holds
  `courseStart` and `courseEnd`; the period is computed at runtime
  (`02-architecture.md`). A stored period is correct for at most six months.

## Criteria — `config/criteria.yaml`

Everything that decides _what to look for_ and _how to weigh it_. Committed,
diffable, and the file that principle 3 is really about.

```yaml
collection: # what the cycle asks the source for (ADR-018)
  queries: # jobName / city / isRemoteWork per query — narrow on purpose
  queryIntervalMs: # pause between queries; politeness spans them (CLAUDE.md §6)
tracks: # keyword classification per track
trackWeights: # dev 1.0, security 1.0, automation 0.7, unknown 0.4
prefilter:
  titleBlocklist: # sênior, pleno, especialista, coordenador, gerente…
  titleRequired: # estágio, estagiário, intern, trainee
  locations:
  blockedCompanies:
  minKeywordAdherence:
  rejectUnknownTrack: # reject pre-LLM when no track matches (ADR-051)
scoring:
  weights: # 35 / 20 / 45 (ADR-026; originally 65 / 20 / 15)
  thresholds: # apply 70, review 45
  minExtractedRequirements: # lowConfidence trigger
  maxScoreRetries: # ADR-006
schedule: # two independent crons, ADR-009
  collection: # interval, default every 4h — no LLM
  scoreAndDeliver: # daily time + timezone, default 03:00 America/Sao_Paulo
alerts:
  consecutiveEmptyCollectionRuns: # tolerant — collection is frequent
  missedScoreAndDeliverRun: # not tolerant — this is the digest
  scoreFailureRateThreshold: # legacy name; LLM-operation health threshold (ADR-052); any missing score alerts independently
```

The Portuguese strings in `titleBlocklist` and `titleRequired` are **data being
matched against Portuguese posting text**, not a language inconsistency. See
`06-glossary.md`.

## Loading rules

**Validate everything with Zod at startup, and fail loudly.**

This is the counterweight to principle 3. Moving decisions out of code means
losing the compiler as a safety net, so validation has to replace it. The failure
mode being prevented is specific and nasty: a malformed `prefilter` block
producing an _empty_ filter that silently passes every posting, sending 200
unfiltered postings to a 4B model.

Rules:

1. **Fail at startup, never lazily.** A configuration error must stop the process
   with a message naming the file and field — not surface three stages later as
   odd behavior.
2. **No silent defaults for decisions.** A missing `API_PORT` defaults to
   `3000`. A missing `trackWeights` is an error. Defaulting a decision hides the
   fact that nobody made it.
3. **Precedence: environment > file > built-in default.** One order, everywhere.
4. **Secrets are never logged**, including at `debug`, and never included in an
   error message about configuration.
5. **Config is read once at startup**, not per stage, so a mid-run edit cannot
   change behavior halfway through a batch.

## Setup

A fresh clone does not run — that is the intended consequence of ADR-004, not a
defect. Setup is:

```bash
cp .env.example .env                                # fill in secrets
cp config/profile.example.yaml config/profile.yaml  # fill in the profile (M2)
```

`config/criteria.yaml` is committed and works as-is.

## Changing configuration is a pull request

Criteria live in git, so a strategy change goes through the same flow as code: a
branch, a commit explaining **why**, and CI. This costs a minute and buys the
ability to answer "what changed before the digest got worse?" — which is the
question that matters after a calibration run moves a weight.

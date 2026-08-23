# ADR-056 — Exclude measured-broken OpenRouter providers by name

## Status

Accepted

## Date

2026-08-22

## Context

ADR-013 pinned the **model** (`deepseek/deepseek-v4-flash-0731`) so scoring
results stay comparable across runs — the whole premise of M7's "change one
variable at a time" protocol (`docs/04-scoring-model.md`).

It did not pin what sits underneath. OpenRouter serves that model from **30
different provider endpoints** (measured against its own
`/models/{id}/endpoints` API) and picks one per request. "Same model, same
prompt" can therefore still mean two materially different systems from one
run to the next, and nothing in this project could see that happening.

This stopped being theoretical while investigating
`docs/11-known-issues.md` B9. A Stage B prompt change (`b-v5`) appeared to
regress calibration from 0% to 72% parse failure. Isolated single calls
found the prompt was innocent: **production's own `b-v4` prompt failed
identically** once routing landed on `Sail Research` — 0 of 8 usable
responses, returning `finish_reason: "stop"` with completely empty content,
or blowing the 768-token completion budget with 2,400–3,700 characters of
chain-of-thought against an explicit `reasoning.max_tokens: 300`.

The two calibration runs that produced the apparent regression had in fact
routed to different providers (`Relace` vs `Sail Research`); the prompt was
never the variable that changed. An uncontrolled provider silently
invalidated a comparison the M7 protocol treats as controlled.

## Considered options

### `provider.require_parameters: true`

OpenRouter's documented control for "only use providers that support all
parameters in your request" — the obvious fit, since the observed symptom
was a provider ignoring `reasoning.max_tokens`. **Measured and rejected: it
does not work here.** `Sail Research` advertises both `max_tokens` and
`reasoning` in OpenRouter's endpoints API, so it passes the filter and is
still selected; it simply does not honour what it advertises. Probed
directly: 0/8 usable with the flag set, identical to without it.

### Pin one provider (`provider.order` + `allow_fallbacks: false`)

Maximum reproducibility, and genuinely tempting for calibration. Rejected as
the default: it converts any single provider's outage into a total scoring
outage, discarding the resilience that made 30 endpoints an asset. Probing
`order: ["deepseek"]` also returned "No endpoints found", so the
first-party provider is not even reliably addressable this way.

### An allowlist of known-good providers

Rejected for the reason `docs/11` B8/B10 already established about fixed
keyword lists: an allowlist goes stale **silently and in the dangerous
direction** — a new provider is excluded until someone notices, and the
roster changes without notice. An exclusion list fails safe: an unknown new
provider is tried, and only excluded once actually observed failing.

### An exclusion list, as configuration (chosen)

Same shape as `blockedCompanies` and `trackExclusions`: entries are added
when a provider is _observed_ failing against this project's own corpus,
and adding the next one is a config edit, not a deploy (principle 3).

## Decision

`criteria.scoring.ignoredProviders` (defaulted to `[]`, so a criteria file
predating it stays valid) is threaded through `buildScorer` into
`OpenRouterClient`, which sends it as `provider.ignore` on every request.
When the list is empty the field is omitted entirely, so the default request
body is byte-identical to what it was before this existed.

`config/criteria.yaml` ships one entry, `sail-research`, with the
measurement that justifies it recorded inline — 0/8 usable, and the
`require_parameters` result that rules out the tidier fix. Providers
measured good on the same probe (Baidu, OpenInference, Relace) are recorded
in the same comment so a future session does not re-test them blind.

Verified after the change: 4/4 usable immediately, and subsequent probes
consistently land on Baidu with valid JSON.

## Consequences

**What this makes easy:** a provider that starts returning garbage can be
taken out of rotation with a config edit and a container restart, instead of
poisoning every run until someone re-derives the cause from scratch. The
`llm_provider_counts` column ADR-052 already persists per run is what makes
the _next_ bad provider visible — that observability existed and was never
being read.

**What this does not solve:** nothing here detects a bad provider
automatically. The exclusion is reactive by construction, and the detection
path is still a human noticing a bad digest and investigating. An automated
per-provider quality signal would be the real fix and is not attempted here.

**A limitation worth stating plainly:** this constrains routing, it does not
make a run reproducible. Two runs can still use two different (good)
providers, so calibration comparisons remain noisier than the M7 protocol
implies. Pinning for calibration specifically — a `--provider` flag on
`run-calibration.ts` — is the honest follow-up and is deliberately not
bundled here.

**Reversal cost:** low. Empty the list in `criteria.yaml` and routing
returns to OpenRouter's default; the plumbing stays and is inert.

# ADR-068 — National postings uncapped, international ones budgeted

## Status

Accepted

## Date

2026-08-26

## Context

The digest is thin because **supply is thin**, not because the filter is
wrong: of 3,676 active postings, only **51** are on-track and in-region even
ignoring age entirely (ADR-066). Remote work is the obvious way to grow that
number, and it is almost unexplored — **61 remote postings in the whole
corpus (1.6%)**, of which 16 are on-track.

Measured on the real corpus, 2026-08-26, by delivery rate:

| Work mode  | Collected (gupy) | Delivered | Rate      |
| ---------- | ---------------- | --------- | --------- |
| **remote** | 42               | 9         | **21.4%** |
| hybrid     | 51               | 5         | 9.8%      |
| onsite     | 222              | 3         | 1.4%      |

A remote posting is worth roughly **15× an onsite one**. So the pipeline
should want more of them.

The complication is cost, and it has a precise shape. `isLocationAllowed`
short-circuits on remote (`pre-filter.ts:194`):

```ts
if (posting.workMode === "remote") return criteria.location.allowRemote;
```

Remote postings **bypass the geography gate entirely** — the filter that does
the heaviest lifting on everything else. And there is no backstop behind it:
`claimForScoring` has no `LIMIT` and no `ORDER BY`, and the scoring loop in
`executeDeliver` scores everything that passes. There is no per-run cap, no
budget guard, no spend ceiling anywhere in the codebase.

**But not all remote postings are the same kind of bet**, and that is what
this ADR turns on.

- A **national** posting is eligible by construction. The only question is
  how well it matches, which is what scoring is for.
- An **international** posting carries a prior question — can this be taken
  from Brazil at all? — and answering it **costs a model call**. A residency
  or visa requirement surfaces as a `blocking` requirement in Stage A, caps
  the score at `blockingCapScore: 35`, and lands in `discard`. That mechanism
  already exists (`docs/04`, ADR-015) and needs no new rule. What it does not
  do is come for free: the call is spent whether the answer is yes or no.

The operator's decision, given that: **do not cap national postings at all —
that cost is accepted — and cap only the international ones.**

There was one obstacle: **the system had no concept of country.** `Posting`
had no such field, no normalizer captured one, and every source wired up is a
Brazilian platform (Gupy, CIEE, InfoJobs, Sólides are BR; `collect.py` pins
`country_indeed="Brazil"`). So "international" could not even be expressed.

## Considered options

### A global cap on postings scored per run

Rejected by the operator, and the reasoning holds: a global cap bounds
national postings too, which are exactly the ones worth having without limit.
It would trade away the certainty to bound the guess.

### Infer nationality from the source alone

Rejected as the _primary_ mechanism, kept as the fallback. Source is a good
prior — every source today is Brazilian — but it cannot express a source that
carries both, which is precisely what an international source would be. A
fact stated by the posting must be able to outrank an assumption about its
source.

### Infer nationality from currency or language

Rejected. This is text-mining prose for a structural fact, which CLAUDE.md
§15 forbids and which ADR-063 already rejected for `workMode`. Brazilian
companies routinely post in English — `IT Support Intern` is in the corpus
today — so the signal is wrong in the common case, not merely imprecise.

### A `country` field, with a per-source default (chosen)

## Decision

**`Posting.country`**, ISO 3166-1 alpha-2 uppercase or null, persisted as a
nullable `postings.country` column. `normalizeCountry` accepts only a
two-letter code; anything else — a full country name, a three-letter code —
becomes **null rather than a translation**. Rejecting is deliberate: a
name-to-code table would need to handle `"Brazil"`, `"Brasil"`, `"Brésil"`
and every misspelling, and would eventually guess.

Captured where a source states it: Indeed's `location` carries the country as
its last comma-separated segment (`"Rio de Janeiro, RJ, BR"`), and InfoJobs's
JSON-LD may carry `addressCountry`. Gupy, CIEE and Sólides state none.

**`country` is not part of the fingerprint.** Identity stays
`sha256(company + title + city)` (ADR-007); adding a field would re-collect
the entire corpus as new.

**`criteria.sourceDefaultCountry`** maps a source to the country its postings
belong to when the posting states none. This is a property of the _source_,
the same standing `location.nationwideSources` already has — not a guess
about the posting. Without it the entire existing corpus would read as
unplaceable and fall into the capped bucket, inverting the priority this ADR
exists to express.

**Resolution order** (`isNationalPosting`): the posting's own country, then
the source default, then **unknown → international**. That last step is the
conservative direction: misfiling a national posting as international costs
it one night's wait, while the reverse would let an unbounded stream of
unplaceable postings spend model calls without limit.

**`maxInternationalPerRun`** bounds how many international postings one run
pays to evaluate. National postings are never counted against it. `null`
disables it, and **null is what production ships with today** — no
international source exists yet, so any number here would be untested config
posing as a measurement. It gets a real value in the same PR that adds the
first international source.

**`rankForScoring`** orders both buckets by recency (`publishedAt ??
firstSeenAt`, the same fallback `isTooOld` uses), then by track weight
(dev/security 1.0 before automation/data 0.7). Recency leads because an old
posting scored perfectly is still a closed one; track weight breaks ties
because a same-day `automation` posting beats a two-week-old `dev` one.

Ordering matters **even where nothing is capped**. `claimForScoring` returns
rows in whatever order SQLite produces, which was harmless while everything
got scored — and stops being harmless the moment a run can end early (a
provider outage, a cancel, the cap). Then _which_ postings got the budget
becomes arbitrary. Now the money is spent freshest-and-best-matched first.

A deferred posting is recorded as a `posting_events` row with
`outcome: "deferred"`, `reason: "international_budget_exhausted"`. It keeps
`notifiedAt` null and its claim is released, so the next run reconsiders it in
full. Without the event, "why did this never reach me" would be unanswerable
from the database — the exact gap B20 cost a day of investigation.

## Consequences

Remote national postings can now grow without bound, which is the point and
also the accepted risk: **there is still no ceiling on national scoring cost,
and remote does not pass through the geography filter.** What remains holding
the line is `rejectUnknownTrack`, measured at 92% of all rejections. The
operator accepted this explicitly. It is monitored — `scored_count`,
`llm_attempts` and `llm_cost_usd` against the 10.2 / 30.2 / US$0.00515
baseline — not contained. A rise is _expected_; what would be a symptom is a
rise disproportionate to real supply.

`country` is null for essentially the whole corpus today and will stay that
way for Gupy, CIEE and Sólides, which state no country. The system therefore
leans on `sourceDefaultCountry` in production, which means **a source added
without an entry there is silently treated as international.** That is the
safe direction, but it is a real trap for whoever adds the next source: the
symptom would be a new source's postings quietly competing for a capped
budget instead of flowing freely.

The international path is, as of this ADR, **entirely untested against real
data** — no international source exists, so `maxInternationalPerRun` has never
bounded anything outside a unit test. Three of the new tests were verified to
fail against the previous implementation, so they test the mechanism rather
than restate it, but the mechanism has not yet met a real foreign posting.

Reversal is cheap: `maxInternationalPerRun: null` restores previous scoring
behaviour exactly, and the column is additive. What is _not_ cheap to reverse
is `country` itself, once normalizers populate it and rules read it — which
is why it is deliberately absent from the fingerprint.

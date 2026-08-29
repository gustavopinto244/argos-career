# ADR-066 — "Still listed by the source" outranks the age rules

## Status

Accepted

## Date

2026-08-26

## Context

The operator's digest had been arriving nearly empty, and the pre-filter was
the suspect: `track_unknown` rejects roughly 29,000 posting-events a week,
92% of everything the filter sees. The obvious move was to loosen it.

**Measured first, and the obvious move was wrong.** Running the real
`applyPreFilter` over the real 3,676-posting active corpus with
`rejectUnknownTrack` flipped off: **198 postings would be admitted, and not
one is on-track.** They are `Estágio em Administrativa` (34),
`Estágio em Educação` (13), `Campo do Direito` (9), Comunicação (8),
Contabilidade (6), Construção Civil, Veterinária, Gastronomia. The track gate
is doing exactly what ADR-051 built it to do, and ADR-059 had already
measured and rejected the neighbouring idea of classifying on the raw
description (438 newly-classified postings, almost all off-track).

So the same measurement was pointed at every other rejection reason, asking
which ones discard postings that are genuinely on-track and in the Rio metro.
The answer was `too_old`: **117 on-track postings**, including
`Pessoa Estagiária em Desenvolvimento Backend` (remote),
`Estágio de Desenvolvimento | C# ou Go (Golang)` (remote),
`Estagiário DevOps` (Rio) and `Estagiário de Middleware | Infraestrutura`
(Rio).

`maxAgeDays: 7` is a considered rule with a stated rationale — an old posting
is likely filled or closed, and scoring it spends real LLM budget. That
rationale is sound. But it asks a **proxy** question ("how long ago was this
published") when the system already holds the answer to the real one.

`lastSeenAt` moves on every sighting, and has since ADR-007's upsert. A
posting the source returned an hour ago is being advertised **right now**,
whatever date it carries. The pre-filter simply never read that column.

Narrowing to postings that are on-track, in-region, and never notified —
the ones whose loss actually costs something — 26 were rejected by the age
rules. **8 of them were still being listed by their source on its most recent
sweep.** The other 18 had genuinely vanished, which is precisely what the age
rule should catch. Among the 8:

| Posting                                           | Published | Last seen  |
| ------------------------------------------------- | --------- | ---------- |
| `Estágio em TI` — BHG, Rio                        | 21 d ago  | 7 h ago    |
| `Estagiário de Tecnologia da Informação` — Rio    | 15 d ago  | 7 h ago    |
| `Estágio Short Job \| Automation` — Magnetis, Rio | 23 d ago  | 7 h ago    |
| `Estágio em Informática` ×2 — CIEE, Rio           | undated   | 54 min ago |

The two CIEE rows are the sharpest case, and they are not blocked by
`maxAgeDays` at all: they are undated, first seen **eight hours before**
`undatedBacklogCutoverAt`, and therefore presumed dead backlog — while CIEE
was still serving them up ten days later.

## Considered options

### Raise `maxAgeDays` from 7 to 14

Rejected. Measured: +13 admitted, but 8 of those had already been notified
when they were fresh, so the real gain is ~5. It also admits postings purely
for being recent enough, including ones that have already vanished from their
source — loosening the rule without improving the signal. And 66% of what
`too_old` currently rejects was first seen on 2026-08-15/16, the initial
backlog, so tuning the threshold against today's corpus is tuning against a
transient.

### Loosen `rejectUnknownTrack`

Rejected on measurement, above: 198 admitted, zero on-track.

### Read `lastSeenAt` as direct evidence the posting is open (chosen)

Uses a signal the system already records, answers the question the age rule
is proxying for, and — measured — admits only on-track postings.

## Decision

A posting whose `lastSeenAt` falls within `stillListedWithinHours` is not
`too_old`, regardless of `publishedAt`, `firstSeenAt`, or
`undatedBacklogCutoverAt`. Set to **30 hours**; `null` disables it and
restores the previous behaviour exactly.

30 hours is chosen against the real collection cadence, not a round number:
gupy/ciee/infojobs are swept every 4 h, but Indeed runs on its own systemd
timer twice a day, so a still-listed Indeed posting legitimately shows a
12-hour-old `lastSeenAt`. 30 h clears one full Indeed cycle plus a missed one.

**The signal is used in one direction only.** "Still listed" rescues a
posting from the age rule; "not seen recently" never rejects one. The
asymmetry is not stylistic — a paginating source drops still-open postings
out of the collected window, and `truncatedSources: ["gupy"]` appears on most
real runs. Absence of a sighting is therefore not evidence of closure, while
presence of one **is** evidence of listing.

It is also scoped to `too_old` alone. A still-listed posting in Fortaleza is
still rejected for location; this evidence speaks to whether a posting is
open and to nothing else.

Checked before `undatedBacklogCutoverAt` deliberately. The cutover retires an
undated backlog nobody can date; a posting the source served up today is not
backlog, whatever its `firstSeenAt` says.

## Consequences

Verified against the real corpus with the real pre-filter before merging:
with the rule at `null`, the new build is **identical to production across
all 3,676 postings** — zero divergences. With it at 30 h: **17 → 30 passing,
13 gained, 0 lost, 0 off-track, 10 never previously notified.** That last
number is the one that matters: it roughly triples what a nightly digest has
to work with, from 4 to 14.

The cost is a real one and it has a face. `Estagiário(a) de Tecnologia da
Informação` (SISTEMA DE ENSINO YOUR, Rio) was published **67 days ago** and
is still listed — this rule admits it. That is either a genuinely long-open
posting or one nobody bothered to close, and this rule cannot tell the
difference. There is no absolute age ceiling on the rescue, deliberately: the
cost of a zombie is one Stage A/B pair, once, after which the cache and
`notified_at` make it free, and the operator sees it in the digest and
decides. A ceiling can be added if zombies turn out to be common, which is a
measurement nobody has yet.

It also makes the pre-filter's behaviour depend on collection health in a new
way: if a source stops being swept, its postings stop being rescued and age
out again. That failure mode is the old behaviour, not a leak, and
`sourceFreshnessHours` already alerts on a source going quiet.

**What this does not fix, and is worth stating plainly.** The digest was not
mainly empty because of the filter. Of 3,676 active postings, only **51 are
on-track and in-region even ignoring age entirely**, and 21 of those had
already been notified. The binding constraint is supply — back-end and
security internships in the Rio metro, for someone in their 2nd academic
period — not filtering. This ADR recovers real postings that were being
thrown away; it does not manufacture a market.

## Amendment 1 — an absolute ceiling on the rescue (2026-08-29)

The Consequences section above left one question open: "a ceiling can be
added if zombies turn out to be common, which is a measurement nobody has
yet." Three nights of production data after ADR-070 Amendment 3
(2026-08-27/28/29) supplied it: every single `scoreAndDeliver` run in that
window admitted 2-3 postings past `maxAgeDays: 7` purely on the still-listed
rescue, the oldest reaching 314 hours (~13 days) since `firstSeenAt`. Common,
not hypothetical.

Zooming out from those three runs to the full still-listed corpus (2,584
postings with `lastSeenAt` inside the 30h window) sharpened the picture. The
bulk cluster tight around a 12-13 day median — CIEE's undated backlog moving
together — but there is a real tail past it: 29 postings over 30 days old,
18 over 45, 11 over 60, 7 over 90, one **424 days old** (`Full Stack
Developer`, Indeed — not even an internship title, so `title_missing_required_term`
would already reject it regardless). The oldest confirmed **on-track** case
in that tail was `Estagiário(a) de Tecnologia da Informação – TI` (Indeed,
Méier-RJ) at 71 days.

### Considered options

**Cap `stillListedWithinHours` itself lower** — rejected. That field measures
freshness of the _signal_ (how recently the source confirmed the posting is
open), which is a property of collection cadence, not of the posting's age. It
was already tuned to the slowest source's cycle (ADR-066 body, Indeed's 12h
twice-daily sweep); shrinking it to fight zombies would make it start missing
real still-open postings again, solving the wrong variable.

**No ceiling, since the original ADR already accepted a 67-day case** —
rejected. That acceptance was for one measured example, not a blank check;
the corpus now shows the same mechanism reaching over a year, and nothing
about the rescue's logic distinguishes 67 days from 424.

**A separate absolute ceiling on age itself (chosen)** — orthogonal to the
freshness signal: `stillListedWithinHours` still asks "is the source
confirming this today", and the new `stillListedMaxAgeDays` asks "even so,
is it too old to be worth a model call at all." Measured against the real
tail above, 90 days keeps every on-track case seen so far (including the
71-day Méier posting, and the 67-day case that motivated the original
Consequences note) while cutting the part of the tail that is old enough to
be almost certainly closed or off-track already — none of the postings past
90 days in the measured tail were on-track internships.

### Decision

`stillListedMaxAgeDays: 90` (nullable, `null` disables it and restores the
original unbounded rescue). Applied inside `isTooOld`: a posting is only
rescued by `isStillListedBySource` when its age — measured the same way
`maxAgeDays` measures it, `publishedAt` falling back to `firstSeenAt` — is
also within this ceiling. Past it, the posting falls through to the normal
`too_old` evaluation, including `undatedBacklogCutoverAt`, exactly as if it
had never been rescued.

### Consequences

Same asymmetry as the parent decision, one level down: the ceiling only ever
_removes_ a rescue, never rejects a posting the original age rules would
have passed on their own. A source that stops being swept still ages its
postings out under `maxAgeDays` as before; this only changes what happens
once they are also older than 90 days regardless.

A separate finding from the same watch period — NerdIn's second consecutive
week at `onTrackInRegion: 0` (`docs/10-milestones.md`) — was deliberately
left as-is: the operator chose to keep the query running rather than park it
per the ADR-071 decision rule. That is a source-selection question,
unrelated to this ceiling.

# ADR-077 — A posting with no link gets its own digest section, not a dead end in the recommended one

## Status

Accepted

## Date

2026-08-30

## Context

The operator reported that CIEE postings in the digest are unusable — they
cannot reach the vacancy from what the digest gives them, only from CIEE's
own platform notifications. Measured against the production corpus on
2026-08-30, the report is exact and worse than "inconsistent":

|                                             |                                        |
| ------------------------------------------- | -------------------------------------- |
| CIEE postings with no `sourceUrl`           | **3.493 of 3.493 (100%)**              |
| CIEE postings already delivered in a digest | 12, all linkless                       |
| `apply` verdicts CIEE has produced          | **8 of the 13 that have ever existed** |

So the single largest producer of high-quality matches in the system is also
the one whose postings cannot be acted on. Every one of those 12 deliveries
printed the same line:

```
→ (link não informado pela fonte)
```

`render-digest.ts` already treats this as serious — its own comment says a
silently missing link "is the one thing that breaks the under-10-minutes
goal", which is why it prints the absence rather than omitting the line. But
printing the absence is not the same as handling it: the entry still sits in
`Recomendadas`, a section whose implicit promise is that the operator can go
and act on what is listed.

**This is not a normalization bug.** `ciee-normalizer.ts` sets
`sourceUrl: null` deliberately, with a comment saying no per-posting link is
published on that endpoint. Three candidate URL shapes were tested against a
real `codigoVaga` (with `portal.ciee.org.br/robots.txt` checked first — it is
empty, allowing everything):

| URL                                        | Response |
| ------------------------------------------ | -------- |
| `api.ciee.org.br/vagas/vitrine-vaga/<cod>` | 401      |
| `portal.ciee.org.br/vagas/<cod>`           | 404      |
| `portal.ciee.org.br/vaga/<cod>`            | 404      |

The per-vacancy API requires authentication; the public portal does not
address a vacancy by code. The source genuinely does not publish one, and
fabricating a URL would be inventing a fact — the failure CLAUDE.md §15
exists to prevent.

## Considered options

### Option A — Drop CIEE from the digest entirely

Rejected. CIEE produced 8 of 13 `apply` verdicts; removing it discards the
best matches the system finds. It is also valuable exactly where it already
is: ADR-021 has CIEE crawl nationwide with no city filter specifically to
give M10's market analysis a national picture. The collection is not the
problem.

### Option B — Leave it as is, since the digest already prints the absence

Rejected. Printing "(link não informado pela fonte)" tells the operator
something is missing but gives them nothing to do about it, and does so from
inside a section that implies actionability. Twelve deliveries went out this
way.

### Option C — A dedicated section, routed on the link (chosen)

A scored `apply`/`review` posting with no `sourceUrl` goes to
`Digest.unreachable` instead of `recommended`/`review`, rendered as its own
section that names the source's own identifier rather than repeating the
dead end.

## Decision

**Option C.**

`composeDigest` routes on `posting.sourceUrl`, **not on the source name**.
"There is no way to act on this" is a property of the entry; a second
linkless source later gets the same honest treatment with no new branch.

The section prints `Procure em <source> pelo código <sourceId>` in place of
the link line. For CIEE, `sourceId` _is_ `codigoVaga` — the one identifier
that makes the posting findable by hand on their portal — so the entry
becomes actionable, just not clickable.

`unreachable` entries **are** marked `notifiedAt`, unlike `periodBlocked`.
A period gate clears on a known date, which is why ADR-053 deliberately
leaves those unnotified so they resurface; a posting with no link will never
acquire one, so re-showing it every night would be pure noise.

A `discard` verdict is not routed anywhere — linkless or not, it was already
excluded from the digest.

## Consequences

**What this makes easy:** the operator can act on CIEE's matches for the
first time, by code, and the recommended section stops containing entries
that cannot be opened.

**What it does not fix:** the postings still are not clickable, because CIEE
does not publish a link. This decision makes the digest honest about that
and gives the operator the identifier; it cannot invent a URL that does not
exist.

**A fixture that was testing an impossible shape.** Six `executeDeliver`
tests failed on this change because `gupyPayload` never set `jobUrl`, so
every fixture posting was linkless — a shape production never produces
(measured: 18 of 18 delivered Gupy postings have a link). The fixture was
corrected rather than the routing loosened; the failure was the tests
noticing a real behaviour change, which is what they are for.

**Reversible.** Delete the `unreachable` field, its routing branch and its
renderer; nothing else reads it.

**Verified by reverting.** Removing the routing branch fails 3 digest tests;
removing the render call fails 2 render tests.

---

## Related: one track keyword, measured with the real classifier

Found in the same audit and shipped alongside, though independent of the
CIEE decision.

Auditing the 1.532 postings whose only-ever pre-filter rejection was
`track_unknown` (1.601 raw, of which 69 were later rescued by earlier
keyword calibrations) turned up a narrow blind spot: the track lists are
entirely Portuguese except for words that double as technology names, so an
English-titled developer role classifies `unknown`.

**A regex approximation suggested three additions. Running the real
`classifyTrack` against all 4.368 corpus titles cut that to one:**

| Candidate        | Postings moved from `unknown`                            | Verdict                                                                                           |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `developer`      | **2** (BairesDev — Java and Python trainee, both remote) | added to `dev`                                                                                    |
| `full stack`     | 0                                                        | not added — `full-stack` already matches once `keywordMatchesText` collapses the hyphen (PR #174) |
| `infraestrutura` | 0                                                        | not added — already listed under `security`                                                       |

The lesson is the one ADR-011's discipline already encodes and this audit
re-proved at 4× error: measure with the function that actually runs, not an
approximation of it.

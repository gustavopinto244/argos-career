# ADR-064 — Record a rejected link's shape, and retire the LinkedIn freshness alert

## Status

Accepted

## Date

2026-08-26

## Context

Two problems that look unrelated turn out to be one problem and its alarm.

**LinkedIn has never delivered a posting.** `docs/11-known-issues.md` B15
found this on 2026-08-23 and closed it on a hypothesis: the schema required
lowercase `title`/`company` keys while the real n8n payload sends Title Case,
so `lowercaseKeys` was added to `linkedin-alert-schema.ts`. That fix is
correct and it works. It also did not fix the problem. Three more real ingest
runs since — 2026-08-25 (1 item) and 2026-08-26 (3 items) — were discarded
exactly like the five before them. Across 2026-08-18 to 2026-08-26: **37
items received, 37 rejected, zero `source = 'linkedin'` rows in `postings`.**

B15 anticipated this. It wrote: "If it still fails, `payloadKeys` on the
[rejection event] ...". The `payloadKeys` it added is what settles the
question. Every rejected item since the diagnostic landed records:

```
{"hasSourceId":false,"envelopeShape":"flat","payloadType":"object",
 "payloadKeys":["Company","ExtractedAt","Link","Location","ReceivedAt","Subject","Title"]}
```

`Title` and `Company` are present, and `lowercaseKeys` accepts them — the
casing fix is doing its job, and the schema is no longer the rejection point.
The envelope is flat with no `sourceId`, which `payloadOf`'s fallback already
handles. That leaves exactly one place left to fail, and it is not a guess:
`normalizeLinkedinAlertJob`'s `if (!sourceId) return null`, reached whenever
`deriveSourceIdFromLink` finds no `/jobs/view/<digits>` inside `link`.
Verified against the current normalizer, replaying the exact recorded shape:

| `Link` value                                                | Result                            |
| ----------------------------------------------------------- | --------------------------------- |
| `https://www.linkedin.com/jobs/view/4451703964/`            | normalizes, `sourceId=4451703964` |
| `https://www.linkedin.com/comm/jobs/view/4451703964/?trk=…` | normalizes, same id               |
| `https://www.linkedin.com/e/v2?e=…` (email redirect)        | **rejected**                      |
| `""` / `null` / key absent                                  | **rejected**                      |

So the remaining unknown is narrow and precise: **what `Link` actually
contains.** Nothing stored can answer it, because the stored diagnostic
deliberately records field names and never values — and that boundary is not
negotiable here. A LinkedIn job-alert email's tracking URL carries query
parameters identifying the recipient's own account, which is exactly the
personal data `docs/08-observability.md` and ADR-004 forbid persisting.

**Meanwhile, the alarm for this became noise.** `sourceFreshnessHours`
(ADR-029 era, B13) listed `linkedin: 96`. Because `linkedin` has never
delivered, `evaluateSourceFreshness`'s "never delivered" branch matched on
_every_ collection run — every 4 hours, six times a day, restating a fact
that does not change between runs. The operator asked for it to stop, and is
right to: an alert that cannot be acted on and cannot stop firing trains its
reader to ignore the channel, which costs the outage alerts that channel
exists to catch.

The two are the same decision. Silencing the alert while the loss continues
would leave a source failing 100% with nothing watching — precisely the
regression B13 added freshness alerting to prevent.

## Considered options

### Log the rejected `link` value verbatim, once, to find the format

Rejected. It is the fastest answer and it is not available: the value is the
one field most likely to carry account-identifying tracking parameters, and
ADR-004's boundary applies to event metadata exactly as it applies to logs.
"Just this once, just to debug" is how that boundary erodes.

### Ask the operator to read the n8n workflow and report the link format

Rejected as the primary path, though it remains open and would be faster if
taken. The operator's decision is to leave n8n alone — it is delivering, and
that half genuinely works. More to the point, a system that can only be
debugged by a human reading someone else's infrastructure is the failure B15
already documented once; the second occurrence is the signal to fix the
instrument, not to ask again.

### Record a masked structural description of the link (chosen)

`host`, a `pathTemplate` with numeric segments reduced to `<digits>` and
anything not route-shaped to `<opaque>`, `hasQuery` as a boolean that never
reads the query, and `hasJobsViewPath` — the normalizer's own predicate,
evaluated and stored. This distinguishes `/jobs/view/<digits>` from `/e/v2`,
which is the only question the fix turns on, and carries no identity.

### Relax `deriveSourceIdFromLink` to accept any link, hashing it for an id

Rejected, for now. It would make LinkedIn ingest succeed immediately, and it
would do so by inventing a `sourceId` whose stability across alert emails is
unknown — a tracking URL may differ per send for the same posting, which
would defeat dedup (ADR-007) and re-notify the same job repeatedly. That
trade is only worth making once the shape is known. This ADR exists to learn
it first; CLAUDE.md §15 forbids guessing when the discovering instrument is
cheap to build.

## Decision

**Record `linkShape` on every `normalization_rejected` event**, derived by
`describeUrlShape` — masked structure only, never the value, never the query
string. It applies to any source's link-ish field (`link`, `url`, `joburl`,
`sourceurl`, `applyurl`), not to LinkedIn specifically.

**Remove `linkedin` from `sourceFreshnessHours`**, knowingly and
reversibly. B15 stays open in `docs/11-known-issues.md` until a
`source = 'linkedin'` row exists in `postings`; the window is restored the
day one does, because a source that has delivered once can go stale and the
alert becomes a real signal again.

**Also fixed here, same root cause:** `executeIngestExternal` never passed
`unnormalizableCount` to `runsRepo.finish`, so every LinkedIn run row read
`collected: N, normalized: 0, unnormalizable: 0` — arithmetically impossible,
and indistinguishable from "the source sent nothing." The number was computed
correctly and discarded, surviving only inside
`sourceQueryStats.normalizationRejected`. `executeCollect` has always passed
it. That misreported row is a large part of why this went eight days without
anyone seeing it as loss rather than silence.

## Consequences

The next real n8n delivery — whenever the operator's workflow next fires, on
its own schedule — records what `Link` actually holds, and the normalizer fix
follows from evidence rather than a third hypothesis. Until then LinkedIn
still contributes nothing, now without an alert saying so. **That is the real
cost of this ADR**, and it is only acceptable because B15 stays open and the
run rows now read honestly: an `unnormalizable_count` equal to
`collected_count` is visible loss, not silence.

`describeUrlShape` is deliberately conservative, and conservative means
lossy. A route segment longer than 20 characters, or one mixing case and
symbols, is reported as `<opaque>` — if a future source's links are shaped
that way, this diagnostic will say less about them than it says about
LinkedIn's. Widening the mask is a decision to make against a real payload
that needs it, not preemptively.

Reversal is cheap in both halves: one line restores the freshness window, and
`linkShape` is additive metadata that nothing reads to make a decision. The
thing that is _not_ cheap to reverse is the boundary — if a later change
starts recording link values to "just check something," this ADR's reasoning
is what it has to argue against first.

# ADR-073 — Coalesce on re-collection: a null from a source never overwrites a stored fact

## Status

Accepted

## Date

2026-08-29

## Context

`PostingsRepository.upsertIn`'s UPDATE branch assigned every column from the
incoming `Posting`, with one documented exception:

```ts
lastSeenAt: posting.lastSeenAt,
rawPayload: JSON.stringify(posting.rawPayload),
// firstSeenAt is deliberately absent from this SET clause.
```

That exception exists because ADR-007's amendment found the same class of bug
once already: a naive upsert overwriting `firstSeenAt` made every posting look
like it was found today after the next re-collection. The fix at the time was
scoped to the one column that had visibly broken.

The rest of the SET clause has the identical problem, and it was firing.

**`seniority` and `experienceYears` are the airtight case.** No normalizer
sets them — they are Stage A output, written by `updateExtractedFields` after
a model call, and every `Posting` a collector produces carries `null` for
both. So this UPDATE could only ever destroy them, never write one. Every
routine re-collection of an already-extracted posting reset the column to
null.

Measured on the production corpus, 2026-08-29, before the fix:

|                                                                     |               |
| ------------------------------------------------------------------- | ------------- |
| postings with a cached Stage A extraction                           | 214           |
| of those, `extractions.seniority` set but `postings.seniority` null | **111 (52%)** |
| agreed                                                              | 102           |
| genuinely null on both sides                                        | 1             |

The fact was never lost — `extractions.seniority` still held `internship` for
all 111 — but `postings.seniority` is the column the pipeline actually reads.
`aggregate-corpus.ts` builds M10's seniority breakdown from
`entry.posting.seniority ?? "unknown"`, so the market analysis reported
"unknown" for half the corpus it had already paid a model call to classify.
That is Question 2 of `docs/01-vision-and-scope.md` ("what do I need to
improve?") answered from data the system had corrupted itself.

**The source-data columns are the same reasoning one step out.** `description`,
`sourceUrl`, `publishedAt`, `applicationDeadline` and `country` do come from
sources — but a null there means "this source does not carry this fact", not
"the fact was retracted". `Posting`'s own field comments already say so
verbatim: _"Null when the source did not state one — absence is not evidence
the posting never expires"_, _"absence of a date is not evidence of an old
posting"_, _"Null is not 'unknown country' in practice"_.

Two sources reaching the same fingerprint is not hypothetical: **24
fingerprints have already been collected from more than one source**, and
`normalizeLinkedinAlertJob` hardcodes `description: null` because the alert
email carries none. A LinkedIn alert landing on a fingerprint Gupy had
described would blank the description, leaving Stage A with nothing to
extract — which trips `lowConfidence` and caps the verdict at `review`
(`docs/04-scoring-model.md`). No LinkedIn/Gupy collision has been observed
yet; there are only two LinkedIn rows so far.

## Considered options

### Option A — Coalesce the fields a source may legitimately omit

`posting.x ?? existing.x` for `seniority`, `experienceYears`,
`applicationDeadline`, `publishedAt`, `sourceUrl`, `description`, `country`.
Leave `source`, `sourceId`, `company`, `title`, `location`, `workMode`
assigned outright.

### Option B — Move `seniority`/`experienceYears` out of `postings` entirely

They are Stage A output and already live in `extractions`. Reading them from
there would make the duplication — and this whole bug — impossible.

### Option C — Have collectors read the stored row and re-supply what they lack

Push the merge up into normalization.

## Decision

**Option A.**

Option B is the structurally cleaner answer and is where this should go
eventually, but it is a schema and read-path change touching
`aggregate-corpus.ts`, `rowToPosting`, `list_postings` and the M10 report,
to fix a bug whose cause is one line. That is the wrong ratio while the
corpus is live and the phase-1 review is still open. Recorded here as the
known follow-up rather than done now.

Option C inverts the layering — a normalizer would need repository access to
produce a `Posting`, which is exactly the domain/infrastructure boundary
ADR-001 buys with NestJS's DI container.

The split between coalesced and overwritten columns is not arbitrary:
`source`, `sourceId`, `company`, `title`, `location` and `workMode` are stated
by every source on every sighting, so the latest statement is the one to
keep — and `location`/`workMode` legitimately carry `unknown` as a _value_,
not an absence, so coalescing them would be wrong in the other direction.

`firstSeenAt`'s existing exclusion is left exactly as it was. This decision
generalizes the principle behind it rather than replacing it.

## Consequences

**The 111 already-blanked rows are not repaired by this change** — see
Amendment 1, which repairs them separately. It stops the destruction; it does
not undo it. Each will refill on its next real
scoring pass, because `ApiScorer` calls `updateExtractedFields` on every
score including a cache hit — but only for postings that get scored again,
and an already-notified posting will not. A one-off backfill from
`extractions` into `postings` is the obvious repair and is deliberately not
bundled here: this PR should be provably about one behaviour change.

**A stale value can now outlive its truth.** If a source really does retract
a deadline or shorten a description, the old value survives. That is the
accepted cost, and it is the right direction: `Posting`'s contract already
treats absence as unknown rather than as a negative assertion everywhere else
in the pipeline, so keeping the last known fact is consistent with how every
consumer already reads these fields. A source that changes a fact still
overwrites it — only _omission_ is now inert.

**Cheap to reverse.** Deleting the seven `?? existing.x` terms restores the
previous behaviour exactly. No migration, no schema change, no cache to
invalidate.

**Verified by reverting.** Six tests in
`test/persistence/postings-repository.test.ts` fail without the change.

---

## Amendment 1 — the backfill, performed 2026-08-30

The decision above deliberately shipped the fix without repairing the rows it
had already lost, so that PR was provably about one behaviour change. The
repair was run separately, on the operator's explicit go-ahead.

**Two things happened between the fix landing and the backfill, and they are
worth separating.** The fix alone already moved the number: a full
re-collection of 2,354 postings took the blanked count from 111 to 91,
because values written by scoring now survived a collect instead of being
overwritten. Under the previous behaviour that same re-collection could only
have moved it the other way. That is the fix working, observed rather than
argued.

The remaining rows needed the backfill, because a posting already marked
`notifiedAt` is not re-scored, so nothing would ever rewrite its column.

**What was checked before writing anything:**

| Check                                                     | Result                             |
| --------------------------------------------------------- | ---------------------------------- |
| fingerprints holding more than one `extractions` row      | 17                                 |
| of those, any disagreeing about `seniority`               | **0**                              |
| postings whose stored value _differs_ from the extraction | **0**                              |
| distinct postings to fill                                 | 89 seniority, 1 `experience_years` |

The 17 duplicates agreeing means the choice of row could not change the
outcome; the query still orders by `extracted_at DESC` for determinism rather
than relying on that. Zero conflicts means the backfill only ever fills a
null — it never overwrites a value the pipeline had reason to hold.

A dedicated `VACUUM INTO` backup was taken first
(`argos-pre-backfill-2026-08-30T12-27-05-723Z.db`, 117 MB) and validated by
reopening it and counting both tables, rather than trusting that the write
succeeded. The two `UPDATE`s ran inside one transaction.

**Result:** 89 + 1 rows changed. Of the 196 postings holding an extraction,
those without a `seniority` went from 90 to **1** — and that last one is
genuinely unknown, its extraction having returned null. `PRAGMA quick_check`
returned `ok`, the posting count was unchanged at 4,367, and zero postings
now diverge from their extraction.

M10's experience-level breakdown over the extracted corpus, which was the
consequence that made this worth repairing at all, reads
`internship: 192, trainee: 3, unknown: 1` where it previously reported
roughly half the corpus as unknown.

**This does not change the decision above**, only its "not repaired"
consequence. Option B — moving `seniority`/`experienceYears` out of `postings`
entirely, since they already live in `extractions` — remains the open
structural follow-up, and remains deferred.

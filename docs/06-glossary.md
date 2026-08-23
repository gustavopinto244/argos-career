# 06 — Glossary

ADR-003 puts the repository in English and the Telegram digest in pt-BR. That
creates a translation boundary at `NotifierPort`, and a boundary is only
enforceable if both sides are written down. This page is the reference for both.

It also fixes vocabulary that is otherwise easy to drift on: this project has
three different words that all get casually called "job".

## Domain terms

| Term                          | Meaning                                                                                      | Not to be confused with                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Posting**                   | A normalized job advertisement — the domain entity every stage after normalization consumes  | `RawPosting`, which is source-shaped and pre-normalization                    |
| **RawPosting**                | Exactly what a source returned, tolerantly validated, shape owned by the source              | `Posting`; collapsing the two is the error `05-domain-model.md` warns about   |
| **Source**                    | A place postings come from: Gupy, Google Jobs, Indeed, LinkedIn                              | _Collector_, which is the adapter that talks to a source                      |
| **Collector**                 | The adapter implementing `CollectorPort` for one source                                      | _Scraper_ — a word this project avoids, since scraping at scale is a non-goal |
| **Fingerprint**               | `sha256` of normalized company + title + city; the deduplication key                         | Internal database id, and `sourceId`                                          |
| **Track**                     | A career direction: `dev`, `security`, `automation`, `data` (ADR-061)                        | _Category_, which groups requirements within one posting                      |
| **Category**                  | A grouping of requirements inside one posting, e.g. `language`, `education`                  | _Track_                                                                       |
| **Requirement**               | One thing a posting declares it wants, with a `weight`                                       | _Criterion_, which is a pre-filter rule                                       |
| **Weight** (of a requirement) | `blocking`, `mandatory` or `desirable`                                                       | The numeric weights in the score formula                                      |
| **Match**                     | The judgment of one requirement against the profile, with evidence                           | _Score_, which is computed from all matches                                   |
| **Evidence**                  | A verbatim quote from the profile supporting a `Match`                                       | A paraphrase — a non-verbatim "quote" is a failed match                       |
| **Verdict**                   | `apply`, `review` or `discard`, derived from the score                                       | The score itself                                                              |
| **Run**                       | One execution of the pipeline, collection or delivery                                        | _Digest_, which is what a delivery run produces                               |
| **Digest**                    | The message delivered to Telegram nightly (ADR-009)                                          | _Run_                                                                         |
| **Profile**                   | The master profile in `config/profile.yaml`, source of truth                                 | The resume PDFs, which are projections of it                                  |
| **Resume variant**            | A named subset of the profile — which tracks and competencies it foregrounds. Holds no prose | A resume file; the variant is a view over the profile                         |
| **Work mode**                 | `remote`, `hybrid`, `onsite` or `unknown`                                                    | _Location_, which is a place. Different axes                                  |
| **Seniority**                 | The level a posting requires, as a field                                                     | The title keyword the pre-filter matches on                                   |
| **Corpus**                    | Every posting ever collected, including rejected ones                                        | The digest shortlist                                                          |
| **Skill taxonomy**            | Global canonical skill names with aliases, for market counting (M10)                         | The profile's per-competency `aliases`, which describe one profile            |
| **Gap analysis**              | Taxonomized skills frequent in high-compatibility postings and absent from the profile (M10) | _Critical gaps_, which is per-posting and comes from a single `ScoreOutcome`  |
| **Study plan**                | The ranked, delivered-on-request output of gap analysis + market demand (M10)                | _Digest_, which is nightly and about specific postings, not skills            |
| **Period**                    | Academic semester index, 1–8, derived at runtime                                             | Calendar semester, e.g. `2027.1`                                              |

## Requirement weight vs. score weight

The word "weight" carries two unrelated meanings and this is the most likely
place for a misreading:

- A **requirement's** `weight` is categorical. It says how much a requirement
  matters to the employer: `blocking`, `mandatory` or `desirable`.
- The **score** weights are the numbers 35, 20 and 45 (ADR-026; originally
  65, 20 and 15). They say how much each coverage term contributes to the
  total.

They never appear in the same formula. When ambiguity is possible, write
"requirement weight" or "score weight" rather than relying on context.

## Translation boundary — code to digest

The left column never appears in a Telegram message; the right column never
appears in code, a test name, or a log field.

| Code (English)                 | Digest (pt-BR)                      |
| ------------------------------ | ----------------------------------- |
| `apply`                        | `candidatar`                        |
| `review`                       | `avaliar`                           |
| `discard`                      | `descartar`                         |
| `met`                          | `atende`                            |
| `partial`                      | `parcial`                           |
| `not_met`                      | `não atende`                        |
| `blocking`                     | `eliminatório`                      |
| `mandatory`                    | `obrigatório`                       |
| `desirable`                    | `desejável`                         |
| `criticalGaps`                 | `lacunas críticas`                  |
| `missingTerms`                 | `termos ausentes`                   |
| `lowConfidence`                | `baixa confiança`                   |
| `recommendedVariant`           | `currículo recomendado`             |
| `highlights`                   | `destacar`                          |
| `remote` / `hybrid` / `onsite` | `remoto` / `híbrido` / `presencial` |
| Posting                        | vaga                                |
| Digest                         | digest                              |
| Track                          | trilha                              |
| Period                         | período                             |
| Corpus                         | corpus                              |
| Gap analysis                   | lacunas mais frequentes             |
| Study plan                     | plano de estudos                    |
| Skill (taxonomy entry)         | tecnologia                          |

Translation happens **only** in the `NotifierPort` adapter. A pt-BR string
anywhere else — a domain enum, a log message, an error — is a bug, with one
deliberate exception below.

## Portuguese kept inside the code

These stay Portuguese because they are **literal strings being matched against
Brazilian posting text**, not translations:

```
estágio, estagiário, trainee          # title requirement
sênior, pleno, especialista,          # title blocklist
coordenador, gerente
```

Changing these to English would break the pre-filter, since Gupy postings are
written in Portuguese. They are data, not vocabulary — they live in
configuration, not in identifiers.

## Terms this project avoids

| Avoided                            | Use instead      | Why                                                                                     |
| ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| _Scraping_                         | Collection       | Scraping at scale is a non-goal; the word misdescribes a polite, low-volume JSON client |
| _ATS score_                        | Score, adherence | The system does not simulate any ATS (`01-vision-and-scope.md`)                         |
| _Ranking_ alone                    | Score, verdict   | Suggests a comparison against other candidates, which the system cannot see             |
| _AI_                               | LLM, model       | Vague where precision is available                                                      |
| _Match_ (as a verb, for a posting) | Score, adhere    | `Match` is a specific noun in this domain                                               |

import { computeAcademicPeriod } from "../../profile/domain/academic-period";
import { Profile, UNVERIFIED } from "../../profile/domain/profile";

/**
 * The single canonical list of everything Stage B is allowed to quote as
 * evidence (docs/audit AC-017 §5 PR-001). Before this existed,
 * `prompts.ts` rendered four kinds of line into `PROFILE_EVIDENCE` —
 * competency evidence, plus three derived/declared lines tagged
 * `[Academic enrollment]`, `[English level]`, `[Availability]`,
 * `[Compensation]` — while `evidence-provenance.ts` built its acceptance
 * index from `profile.competencies[].evidence` only. A model that correctly
 * quoted any of the three derived lines back verbatim therefore failed
 * provenance and was coerced to `not_met` — a regression AC-008 introduced
 * into exactly the postings ("cursando a partir do Xº período", an English
 * level, an availability window) M7's calibration found most common.
 *
 * The fix is structural, not a patch to the index: both the prompt
 * (`prompts.ts`) and the provenance check (`evidence-provenance.ts`) now
 * read from this one function, so they cannot describe two different sets
 * of "what the model saw" ever again.
 */
export interface EvidenceCatalogEntry {
  readonly tag: string;
  readonly text: string;
}

/**
 * Derived from `courseStart`/`courseEnd` via `computeAcademicPeriod`, never
 * a hardcoded period (CLAUDE.md §9). Postings ask "cursando a partir do 3º
 * período onward" constantly; without a quotable line stating which period
 * the candidate is in, Stage B answered `not_met` on every one, usually a
 * `blocking` requirement (ADR-014).
 */
function academicEvidenceEntries(
  profile: Profile,
  today: Date,
): EvidenceCatalogEntry[] {
  const period = computeAcademicPeriod(profile.courseStart, today);
  const completion = `${profile.courseEnd.getUTCFullYear()}.${profile.courseEnd.getUTCMonth() + 1 >= 7 ? 2 : 1}`;
  const course = `${profile.courseName} na ${profile.institution}`;
  const tag = "Academic enrollment";

  switch (period.status) {
    case "not_started":
      return [
        {
          tag,
          text: `Ingressa em ${course} e ainda não iniciou o curso; conclusão prevista para ${completion}.`,
        },
      ];
    case "completed":
      return [{ tag, text: `Concluiu ${course}.` }];
    case "in_progress":
      return [
        {
          tag,
          text: `Cursando o ${period.period}º período de ${course}, com conclusão prevista para ${completion}.`,
        },
      ];
  }
}

/**
 * `englishLevel`/`maxWeeklyHours`/`minimumStipend`/`workAvailability`
 * (CLAUDE.md §9) as quotable lines — the same class of gap
 * `academicEvidenceEntries` closes (ADR-014). A field still `UNVERIFIED` is
 * skipped rather than rendered: quoting "⚠ VERIFY" back as if it were an
 * answer would be worse than the field staying absent.
 */
function declaredFieldsEvidenceEntries(
  profile: Profile,
): EvidenceCatalogEntry[] {
  const entries: EvidenceCatalogEntry[] = [];
  if (profile.englishLevel !== UNVERIFIED) {
    entries.push({
      tag: "English level",
      text: `Nível de inglês: ${profile.englishLevel}.`,
    });
  }
  if (profile.maxWeeklyHours !== UNVERIFIED) {
    entries.push({
      tag: "Availability",
      text: `Disponibilidade de até ${profile.maxWeeklyHours} horas semanais.`,
    });
  }
  if (profile.workAvailability !== UNVERIFIED) {
    entries.push({
      tag: "Work availability",
      text: profile.workAvailability,
    });
  }
  if (profile.startAvailability && profile.startAvailability !== UNVERIFIED) {
    entries.push({
      tag: "Start availability",
      text: profile.startAvailability,
    });
  }
  if (profile.minimumInternshipMonths !== undefined) {
    entries.push({
      tag: "Internship duration",
      text: `Disponível para compromisso mínimo de ${profile.minimumInternshipMonths} meses de estágio.`,
    });
  }
  if (profile.minimumStipend !== UNVERIFIED) {
    entries.push({
      tag: "Compensation",
      text: `Bolsa-auxílio mínima aceita: ${profile.minimumStipend}.`,
    });
  }
  return entries;
}

function competencyEvidenceEntries(profile: Profile): EvidenceCatalogEntry[] {
  return profile.competencies.flatMap((competency) =>
    competency.evidence.map((text) => ({ tag: competency.name, text })),
  );
}

/**
 * Every entry Stage B may legally quote from (ADR-005), in the same order
 * `prompts.ts` has always rendered them: academic, then declared fields,
 * then each competency's evidence.
 */
export function buildEvidenceCatalog(
  profile: Profile,
  today: Date = new Date(),
): readonly EvidenceCatalogEntry[] {
  return [
    ...academicEvidenceEntries(profile, today),
    ...declaredFieldsEvidenceEntries(profile),
    ...competencyEvidenceEntries(profile),
  ];
}

/** `- [tag] text`, one per line — the exact rendering Stage B's prompt and
 * `stripEvidenceTag`'s decoration have always shared. */
export function formatEvidenceCatalog(
  catalog: readonly EvidenceCatalogEntry[],
): string {
  return catalog.map((entry) => `- [${entry.tag}] ${entry.text}`).join("\n");
}

import { Posting } from "../../posting/domain/posting";
import { keywordMatchesText } from "../../prefilter/domain/title-match";
import { JobRadarConfig } from "./job-radar-config";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const BRAZILIAN_SOURCES = new Set([
  "gupy",
  "infojobs",
  "solides",
  "catho",
  "indeed",
  "vagas",
  "ciee",
  "nerdin",
]);
const SPECIALIZED_TITLE =
  /\b(qa|software|programador|desenvolvedor|engenheiro|enfermagem|tecnico|contabil|fiscal|juridico|ti|senior|pleno|gerente|coordenador|supervisor|estagio|estagiario|trainee)\b/;
const HIGHER_EDUCATION =
  /\b(superior|graduacao|graduado|faculdade|universidade|bacharel|tecnologo|pos graduacao|formacao tecnica|curso tecnico)\b/;
const BASIC_EDUCATION =
  /\b(ensino|nivel) (medio|fundamental)\b|\b(segundo|2[º°o]?) grau\b|nao (exige|requer|precisa de) (faculdade|graduacao|ensino superior)/;

/** Conservative text rules: missing qualifications or geography do not pass. */
export function isSimpleJobAllowed(
  posting: Posting,
  config: JobRadarConfig["delivery"],
): boolean {
  const title = normalize(posting.title);
  if (
    !config.titleTerms.some((term) =>
      keywordMatchesText(posting.title, term),
    ) ||
    SPECIALIZED_TITLE.test(title)
  )
    return false;
  if (posting.seniority && posting.seniority !== "junior") return false;
  if (posting.experienceYears !== null && posting.experienceYears > 2)
    return false;

  const national =
    posting.country === "BR" ||
    (posting.country === null && BRAZILIAN_SOURCES.has(posting.source));
  if (!national) return false;
  const local =
    posting.workMode === "onsite" &&
    posting.location.kind === "known" &&
    normalize(posting.location.city).trim() ===
      normalize(config.onsiteCity).trim();
  if (!local && posting.workMode !== "remote") return false;

  const description = normalize(posting.description ?? "");
  if (!BASIC_EDUCATION.test(description)) return false;
  // Optional education does not turn into a mandatory degree requirement.
  const clauses = description.split(/[.;\n!?]+/);
  if (
    clauses.some(
      (clause) =>
        HIGHER_EDUCATION.test(clause) &&
        !/desejavel|diferencial|opcional|nao (exige|requer|precisa)|nao obrigatori/.test(
          clause,
        ),
    )
  )
    return false;
  if (
    /\b(crea|coren|oab|crc|ingles avancado|ingles fluente|sql|python|javascript|programacao)\b/.test(
      description,
    )
  )
    return false;
  // Remote vacancies with a residency restriction are not nationwide.
  if (
    posting.workMode === "remote" &&
    /\b(residir|residente|moradores|residencia|disponibilidade para (viagens|atuacao presencial)|comparecer presencialmente)\b/.test(
      description,
    )
  )
    return false;
  return true;
}

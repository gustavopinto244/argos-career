import { WorkMode } from "../../posting/domain/posting";
import { ScoreFailureReason, Verdict } from "../../scoring/domain/types";
import { Digest, ScoredPosting } from "./digest";

/**
 * Translation boundary (ADR-003, docs/06-glossary.md): pt-BR text is only
 * ever produced here, never in a domain type, log message or error.
 */
const VERDICT_LABEL: Record<Verdict, string> = {
  apply: "candidatar",
  review: "avaliar",
  discard: "descartar",
};

const WORK_MODE_LABEL: Record<WorkMode, string> = {
  remote: "Remoto",
  hybrid: "Híbrido",
  onsite: "Presencial",
  unknown: "Local não informado",
};

/** docs/audit AC-009 / ADR-006: a posting `ScorerPort.score` could not
 * score at all still appears here, with this reason attached, instead of
 * silently vanishing from the digest. */
const SCORE_FAILURE_LABEL: Record<ScoreFailureReason, string> = {
  invalid_output: "o modelo não retornou uma resposta válida",
  extraction_failed: "falha ao extrair requisitos da vaga",
  matching_failed: "falha ao avaliar os requisitos contra o perfil",
  max_retries_exceeded:
    "falhou repetidamente e não será mais tentada automaticamente — descarte manual ou correção do problema necessários",
};

function renderLocation(posting: ScoredPosting["posting"]): string {
  const city = posting.location.kind === "known" ? posting.location.city : null;
  const mode = WORK_MODE_LABEL[posting.workMode];
  return city ? `${city} · ${mode}` : mode;
}

/**
 * The per-posting entry (docs/02-architecture.md). `outcome` is
 * `ScoreOutcome & Recommendation` (`digest.ts`), so `recommendedVariant`/
 * `highlights`/`missingTerms`/`criticalGaps` are rendered directly from what
 * `ApiScorer` already computed — Question 3 of `01-vision-and-scope.md`
 * ("how should I present my profile here?") was being paid for and
 * discarded before this (docs/audit AC-026). `StubScorer` populates
 * `EMPTY_RECOMMENDATION`, so every optional line below is conditional and
 * simply does not appear for a stubbed run, rather than printing an empty
 * label.
 *
 * The original posting link is mandatory (docs/02): when a source provided
 * none, the entry says so explicitly rather than omitting the line, since a
 * silently missing link is the one thing that breaks the under-10-minutes
 * goal.
 */
export function renderPostingEntry(entry: ScoredPosting): string {
  const { posting, outcome } = entry;
  const lines = [
    `Empresa: ${posting.company}`,
    `Cargo: ${posting.title}`,
    `Compatibilidade: ${Math.round(outcome.score)}% · ${VERDICT_LABEL[outcome.verdict]}`,
    `Local: ${renderLocation(posting)}`,
    `Fonte: ${posting.source}`,
    `→ ${posting.sourceUrl ?? "(link não informado pela fonte)"}`,
  ];
  // outcome.score reflects empty-category coverage (docs/04: "empty category
  // → coverage 1"), which reads as a strong match even when almost nothing
  // was actually extracted and verified — lowConfidence is docs/04's own
  // signal for exactly that gap, so it must be visible here or the percentage
  // above is misleading rather than merely incomplete.
  if (outcome.scoreFailureReason) {
    lines.push(
      `⚠ Não foi possível pontuar automaticamente (${SCORE_FAILURE_LABEL[outcome.scoreFailureReason]}) — avaliação manual necessária`,
    );
  } else if (outcome.lowConfidence) {
    lines.push(
      "⚠ Confiança baixa — poucos requisitos verificáveis extraídos da vaga",
    );
  }
  if (outcome.inputTruncated) {
    lines.push(
      "⚠ Conteúdo da vaga foi reduzido ao limite de segurança antes da avaliação",
    );
  }
  if (outcome.recommendedVariant) {
    lines.push(`Currículo recomendado: ${outcome.recommendedVariant}`);
  }
  if (outcome.highlights.length > 0) {
    lines.push(`Pontos fortes: ${outcome.highlights.join("; ")}`);
  }
  if (outcome.missingTerms.length > 0) {
    lines.push(
      `Termos ausentes no currículo: ${outcome.missingTerms.join(", ")}`,
    );
  }
  if (outcome.criticalGaps.length > 0) {
    lines.push(
      `Lacunas: ${outcome.criticalGaps.map((r) => r.text).join("; ")}`,
    );
  }
  return lines.join("\n");
}

function renderSection(
  title: string,
  entries: readonly ScoredPosting[],
): string {
  if (entries.length === 0) return `${title}\n\n(nenhuma vaga)`;
  return `${title}\n\n${entries.map(renderPostingEntry).join("\n\n")}`;
}

function renderPeriodBlockedSection(digest: Digest): string {
  const { periodBlocked } = digest;
  if (periodBlocked.length === 0)
    return "Abrem para você em breve\n\n(nenhuma vaga)";
  const lines = periodBlocked.map(
    ({ posting, opensAtLabel }) =>
      `${posting.company} — ${posting.title}\nAbre para você em ${opensAtLabel}`,
  );
  return `Abrem para você em breve\n\n${lines.join("\n\n")}`;
}

/**
 * The section for postings that scored well and cannot be opened (ADR-077).
 *
 * Deliberately shaped differently from `renderPostingEntry`: there is no
 * "→ link" line to print, so instead of repeating "(link não informado pela
 * fonte)" — which reads as an error and gives the operator nothing — it
 * names the one thing that *does* make the posting findable, the source's
 * own identifier. For CIEE that is `codigoVaga`, carried through as
 * `sourceId`.
 */
function renderUnreachableSection(digest: Digest): string {
  const title = "Sem link direto — procure no portal da fonte";
  if (digest.unreachable.length === 0) return `${title}\n\n(nenhuma vaga)`;
  const lines = digest.unreachable.map(({ posting, outcome }) =>
    [
      `Empresa: ${posting.company}`,
      `Cargo: ${posting.title}`,
      `Compatibilidade: ${Math.round(outcome.score)}% · ${VERDICT_LABEL[outcome.verdict]}`,
      `Local: ${renderLocation(posting)}`,
      `Procure em ${posting.source} pelo código ${posting.sourceId}`,
    ].join("\n"),
  );
  return `${title}\n\n${lines.join("\n\n")}`;
}

function renderSummary(digest: Digest): string {
  const { summary } = digest;
  const failedSources =
    summary.failedSources.length > 0
      ? summary.failedSources.join(", ")
      : "nenhuma";
  const truncatedSources =
    summary.truncatedSources.length > 0
      ? summary.truncatedSources.join(", ")
      : "nenhuma";
  return [
    "Resumo da execução",
    "",
    `Coletadas: ${summary.collected}`,
    `Novas após deduplicação: ${summary.deduplicated}`,
    `Após pré-filtro: ${summary.filtered}`,
    `Pontuadas: ${summary.scored}`,
    `Fontes com falha: ${failedSources}`,
    `Fontes truncadas pelo limite: ${truncatedSources}`,
  ].join("\n");
}

/**
 * The full Telegram message body, plain text, sections in the order fixed by
 * docs/02-architecture.md: recommended, review, period-blocked, run summary.
 * Section 4 is what keeps principle 1 honest — a failed source is visible in
 * the digest instead of silently absent.
 */
export function renderDigestText(digest: Digest): string {
  const sections = [
    renderSection("Recomendadas", digest.recommended),
    renderSection("Vale avaliar", digest.review),
    renderPeriodBlockedSection(digest),
    renderUnreachableSection(digest),
    renderSummary(digest),
  ];
  return sections.join("\n\n---\n\n");
}

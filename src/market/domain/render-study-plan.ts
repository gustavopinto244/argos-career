import { StudyPlan } from "./study-plan";

const TOP_GAPS = 10;
const TOP_MARKET_DEMAND = 10;

// Already 0-100 when it arrives (`percentageOf`) -- this used to be where
// the fraction was scaled, which is what made the stored unit's name wrong
// without any visible symptom here (ADR-078 Amendment 1).
function percent(value: number): string {
  return `${Math.round(value)}%`;
}

function renderCorpusLine(plan: StudyPlan): string {
  return (
    `Corpus: ${plan.corpusSize} vagas · ${plan.extractedCount} com ` +
    `extração completa · ${plan.highCompatibilityCount} de alta compatibilidade`
  );
}

function renderGaps(plan: StudyPlan): string {
  if (plan.gaps.length === 0) {
    return "Lacunas mais frequentes\n\n(nenhuma lacuna identificada)";
  }
  const lines = plan.gaps
    .slice(0, TOP_GAPS)
    .map(
      (gap, index) =>
        `${index + 1}. ${gap.skill} — ${gap.count} de ${plan.highCompatibilityCount} vagas de alta compatibilidade (${percent(gap.percentage)})`,
    );
  return [
    "Lacunas mais frequentes (não cobertas pelo perfil)",
    "",
    ...lines,
  ].join("\n");
}

function renderMarketDemand(plan: StudyPlan): string {
  if (plan.marketDemand.length === 0) {
    return "Tecnologias mais pedidas no mercado\n\n(sem dados suficientes)";
  }
  const lines = plan.marketDemand
    .slice(0, TOP_MARKET_DEMAND)
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.skill} — ${entry.count} de ${plan.extractedCount} vagas com extração (${percent(entry.percentage)})`,
    );
  return ["Tecnologias mais pedidas no mercado", "", ...lines].join("\n");
}

function renderVolumeByWeek(plan: StudyPlan): string {
  if (plan.volumeByWeek.length === 0) {
    return "Volume por semana\n\n(sem dados)";
  }
  const lines = plan.volumeByWeek.map(
    (point) => `${point.weekStart}: ${point.count} vagas`,
  );
  return ["Volume por semana", "", ...lines].join("\n");
}

/**
 * The full Telegram message body for a study plan — pt-BR, translation
 * boundary same as `renderDigestText` (ADR-003, docs/06-glossary.md). Plain
 * text; `TelegramNotifier.sendText` + `splitForTelegram` handle chunking if
 * this exceeds Telegram's message limit, so no truncation logic belongs
 * here beyond capping each ranked list to a readable top N.
 */
export function renderStudyPlanText(plan: StudyPlan): string {
  const sections = [
    renderCorpusLine(plan),
    renderGaps(plan),
    renderMarketDemand(plan),
    renderVolumeByWeek(plan),
  ];
  return sections.join("\n\n---\n\n");
}

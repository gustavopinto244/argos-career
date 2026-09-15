import { Posting, WorkMode } from "../../posting/domain/posting";

const WORK_MODE_LABEL: Record<WorkMode, string> = {
  remote: "Remoto",
  hybrid: "Híbrido",
  onsite: "Presencial",
  unknown: "Local não informado",
};

function renderPosting(posting: Posting): string {
  const city = posting.location.kind === "known" ? posting.location.city : null;
  const location = city
    ? `${city} · ${WORK_MODE_LABEL[posting.workMode]}`
    : WORK_MODE_LABEL[posting.workMode];
  return [
    `Empresa: ${posting.company}`,
    `Cargo: ${posting.title}`,
    `Local: ${location}`,
    `Fonte: ${posting.source}`,
    `→ ${posting.sourceUrl ?? "(link não informado pela fonte)"}`,
  ].join("\n");
}

export function renderJobRadarText(input: {
  readonly label: string;
  readonly location: string;
  readonly postings: readonly Posting[];
}): string {
  const header = `${input.label}\nLocal: ${input.location}`;
  if (input.postings.length === 0) {
    return `${header}\n\nNenhuma vaga nova desde o último envio.`;
  }
  return `${header}\n\n${input.postings.map(renderPosting).join("\n\n---\n\n")}`;
}

/** One result from 99jobs's server-rendered public search fragment. */
export interface NinetyNineJobsListingCard {
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly company: string;
  readonly city: string | null;
  readonly workMode: "remote" | "hybrid" | "onsite" | "unknown";
}

const CARD_BOUNDARY = /<a\s+class="opportunity-card"[^>]*>/g;
const HREF = /href="([^"]+)"/;
const TITLE = /<h1>([\s\S]*?)<\/h1>/;
const COMPANY = /opportunity-company-infos[\s\S]*?<h2>([\s\S]*?)<\/h2>/;
const MODE = /opportunity-label-acting-mode">([\s\S]*?)<\/span>/;
const ADDRESS = /opportunity-address[\s\S]*?<p>([\s\S]*?)<\/p>/;
const ID_IN_PATH = /\/(?:jobs|vagas)\/(\d+)(?:-|\/|$)/;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapWorkMode(
  label: string | undefined,
): NinetyNineJobsListingCard["workMode"] {
  const normalized = decodeHtml(label ?? "").toLowerCase();
  if (normalized === "remota" || normalized === "remoto") return "remote";
  if (normalized === "híbrida" || normalized === "hibrida") return "hybrid";
  if (normalized === "presencial") return "onsite";
  return "unknown";
}

/**
 * Parses the HTML fragment returned by 99jobs's own filtered-search route.
 * Cards missing identity, link, full-enough title or company are skipped;
 * one malformed card never discards the rest of the page.
 */
export function parseNinetyNineJobsListing(
  html: string,
): NinetyNineJobsListingCard[] {
  const boundaries = [...html.matchAll(CARD_BOUNDARY)].map((match) => ({
    index: match.index,
    tag: match[0],
  }));
  const cards: NinetyNineJobsListingCard[] = [];

  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]!;
    const end = boundaries[index + 1]?.index ?? html.length;
    const block = html.slice(boundary.index, end);
    const rawHref = HREF.exec(boundary.tag)?.[1];
    const href = rawHref ? decodeHtml(rawHref) : null;
    const id = href ? ID_IN_PATH.exec(href)?.[1] : null;
    const title = decodeHtml(TITLE.exec(block)?.[1] ?? "");
    const company = decodeHtml(COMPANY.exec(block)?.[1] ?? "");
    if (!href || !id || !title || !company) continue;

    const rawAddress = decodeHtml(ADDRESS.exec(block)?.[1] ?? "");
    const statedCity = rawAddress
      ? rawAddress.split(",")[0]?.trim() || null
      : null;
    const city =
      statedCity && !/^n[aã]o informado$/i.test(statedCity) ? statedCity : null;
    cards.push({
      id,
      href,
      title,
      company,
      city,
      workMode: mapWorkMode(MODE.exec(block)?.[1]),
    });
  }

  return cards;
}

/** Total reported by the search fragment, repeated once beside each card. */
export function parseNinetyNineJobsTotal(html: string): number | null {
  const raw = /name="count_opportunities"\s+value="(\d+)"/.exec(html)?.[1];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

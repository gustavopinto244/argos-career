/**
 * Extracts one card per posting from a Vagas.com listing page's real HTML
 * (ADR-080). No general HTML parser — the same choice ADR-063 made for
 * InfoJobs, and for the same reason: every field this project needs from a
 * card (`data-id-vaga`, its detail link, its publication-date badge) sits
 * inside one `<li class="vaga ...">` per result, verified to never nest
 * another `<li>` in a real listing capture, so a lazy `.*?` regex between
 * `<li class="vaga` and the next `</li>` is reliable here in a way it would
 * not be for a deeper document.
 *
 * The full posting (description, structured location, `jobLocationType`)
 * comes from the **detail** page's `application/ld+json` block instead
 * (`vagas-schema.ts`), a real JSON parse — this function only has to find
 * *which* detail pages exist and, cheaply, how old each one is.
 *
 * Deliberately tolerant, matching every other source's schema discipline:
 * a card missing an id or a link is skipped, not a collection failure
 * (principle 1).
 */
export interface ListingCard {
  readonly id: string;
  readonly href: string;
  /**
   * The listing's own publication-date badge, verbatim — "Hoje", "Ontem",
   * "Há N dias" or "DD/MM/YYYY", observed across a real capture. `null`
   * when the card carries none. Parsed by `parsePublishedLabel`
   * (`vagas-collector.ts`) into an actual `Date`, kept as raw text here so
   * this function stays a pure extraction step with no `now`-dependent
   * logic of its own.
   */
  readonly publishedLabel: string | null;
}

const CARD_BOUNDARY = /<li class="vaga[^"]*">/g;
const ID_ATTR = /data-id-vaga="(\d+)"/;
const HREF_ATTR = /href="(\/vagas\/v\d+[^"]*)"/;
const PUBLISHED_LABEL =
  /<span class="data-publicacao"><i[^>]*><\/i>([^<]+)<\/span>/;

export function parseVagasListing(html: string): ListingCard[] {
  const boundaries = [...html.matchAll(CARD_BOUNDARY)].map((m) => m.index);
  if (boundaries.length === 0) return [];

  const cards: ListingCard[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1] ?? html.length;
    const block = html.slice(start, end);

    const id = ID_ATTR.exec(block)?.[1];
    const href = HREF_ATTR.exec(block)?.[1];
    if (!id || !href) continue;

    const publishedLabel = PUBLISHED_LABEL.exec(block)?.[1]?.trim() ?? null;

    cards.push({ id, href, publishedLabel });
  }
  return cards;
}

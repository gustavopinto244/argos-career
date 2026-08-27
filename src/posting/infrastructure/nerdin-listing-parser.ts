/**
 * Extracts one card per posting from a NerdIn listing page's real HTML
 * (ADR-071). No general HTML parser — the same reasoning
 * `infojobs-listing-parser.ts` gives: the only thing this project needs
 * from the listing is *which* detail pages to fetch, and the full posting
 * comes from the detail page's `application/ld+json` block, a real JSON
 * parse rather than scraped markup.
 *
 * **NerdIn hands the id over inside the href itself** —
 * `vaga_emprego/<slug>-<id>.php` — so unlike InfoJobs there is no separate
 * `data-id` attribute to pair up, and no card-boundary scan is needed. A
 * single href scan is both simpler and more robust to a card-markup change.
 *
 * Verified against the real capture (`npm run fixture:nerdin`,
 * 2026-08-27): a search stating "9 vagas disponíveis" yields exactly 9
 * unique ids from this scan — no inflation from sidebar, "related jobs" or
 * footer links. If that ever stops holding, the fix is to scope the scan to
 * the results container, not to add a parser dependency.
 *
 * **Deduplicated by id, first occurrence winning.** A card's title anchor
 * and its `data-href` div both point at the same posting, so without this
 * every posting would be counted — and detail-fetched — twice.
 *
 * Deliberately tolerant, matching every other source: a link that does not
 * carry a trailing numeric id is skipped, never a collection failure
 * (principle 1).
 */
export interface NerdinListingCard {
  readonly id: string;
  readonly href: string;
}

/** `vaga_emprego/vaga-estagio-suporte-ti-98167.php` → id `98167`. The `[^"'#?\s]`
 * class stops the match at an attribute boundary, a fragment or a query
 * string rather than swallowing the rest of the tag. */
const CARD_HREF = /vaga_emprego\/[^"'#?\s]*?-(\d+)\.php/gi;

export function parseNerdinListing(html: string): NerdinListingCard[] {
  const byId = new Map<string, string>();
  for (const match of html.matchAll(CARD_HREF)) {
    const id = match[1]!;
    if (!byId.has(id)) byId.set(id, match[0]);
  }
  return [...byId].map(([id, href]) => ({ id, href }));
}

/**
 * Extracts one card per posting from an InfoJobs listing page's real HTML
 * (ADR-063). No general HTML parser — a new dependency this project does
 * not otherwise need — because the field this project actually needs from
 * the listing (`data-id`, `data-href`) sits on one `<div>` per card, in a
 * shape verified stable across every real card sampled during discovery
 * (`npm run fixture:infojobs`). The full posting (description, structured
 * location, salary) comes from the **detail** page's `application/ld+json`
 * block instead (`infojobs-schema.ts`), a real JSON parse, not scraped —
 * this function only has to find *which* detail pages to fetch.
 *
 * Deliberately tolerant, matching every other source's schema discipline:
 * a card missing `data-id` or a title is skipped, not a collection failure
 * (principle 1) — one unexpected card must not lose the rest of the page.
 */
export interface ListingCard {
  readonly id: string;
  readonly href: string;
}

const CARD_BOUNDARY = /<div id="vacancy\d+"/g;
const ID_ATTR = /data-id="(\d+)"/;
const HREF_ATTR = /data-href="(\/vaga-de-[^"]+)"/;

export function parseInfoJobsListing(html: string): ListingCard[] {
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

    cards.push({ id, href });
  }
  return cards;
}

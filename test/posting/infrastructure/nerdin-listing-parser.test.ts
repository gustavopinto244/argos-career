import { describe, expect, it } from "vitest";
import { parseNerdinListing } from "../../../src/posting/infrastructure/nerdin-listing-parser";

const card = (id: string, slug = "vaga-estagio-suporte") =>
  `<div class="vaga-card" data-href="vaga_emprego/${slug}-${id}.php" style="cursor: pointer;">
     <a href="vaga_emprego/${slug}-${id}.php" class="btn btn-ver-vaga">Quero essa Vaga</a>
   </div>`;

describe("parseNerdinListing (ADR-071)", () => {
  it("extracts the id from the href's trailing number", () => {
    // NerdIn carries the id inside the URL rather than in a separate
    // data-id attribute, which is why no card-boundary scan is needed.
    expect(parseNerdinListing(card("98167"))).toEqual([
      { id: "98167", href: "vaga_emprego/vaga-estagio-suporte-98167.php" },
    ]);
  });

  it("deduplicates the two anchors a single card points at itself with", () => {
    // The card div and its "Quero essa Vaga" button are both links to the
    // same posting. Counting both would double every posting AND double the
    // detail-fetch cost against the source.
    const cards = parseNerdinListing(card("98167"));
    expect(cards).toHaveLength(1);
  });

  it("keeps listing order, which is the order the budget is spent in", () => {
    const html = card("98190") + card("98167") + card("98036");
    expect(parseNerdinListing(html).map((c) => c.id)).toEqual([
      "98190",
      "98167",
      "98036",
    ]);
  });

  it("returns an empty array for a page with no cards", () => {
    expect(
      parseNerdinListing("<html><body>Nenhuma vaga</body></html>"),
    ).toEqual([]);
  });

  it("skips a link with no trailing numeric id without losing its neighbours", () => {
    const html =
      card("98190") +
      `<a href="vaga_emprego/vaga-sem-id.php">quebrada</a>` +
      card("98036");
    expect(parseNerdinListing(html).map((c) => c.id)).toEqual([
      "98190",
      "98036",
    ]);
  });

  it("ignores links that are not detail pages", () => {
    const html =
      `<a href="vagas.php?busca_vaga=estagio">busca</a>` +
      `<a href="empresas.php">empresas</a>` +
      card("98190");
    expect(parseNerdinListing(html).map((c) => c.id)).toEqual(["98190"]);
  });

  it("stops the href at an attribute or query boundary", () => {
    // Without the character class the match could swallow the rest of the
    // tag and produce an href that 404s.
    const [parsed] = parseNerdinListing(
      `<a href="vaga_emprego/vaga-x-99.php?utm=abc" class="btn">x</a>`,
    );
    expect(parsed?.href).toBe("vaga_emprego/vaga-x-99.php");
  });
});

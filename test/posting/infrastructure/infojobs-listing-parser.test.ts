import { describe, expect, it } from "vitest";
import { parseInfoJobsListing } from "../../../src/posting/infrastructure/infojobs-listing-parser";

function card(id: string, href: string): string {
  return `
<div id="vacancy${id}" data-modelversion="" data-id="${id}" class="pt-24 px-24 cursor-pointer js_vacancyLoad js_rowCard js_cardLink" data-href="${href}" data-testabbutton="false">
  <h2 class="js_vacancyTitle">Estágio de TI</h2>
</div>`;
}

describe("parseInfoJobsListing", () => {
  it("extracts id and href from each card", () => {
    const html =
      card("111", "/vaga-de-estagio-ti__111.aspx") +
      card("222", "/vaga-de-estagio-dados__222.aspx");
    expect(parseInfoJobsListing(html)).toEqual([
      { id: "111", href: "/vaga-de-estagio-ti__111.aspx" },
      { id: "222", href: "/vaga-de-estagio-dados__222.aspx" },
    ]);
  });

  it("returns an empty array when the page has no cards at all", () => {
    expect(
      parseInfoJobsListing("<html><body>No results</body></html>"),
    ).toEqual([]);
  });

  it("skips a card missing data-id, without losing the others", () => {
    const broken = `<div id="vacancy333" data-href="/vaga-de-x__333.aspx"></div>`;
    const html =
      card("111", "/vaga-de-estagio-ti__111.aspx") +
      broken +
      card("222", "/vaga-de-estagio-dados__222.aspx");
    expect(parseInfoJobsListing(html)).toEqual([
      { id: "111", href: "/vaga-de-estagio-ti__111.aspx" },
      { id: "222", href: "/vaga-de-estagio-dados__222.aspx" },
    ]);
  });

  it("skips a card missing data-href, without losing the others", () => {
    const broken = `<div id="vacancy333" data-id="333"></div>`;
    const html = card("111", "/vaga-de-estagio-ti__111.aspx") + broken;
    expect(parseInfoJobsListing(html)).toEqual([
      { id: "111", href: "/vaga-de-estagio-ti__111.aspx" },
    ]);
  });

  it("does not mix fields from one card into the next", () => {
    // A regression guard for the block-boundary logic itself: if a card's
    // slice ever bled into the next one, the second id/href pulled here
    // would silently match the third card's html a positioned earlier.
    const html =
      card("1", "/vaga-de-a__1.aspx") +
      card("2", "/vaga-de-b__2.aspx") +
      card("3", "/vaga-de-c__3.aspx");
    const parsed = parseInfoJobsListing(html);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toEqual({ id: "2", href: "/vaga-de-b__2.aspx" });
  });
});

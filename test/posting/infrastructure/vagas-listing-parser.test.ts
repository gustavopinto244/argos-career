import { describe, expect, it } from "vitest";
import { parseVagasListing } from "../../../src/posting/infrastructure/vagas-listing-parser";

function card(
  id: string,
  href: string,
  publishedLabel: string | null = "Hoje",
): string {
  const dateBadge =
    publishedLabel === null
      ? ""
      : `<span class="data-publicacao"><i class="bx bx-time-five"></i>${publishedLabel}</span>`;
  return `
<li class="vaga even ">
  <header class="clearfix">
    <div class="informacoes-header">
      <h2 class="cargo">
        <a class="link-detalhes-vaga" data-id-vaga="${id}" title="Estágio de TI" id="v${id}" href="${href}">
          Estágio de TI
        </a>
      </h2>
    </div>
  </header>
  <footer>
    <div class="vaga-local"><i class="bx bx-map"></i>Rio de Janeiro / RJ</div>
    ${dateBadge}
  </footer>
</li>`;
}

describe("parseVagasListing", () => {
  it("extracts id, href and the publication-date badge from each card", () => {
    const html =
      card("111", "/vagas/v111/estagio-ti", "Hoje") +
      card("222", "/vagas/v222/estagio-dados", "12/08/2026");
    expect(parseVagasListing(html)).toEqual([
      { id: "111", href: "/vagas/v111/estagio-ti", publishedLabel: "Hoje" },
      {
        id: "222",
        href: "/vagas/v222/estagio-dados",
        publishedLabel: "12/08/2026",
      },
    ]);
  });

  it("returns an empty array when the page has no cards at all", () => {
    expect(parseVagasListing("<html><body>No results</body></html>")).toEqual(
      [],
    );
  });

  it("keeps the card when it carries no date badge", () => {
    const html = card("111", "/vagas/v111/estagio-ti", null);
    expect(parseVagasListing(html)).toEqual([
      { id: "111", href: "/vagas/v111/estagio-ti", publishedLabel: null },
    ]);
  });

  it("skips a card missing data-id-vaga, without losing the others", () => {
    const broken = `<li class="vaga odd "><a href="/vagas/v333/x"></a></li>`;
    const html =
      card("111", "/vagas/v111/estagio-ti") +
      broken +
      card("222", "/vagas/v222/estagio-dados");
    expect(parseVagasListing(html)).toEqual([
      { id: "111", href: "/vagas/v111/estagio-ti", publishedLabel: "Hoje" },
      { id: "222", href: "/vagas/v222/estagio-dados", publishedLabel: "Hoje" },
    ]);
  });

  it("skips a card missing an href, without losing the others", () => {
    const broken = `<li class="vaga odd "><a data-id-vaga="333"></a></li>`;
    const html = card("111", "/vagas/v111/estagio-ti") + broken;
    expect(parseVagasListing(html)).toEqual([
      { id: "111", href: "/vagas/v111/estagio-ti", publishedLabel: "Hoje" },
    ]);
  });

  it("does not mix fields from one card into the next", () => {
    const html =
      card("1", "/vagas/v1/a", "Hoje") +
      card("2", "/vagas/v2/b", "Ontem") +
      card("3", "/vagas/v3/c", "12/08/2026");
    const parsed = parseVagasListing(html);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toEqual({
      id: "2",
      href: "/vagas/v2/b",
      publishedLabel: "Ontem",
    });
  });
});

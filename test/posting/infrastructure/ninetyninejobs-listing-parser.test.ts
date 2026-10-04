import { describe, expect, it } from "vitest";
import {
  parseNinetyNineJobsListing,
  parseNinetyNineJobsTotal,
} from "../../../src/posting/infrastructure/ninetyninejobs-listing-parser";

function card(
  href: string,
  title = "Estágio em Desenvolvimento",
  company = "Empresa &amp; Companhia",
  mode = "Híbrida",
  address = "Rio de Janeiro, RJ",
): string {
  return `<input type="hidden" name="count_opportunities" value="2">
<a class="opportunity-card" href="${href}">
  <div class="opportunity-card-content">
    <h1>${title}</h1>
    <span class="opportunity-label opportunity-label-acting-mode">${mode}</span>
    <div class="opportunity-address"><p>${address}</p></div>
    <div class="opportunity-company-infos"><h2>${company}</h2></div>
  </div>
</a>`;
}

describe("parseNinetyNineJobsListing", () => {
  it("extracts legacy jobs and company-portal vagas cards", () => {
    const parsed = parseNinetyNineJobsListing(
      card(
        "https://99jobs.com/acme/jobs/900001-estagio?utm_source=portal&amp;utm_id=1",
      ) +
        card(
          "https://acme.99jobs.com/vagas/900002-estagio-seguranca",
          "Estágio em Segurança",
          "Outra Empresa",
          "Remota",
          "Não informado",
        ),
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        id: "900001",
        company: "Empresa & Companhia",
        city: "Rio de Janeiro",
        workMode: "hybrid",
      }),
      expect.objectContaining({
        id: "900002",
        city: null,
        workMode: "remote",
      }),
    ]);
  });

  it("skips malformed cards and reports the source total", () => {
    const html =
      '<input type="hidden" name="count_opportunities" value="37">' +
      '<a class="opportunity-card" href="https://evil.test/jobs/1"><h1>x</h1></a>';
    expect(parseNinetyNineJobsListing(html)).toEqual([]);
    expect(parseNinetyNineJobsTotal(html)).toBe(37);
  });
});

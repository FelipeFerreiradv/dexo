import { describe, it, expect } from "vitest";
import { renderTeamProductivityReport } from "../app/reports/team-productivity-report";

// G3 — a seção "Orçamentos por vendedor" entra no relatório de Produtividade da
// equipe. Validamos que o PDF é gerado sem erro, inclusive quando há orçamentos
// SEM produtividade (esse caso passa a renderizar o FullDoc, não o EmptyDoc).

function isPdf(b: Buffer): boolean {
  return b.slice(0, 5).toString("latin1") === "%PDF-";
}

const baseData = {
  company: "Dexo Peças",
  generatedAtLabel: "26/06/2026 18:00",
  range: {
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-06-26T23:59:59.999Z",
    label: "Junho/2026",
  },
  totals: { produtos: 0, anuncios: { total: 0, ml: 0, shopee: 0, outro: 0 } },
  byCollaborator: [] as any[],
  timeseries: [] as any[],
  budgetsByVendedor: [] as any[],
  budgetTotals: {
    orcamentos: { count: 0, valor: 0 },
    convertidos: { count: 0, valor: 0 },
  },
};

describe("renderTeamProductivityReport — orçamentos por vendedor", () => {
  it("renderiza com orçamentos por vendedor MESMO sem produtividade", async () => {
    const pdf = await renderTeamProductivityReport({
      ...baseData,
      budgetsByVendedor: [
        {
          id: "admin",
          name: "Dono",
          email: "d@x.com",
          isOwner: true,
          orcamentos: { count: 2, valor: 200 },
          convertidos: { count: 1, valor: 100 },
        },
        {
          id: "u1",
          name: "Ana",
          email: "a@x.com",
          isOwner: false,
          orcamentos: { count: 5, valor: 1234.56 },
          convertidos: { count: 3, valor: 800 },
        },
      ],
      budgetTotals: {
        orcamentos: { count: 7, valor: 1434.56 },
        convertidos: { count: 4, valor: 900 },
      },
    });
    expect(pdf).toBeInstanceOf(Buffer);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("sem produtividade E sem orçamentos → PDF 'sem atividade' válido", async () => {
    const pdf = await renderTeamProductivityReport(baseData);
    expect(isPdf(pdf)).toBe(true);
  });

  it("produtividade + orçamentos juntos rendeiriza sem erro", async () => {
    const pdf = await renderTeamProductivityReport({
      ...baseData,
      totals: { produtos: 10, anuncios: { total: 6, ml: 4, shopee: 2, outro: 0 } },
      byCollaborator: [
        {
          id: "u1",
          name: "Ana",
          email: "a@x.com",
          produtos: 10,
          anuncios: { total: 6, ml: 4, shopee: 2, outro: 0 },
          lastActivityAt: "2026-06-10T00:00:00.000Z",
        },
      ],
      timeseries: [{ date: "2026-06-10", produtos: 10, ml: 4, shopee: 2 }],
      budgetsByVendedor: [
        {
          id: "u1",
          name: "Ana",
          email: "a@x.com",
          isOwner: false,
          orcamentos: { count: 5, valor: 1234.56 },
          convertidos: { count: 3, valor: 800 },
        },
      ],
      budgetTotals: {
        orcamentos: { count: 5, valor: 1234.56 },
        convertidos: { count: 3, valor: 800 },
      },
    });
    expect(isPdf(pdf)).toBe(true);
  });
});

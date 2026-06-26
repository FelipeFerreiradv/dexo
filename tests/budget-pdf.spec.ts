import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  renderBudgetReport,
  type BudgetReportData,
  type BudgetReportItem,
} from "../app/reports/budget-report";

// Fase E — PDF do orçamento (react-pdf). Não comparamos bytes (o cabeçalho
// embute a data de emissão); validamos que o PDF é gerado sem erro e pagina os
// itens (1, 5, 20 e 40 — cadastrados e manuais), incl. cenários sem empresa
// configurada e sem validade.

function makeItems(n: number): BudgetReportItem[] {
  return Array.from({ length: n }, (_, i) => {
    const quantity = (i % 3) + 1;
    const unitPrice = 10 + i;
    return {
      label: `Peça número ${i} com nome longo típico de autopeça`,
      sku: `SKU${i}`,
      quantity,
      unitPrice,
      subtotal: quantity * unitPrice,
    };
  });
}

function makeData(overrides: Partial<BudgetReportData> = {}): BudgetReportData {
  return {
    company: {
      razaoSocial: "Auto Peças Dexo LTDA",
      nomeFantasia: "Dexo Peças",
      cnpj: "12345678000190",
      inscricaoEstadual: "1234567",
      addressLine: "Rua das Peças, 100, Centro, São Paulo/SP, CEP 01000-000",
    },
    companyName: "Dexo Peças",
    budgetNumber: "#ABCD1234",
    statusLabel: "ABERTO",
    client: { name: "Cliente Teste", doc: "12345678901", email: "c@t.com" },
    items: makeItems(1),
    total: 100,
    validUntilLabel: "03/07/2026",
    notes: "Válido por 7 dias. Não inclui frete.",
    vendedor: "Maria Vendedora",
    generatedAtLabel: "26/06/2026 18:00",
    ...overrides,
  };
}

function isPdf(b: Buffer): boolean {
  return b.slice(0, 5).toString("latin1") === "%PDF-";
}
async function pageCount(b: Buffer): Promise<number> {
  const doc = await PDFDocument.load(b);
  return doc.getPageCount();
}

describe("renderBudgetReport — PDF do orçamento", () => {
  it("1 item: PDF válido em 1 página", async () => {
    const pdf = await renderBudgetReport(makeData({ items: makeItems(1) }));
    expect(pdf).toBeInstanceOf(Buffer);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
    expect(await pageCount(pdf)).toBe(1);
  });

  it("5 itens: PDF válido", async () => {
    const pdf = await renderBudgetReport(makeData({ items: makeItems(5) }));
    expect(isPdf(pdf)).toBe(true);
    expect(await pageCount(pdf)).toBeGreaterThanOrEqual(1);
  });

  it("20 itens: PDF válido", async () => {
    const pdf = await renderBudgetReport(makeData({ items: makeItems(20) }));
    expect(isPdf(pdf)).toBe(true);
  });

  it("40 itens: pagina em múltiplas páginas (nenhum item escondido)", async () => {
    const pdf = await renderBudgetReport(makeData({ items: makeItems(40) }));
    expect(isPdf(pdf)).toBe(true);
    expect(await pageCount(pdf)).toBeGreaterThan(1);
  });

  it("itens MANUAIS (sem sku) + sem empresa + sem validade não quebram", async () => {
    const pdf = await renderBudgetReport(
      makeData({
        company: null,
        validUntilLabel: null,
        notes: null,
        items: [
          { label: "Mão de obra avulsa", sku: null, quantity: 1, unitPrice: 80, subtotal: 80 },
          { label: "Filtro de óleo", sku: "SKU1", quantity: 2, unitPrice: 35, subtotal: 70 },
        ],
      }),
    );
    expect(isPdf(pdf)).toBe(true);
  });

  it("orçamento sem itens (valor único) gera PDF válido", async () => {
    const pdf = await renderBudgetReport(makeData({ items: [] }));
    expect(isPdf(pdf)).toBe(true);
  });
});

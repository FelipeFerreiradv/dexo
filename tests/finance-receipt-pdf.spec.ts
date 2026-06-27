import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ReceiptPdfService } from "../app/financeiro/generators/receipt-pdf.service";
import type { FinanceEntry } from "../app/interfaces/finance.interface";

// ──────────────────────────────────────────────────────────
// Cupom sem validade fiscal — a forma de pagamento entra como um bullet
// extra na seção PAGAMENTO, SOMENTE quando presente. Sem método o cupom é
// gerado pelo caminho atual (bullet ausente). Não é possível comparar bytes
// (o cabeçalho embute `new Date()`), então validamos que o PDF é gerado sem
// erro nos DOIS casos — exercitando o novo branch `if (entry.paymentMethod)`.
// O texto do rótulo é coberto pelo unit de paymentMethodLabel.
// ──────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<FinanceEntry> = {}): FinanceEntry {
  return {
    id: "r-1",
    userId: "u-1",
    customerId: "c-1",
    document: "NF 123",
    reason: "Venda de peças",
    debtDetails: null,
    totalAmount: 150,
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: 30,
    dueDate: new Date("2026-06-01"),
    status: "PENDENTE",
    paidAt: null,
    paymentMethod: null,
    createdAt: new Date("2026-05-01"),
    updatedAt: new Date("2026-05-01"),
    customer: { id: "c-1", name: "Cliente Teste", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "i1",
        productId: "p1",
        listingId: null,
        quantity: 1,
        unitPrice: 150,
        product: { id: "p1", sku: "SKU1", name: "Peça" },
      },
    ],
    ...overrides,
  };
}

function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-";
}

describe("ReceiptPdfService — forma de pagamento no cupom", () => {
  it("REGRESSÃO: gera PDF válido SEM método (caminho atual, bullet ausente)", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({ paymentMethod: null }),
      null,
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(isPdf(bytes)).toBe(true);
  });

  it("gera PDF válido COM método (exercita o novo bullet de pagamento)", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({ paymentMethod: "PIX" }),
      null,
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(isPdf(bytes)).toBe(true);
  });

  it("método desconhecido não quebra a geração (paymentMethodLabel tolerante)", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({ paymentMethod: "LEGADO_XYZ" }),
      null,
    );
    expect(isPdf(bytes)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// Fase C — paginação: o cupom traz TODOS os itens (sem o corte de 14 linhas),
// quebrando em múltiplas páginas A4 quando necessário. Itens manuais (sem
// product) renderizam pela description.
// ──────────────────────────────────────────────────────────

function makeItems(n: number): FinanceEntry["items"] {
  return Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    productId: `p${i}`,
    listingId: null,
    quantity: (i % 3) + 1,
    unitPrice: 10 + i,
    product: {
      id: `p${i}`,
      sku: `SKU${i}`,
      name: `Peça número ${i} com nome longo típico de autopeça`,
    },
  }));
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

describe("ReceiptPdfService — paginação (todos os itens)", () => {
  it("1 item: 1 página", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({ items: makeItems(1) }),
      null,
    );
    expect(isPdf(bytes)).toBe(true);
    expect(await pageCount(bytes)).toBe(1);
  });

  it("5 itens: ainda 1 página", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({ items: makeItems(5) }),
      null,
    );
    expect(await pageCount(bytes)).toBe(1);
  });

  it("20 itens: pagina em múltiplas páginas (nenhum item escondido)", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({ items: makeItems(20) }),
      null,
    );
    expect(isPdf(bytes)).toBe(true);
    expect(await pageCount(bytes)).toBeGreaterThan(1);
  });

  it("itens MANUAIS (sem product) renderizam pela description, misturados com cadastrados", async () => {
    const bytes = await new ReceiptPdfService().generate(
      makeEntry({
        items: [
          {
            id: "m1",
            productId: null,
            description: "Mão de obra avulsa",
            listingId: null,
            quantity: 1,
            unitPrice: 80,
            product: null,
          },
          {
            id: "p1",
            productId: "p1",
            listingId: null,
            quantity: 2,
            unitPrice: 35,
            product: { id: "p1", sku: "SKU1", name: "Filtro de óleo" },
          },
        ],
      }),
      null,
    );
    expect(isPdf(bytes)).toBe(true);
    expect(await pageCount(bytes)).toBe(1);
  });
});

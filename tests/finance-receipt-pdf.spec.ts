import { describe, it, expect } from "vitest";
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

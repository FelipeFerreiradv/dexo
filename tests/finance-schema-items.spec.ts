import { describe, it, expect } from "vitest";
import { financeEntrySchema } from "@/app/financeiro/lib/finance-schema";

// ──────────────────────────────────────────────────────────
// Fase B — validação zod dos itens: CADASTRADO (productId) vs MANUAL
// (description). O superRefine exige pelo menos um identificador por item.
// scrapId é opcional em ambos. Fluxo sem items permanece válido (compat).
// ──────────────────────────────────────────────────────────

const base = {
  customerId: "c-1",
  totalAmount: 100,
  installments: 1,
  dueDate: "2026-06-01",
};

describe("financeEntrySchema — itens cadastrados vs manuais", () => {
  it("aceita item CADASTRADO (productId, sem description)", () => {
    const r = financeEntrySchema.safeParse({
      ...base,
      items: [{ productId: "p-1", quantity: 1, unitPrice: 50 }],
    });
    expect(r.success).toBe(true);
  });

  it("aceita item MANUAL (description, sem productId)", () => {
    const r = financeEntrySchema.safeParse({
      ...base,
      items: [{ description: "Peça avulsa", quantity: 2, unitPrice: 10 }],
    });
    expect(r.success).toBe(true);
  });

  it("aceita venda MISTA com scrapId opcional", () => {
    const r = financeEntrySchema.safeParse({
      ...base,
      items: [
        { productId: "p-1", quantity: 1, unitPrice: 50, scrapId: "s-1" },
        { description: "Mão de obra", quantity: 1, unitPrice: 30 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejeita item sem productId E sem description", () => {
    const r = financeEntrySchema.safeParse({
      ...base,
      items: [{ quantity: 1, unitPrice: 50 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejeita description só com espaços (sem productId)", () => {
    const r = financeEntrySchema.safeParse({
      ...base,
      items: [{ description: "   ", quantity: 1, unitPrice: 50 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejeita quantity zero", () => {
    const r = financeEntrySchema.safeParse({
      ...base,
      items: [{ description: "Item", quantity: 0, unitPrice: 50 }],
    });
    expect(r.success).toBe(false);
  });

  it("preserva o fluxo SEM items (compat — zero regressão)", () => {
    const r = financeEntrySchema.safeParse({ ...base });
    expect(r.success).toBe(true);
  });
});

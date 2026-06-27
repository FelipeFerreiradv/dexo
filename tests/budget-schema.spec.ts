import { describe, it, expect } from "vitest";
import { budgetSchema } from "@/app/financeiro/lib/budget-schema";

// Fase C — validação zod do Orçamento. Reaproveita a forma de itens e de
// cliente do balcão; NÃO exige encargos/parcelas/dueDate. Campos próprios:
// notes e validUntil (ambos opcionais).

const base = {
  customerId: "c-1",
  totalAmount: 100,
};

describe("budgetSchema — cliente + itens", () => {
  it("aceita orçamento simples com cliente existente (sem itens)", () => {
    const r = budgetSchema.safeParse({ ...base });
    expect(r.success).toBe(true);
  });

  it("aceita item CADASTRADO (productId)", () => {
    const r = budgetSchema.safeParse({
      ...base,
      items: [{ productId: "p-1", quantity: 1, unitPrice: 50 }],
    });
    expect(r.success).toBe(true);
  });

  it("aceita item MANUAL (description)", () => {
    const r = budgetSchema.safeParse({
      ...base,
      items: [{ description: "Peça avulsa", quantity: 2, unitPrice: 10 }],
    });
    expect(r.success).toBe(true);
  });

  it("aceita orçamento MISTO + scrapId + notes + validUntil", () => {
    const r = budgetSchema.safeParse({
      ...base,
      notes: "Válido por 7 dias; não inclui frete.",
      validUntil: "2026-07-03",
      items: [
        { productId: "p-1", quantity: 1, unitPrice: 50, scrapId: "s-1" },
        { description: "Mão de obra", quantity: 1, unitPrice: 30 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejeita item sem productId E sem description", () => {
    const r = budgetSchema.safeParse({
      ...base,
      items: [{ quantity: 1, unitPrice: 50 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejeita quantity zero", () => {
    const r = budgetSchema.safeParse({
      ...base,
      items: [{ description: "Item", quantity: 0, unitPrice: 50 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejeita totalAmount não-positivo", () => {
    const r = budgetSchema.safeParse({ ...base, totalAmount: 0 });
    expect(r.success).toBe(false);
  });

  it("modo cadastro rápido exige nome", () => {
    const ok = budgetSchema.safeParse({
      totalAmount: 100,
      quickCreateCustomer: true,
      newCustomerName: "Fulano",
    });
    expect(ok.success).toBe(true);

    const bad = budgetSchema.safeParse({
      totalAmount: 100,
      quickCreateCustomer: true,
      newCustomerName: "",
    });
    expect(bad.success).toBe(false);
  });

  it("cliente existente é obrigatório quando NÃO é cadastro rápido", () => {
    const r = budgetSchema.safeParse({ totalAmount: 100, customerId: "" });
    expect(r.success).toBe(false);
  });
});

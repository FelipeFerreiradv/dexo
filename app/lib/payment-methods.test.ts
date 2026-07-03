import { describe, it, expect } from "vitest";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_CODES,
  PAYMENT_METHOD_LABELS,
  paymentMethodLabel,
  paymentMethodsForKind,
} from "./payment-methods";

describe("payment-methods (fonte única)", () => {
  it("expõe os códigos estáveis esperados (6 base + FIADO)", () => {
    expect(PAYMENT_METHOD_CODES).toEqual([
      "PIX",
      "CREDITO",
      "DEBITO",
      "BOLETO",
      "DINHEIRO",
      "TRANSFERENCIA",
      "FIADO",
    ]);
  });

  it("labels batem com os códigos", () => {
    expect(PAYMENT_METHOD_LABELS.PIX).toBe("PIX");
    expect(PAYMENT_METHOD_LABELS.CREDITO).toBe("Cartão de Crédito");
    expect(PAYMENT_METHOD_LABELS.DEBITO).toBe("Cartão de Débito");
    expect(PAYMENT_METHOD_LABELS.BOLETO).toBe("Boleto");
    expect(PAYMENT_METHOD_LABELS.DINHEIRO).toBe("Dinheiro");
    expect(PAYMENT_METHOD_LABELS.TRANSFERENCIA).toBe("Transferência / TED");
    expect(PAYMENT_METHOD_LABELS.FIADO).toBe("Fiado (a receber)");
  });

  it("paymentMethodLabel resolve código conhecido", () => {
    expect(paymentMethodLabel("DEBITO")).toBe("Cartão de Débito");
  });

  it("paymentMethodLabel tolera null/undefined/'' => '—' (nunca quebra a UI)", () => {
    expect(paymentMethodLabel(null)).toBe("—");
    expect(paymentMethodLabel(undefined)).toBe("—");
    expect(paymentMethodLabel("")).toBe("—");
  });

  it("paymentMethodLabel devolve o próprio código quando desconhecido", () => {
    expect(paymentMethodLabel("XYZ")).toBe("XYZ");
  });

  it("PAYMENT_METHODS é a fonte única (códigos == chaves dos labels)", () => {
    expect(PAYMENT_METHODS.map((m) => m.code).sort()).toEqual(
      Object.keys(PAYMENT_METHOD_LABELS).sort(),
    );
  });

  describe("paymentMethodsForKind (gate por aba)", () => {
    it("receivable inclui FIADO (venda a prazo)", () => {
      const codes = paymentMethodsForKind("receivable").map((m) => m.code);
      expect(codes).toContain("FIADO");
      // Continua ofertando todos os métodos base.
      expect(codes).toEqual([
        "PIX",
        "CREDITO",
        "DEBITO",
        "BOLETO",
        "DINHEIRO",
        "TRANSFERENCIA",
        "FIADO",
      ]);
    });

    it("payable NUNCA inclui FIADO, mas mantém os 6 métodos base intactos", () => {
      const codes = paymentMethodsForKind("payable").map((m) => m.code);
      expect(codes).not.toContain("FIADO");
      expect(codes).toEqual([
        "PIX",
        "CREDITO",
        "DEBITO",
        "BOLETO",
        "DINHEIRO",
        "TRANSFERENCIA",
      ]);
    });
  });
});

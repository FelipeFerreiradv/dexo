import { describe, it, expect } from "vitest";
import { computeMaxNumericSku } from "../product.repository";

describe("computeMaxNumericSku", () => {
  it("retorna 0 para lista vazia", () => {
    expect(computeMaxNumericSku([])).toBe(0);
  });

  it("retorna o maior SKU em uma lista de numéricos puros", () => {
    expect(computeMaxNumericSku(["001", "005", "123"])).toBe(123);
  });

  it("aceita SKUs legados no formato PROD-XXX junto com numéricos", () => {
    expect(computeMaxNumericSku(["001", "PROD-050", "099"])).toBe(99);
  });

  it("caso Leonardo: ignora SKUs longos vindos de importação e retorna o máximo da janela sequencial", () => {
    expect(
      computeMaxNumericSku([
        "32762",
        "700210067",
        "12345678",
        "000005",
      ]),
    ).toBe(32762);
  });

  it("retorna 0 quando todos os SKUs são longos demais (só códigos externos)", () => {
    expect(computeMaxNumericSku(["700210067", "123456789"])).toBe(0);
  });

  it("ignora SKUs não-numéricos e considera apenas os válidos da lista", () => {
    expect(computeMaxNumericSku(["ABC-123", "XYZ", "45"])).toBe(45);
  });

  it("limite exato: aceita 6 dígitos (999999) e descarta 7 dígitos (1000000)", () => {
    expect(computeMaxNumericSku(["999999", "1000000"])).toBe(999999);
  });

  it("tolera null, undefined e strings vazias na lista sem quebrar", () => {
    expect(
      computeMaxNumericSku([null, undefined, "", "42", null, "100"]),
    ).toBe(100);
  });
});

import { describe, it, expect } from "vitest";

import { applyNcmPadrao } from "../../app/notas-fiscais/lib/ncm-padrao";

// Matriz do autopreenchimento: NUNCA sobrescreve NCM preenchido; padrão só
// entra quando é um NCM válido de 8 dígitos.

describe("applyNcmPadrao", () => {
  it("NCM preenchido vence SEMPRE (nunca sobrescreve)", () => {
    expect(applyNcmPadrao("40161010", "87089990")).toBe("40161010");
    expect(applyNcmPadrao(" 40161010 ", "87089990")).toBe("40161010");
  });

  it("NCM vazio + padrão válido → usa o padrão", () => {
    expect(applyNcmPadrao("", "87089990")).toBe("87089990");
    expect(applyNcmPadrao(null, "8708.99.90")).toBe("87089990");
    expect(applyNcmPadrao(undefined, "87089990")).toBe("87089990");
  });

  it("NCM vazio + padrão ausente/inválido → continua vazio (validação aponta)", () => {
    expect(applyNcmPadrao("", null)).toBe("");
    expect(applyNcmPadrao("", undefined)).toBe("");
    expect(applyNcmPadrao("", "")).toBe("");
    expect(applyNcmPadrao("", "1234")).toBe("");
    expect(applyNcmPadrao("", "123456789")).toBe("");
  });
});

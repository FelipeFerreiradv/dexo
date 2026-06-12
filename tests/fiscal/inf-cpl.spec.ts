import { describe, it, expect } from "vitest";
import {
  composeInfCpl,
  sanitizeFreeText,
  INF_CPL_MAX_LENGTH,
} from "../../app/fiscal/domain/inf-cpl";

describe("composeInfCpl", () => {
  it("vazio quando nada preenchido", () => {
    expect(composeInfCpl({})).toBe("");
    expect(
      composeInfCpl({ informacoesComplementares: null, numeroPedido: null }),
    ).toBe("");
    expect(composeInfCpl({ informacoesComplementares: "   " })).toBe("");
  });

  it("apenas pedido: 'Pedido: N' (comportamento atual)", () => {
    expect(composeInfCpl({ numeroPedido: "PED-001" })).toBe("Pedido: PED-001");
  });

  it("apenas observacao", () => {
    expect(composeInfCpl({ informacoesComplementares: "Obs livre" })).toBe(
      "Obs livre",
    );
  });

  it("ordem: observacao primeiro, depois 'Pedido: N', separador ' | '", () => {
    expect(
      composeInfCpl({ informacoesComplementares: "obs", numeroPedido: "9" }),
    ).toBe("obs | Pedido: 9");
  });

  it("trunca em INF_CPL_MAX_LENGTH", () => {
    const out = composeInfCpl({
      informacoesComplementares: "x".repeat(9000),
    });
    expect(out.length).toBe(INF_CPL_MAX_LENGTH);
  });

  it("obs longa + pedido: o Pedido sobrevive inteiro, a obs cede espaco", () => {
    const out = composeInfCpl({
      informacoesComplementares: "x".repeat(4998),
      numeroPedido: "PED-12345",
    });
    expect(out.length).toBeLessThanOrEqual(INF_CPL_MAX_LENGTH);
    expect(out.endsWith(" | Pedido: PED-12345")).toBe(true);
  });

  it("soma abaixo do limite: nada e truncado", () => {
    const out = composeInfCpl({
      informacoesComplementares: "obs curta",
      numeroPedido: "PED-1",
    });
    expect(out).toBe("obs curta | Pedido: PED-1");
  });
});

describe("sanitizeFreeText", () => {
  it("normaliza CRLF/CR para LF e faz trim", () => {
    expect(sanitizeFreeText("  a\r\nb\rc ")).toBe("a\nb\nc");
  });

  it("remove caracteres de controle, mantendo \\n e \\t", () => {
    const dirty =
      "a" +
      String.fromCharCode(0) +
      "b" +
      String.fromCharCode(7) +
      "\tc\nd" +
      String.fromCharCode(127);
    expect(sanitizeFreeText(dirty)).toBe("ab\tc\nd");
  });

  it("null/undefined/vazio viram string vazia", () => {
    expect(sanitizeFreeText(null)).toBe("");
    expect(sanitizeFreeText(undefined)).toBe("");
    expect(sanitizeFreeText("")).toBe("");
  });
});

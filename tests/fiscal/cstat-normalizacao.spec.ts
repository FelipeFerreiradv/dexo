import { describe, it, expect } from "vitest";
import {
  normalizarCStat,
  codigoProvedorNaoNumerico,
} from "../../app/fiscal/numeracao/cstat";

// Fronteira do cStat: o Focus devolve status_sefaz como string ("974") e,
// no 422, um codigo textual ("erro_validacao_schema"). A coluna e Int?.

describe("normalizarCStat", () => {
  it.each([
    [974, 974],
    ["974", 974],
    [" 974 ", 974],
    ["100", 100],
    [225, 225],
    [0, 0],
    ["0", 0],
  ])("%j → %j", (entrada, esperado) => {
    expect(normalizarCStat(entrada)).toBe(esperado);
  });

  it.each([
    [null],
    [undefined],
    ["erro_validacao_schema"],
    ["permissao_negada"],
    ["12345"],
    [""],
    ["   "],
    ["97 4"],
    ["974a"],
    ["-974"],
    [974.5],
    [Number.NaN],
    [-1],
    [10000],
    [{}],
    [true],
  ])("%j → null (nunca inventa código)", (entrada) => {
    expect(normalizarCStat(entrada)).toBeNull();
  });

  it("resultado é sempre inteiro ou null (compatível com a coluna Int?)", () => {
    for (const v of [974, "974", null, undefined, "erro_validacao_schema"]) {
      const r = normalizarCStat(v);
      expect(r === null || Number.isInteger(r)).toBe(true);
    }
  });
});

describe("codigoProvedorNaoNumerico", () => {
  it("preserva código textual do provedor", () => {
    expect(codigoProvedorNaoNumerico("erro_validacao_schema")).toBe(
      "erro_validacao_schema",
    );
  });

  it("não duplica o que já é cStat numérico", () => {
    expect(codigoProvedorNaoNumerico("974")).toBeNull();
    expect(codigoProvedorNaoNumerico(974)).toBeNull();
  });

  it("ausente → null; texto longo é truncado em 64", () => {
    expect(codigoProvedorNaoNumerico(null)).toBeNull();
    expect(codigoProvedorNaoNumerico(undefined)).toBeNull();
    expect(codigoProvedorNaoNumerico("x".repeat(100))).toHaveLength(64);
  });
});

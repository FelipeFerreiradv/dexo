import { describe, it, expect } from "vitest";
import {
  normalizeText,
  tokenize,
  matchesTokens,
  scoreMatch,
} from "../app/localizacoes/lib/search-utils";

describe("normalizeText", () => {
  it("remove acentos/diacríticos", () => {
    expect(normalizeText("Armazém")).toBe("armazem");
    expect(normalizeText("Galpão")).toBe("galpao");
    expect(normalizeText("São João")).toBe("sao joao");
  });

  it("baixa a caixa", () => {
    expect(normalizeText("PRAT-02")).toBe("prat-02");
  });

  it("apara pontas e colapsa espaços internos", () => {
    expect(normalizeText("  Galpão   Norte ")).toBe("galpao norte");
  });

  it("trata null/undefined/vazio", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText("   ")).toBe("");
  });
});

describe("tokenize", () => {
  it("quebra em tokens normalizados", () => {
    expect(tokenize("Galpão 02 Norte")).toEqual(["galpao", "02", "norte"]);
  });
  it("query vazia/só-espaço → []", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe("matchesTokens", () => {
  const fields = {
    code: "PRAT-02",
    description: "Prateleira do Armazém Norte",
    fullPath: "GAL-01 / PRAT-02",
  };

  it("tokens vazios → aceita tudo (sem filtro)", () => {
    expect(matchesTokens([], fields)).toBe(true);
  });

  it("case-insensitive + substring parcial no code", () => {
    expect(matchesTokens(tokenize("prat"), fields)).toBe(true);
    expect(matchesTokens(tokenize("PRAT-0"), fields)).toBe(true);
  });

  it("acento ausente na query encontra texto acentuado", () => {
    expect(matchesTokens(tokenize("armazem"), fields)).toBe(true);
  });

  it("múltiplos termos em qualquer ordem (AND entre tokens, OR entre campos)", () => {
    // "norte" está na description, "gal-01" no fullPath, "prat" no code
    expect(matchesTokens(tokenize("norte prat"), fields)).toBe(true);
    expect(matchesTokens(tokenize("gal-01 norte"), fields)).toBe(true);
    expect(matchesTokens(tokenize("prat gal-01 norte"), fields)).toBe(true);
  });

  it("falha quando algum token não casa em nenhum campo", () => {
    expect(matchesTokens(tokenize("inexistente"), fields)).toBe(false);
    expect(matchesTokens(tokenize("prat xyz"), fields)).toBe(false);
  });

  it("description ausente não quebra", () => {
    expect(matchesTokens(tokenize("g1"), { code: "G1", fullPath: "G1" })).toBe(
      true,
    );
  });
});

describe("scoreMatch (desempate, menor = melhor)", () => {
  it("prefixo exato do code é o mais relevante", () => {
    const prefix = scoreMatch(tokenize("prat"), { code: "PRAT-02" });
    const onlyDesc = scoreMatch(tokenize("norte"), {
      code: "PRAT-02",
      description: "Norte",
      fullPath: "GAL / PRAT-02",
    });
    expect(prefix).toBeLessThan(onlyDesc);
  });
});

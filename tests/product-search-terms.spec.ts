import { describe, it, expect } from "vitest";
import {
  normalizeTerm,
  tokenizeSearch,
  reduceVariants,
  MAX_TOKEN_GROUPS,
} from "../app/repositories/product-search-terms";

describe("normalizeTerm", () => {
  it("remove acentos e baixa caixa", () => {
    expect(normalizeTerm("Fechadura Traseira ESQUERDA")).toBe(
      "fechadura traseira esquerda",
    );
    expect(normalizeTerm("suspensão")).toBe("suspensao");
    expect(normalizeTerm("  Pálio  ")).toBe("palio");
  });
});

describe("tokenizeSearch", () => {
  it("expande abreviações e mantém AND por termo no caso problema", () => {
    const groups = tokenizeSearch("fecha tras esq palio");

    // 4 grupos: um por termo (nenhuma stopword aqui)
    expect(groups).toHaveLength(4);

    // cada grupo inclui o token original + as formas reais do catálogo
    expect(groups[0]).toContain("fecha");
    expect(groups[0]).toContain("fechadura");
    expect(groups[1]).toEqual(expect.arrayContaining(["tras", "traseira", "traseiro"]));
    expect(groups[2]).toEqual(expect.arrayContaining(["esq", "esquerda", "esquerdo"]));
    expect(groups[3]).toEqual(["palio"]);
  });

  it("busca simples de modelo permanece 1 grupo", () => {
    expect(tokenizeSearch("palio")).toEqual([["palio"]]);
  });

  it("remove stopwords (de/da/do) e termos com menos de 2 chars", () => {
    const groups = tokenizeSearch("fechadura da porta");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain("fechadura");
    expect(groups[1]).toContain("porta");
  });

  it("expande direita/esquerda em 'retrovisor gol direito'", () => {
    const groups = tokenizeSearch("retrovisor gol direito");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toContain("retrovisor");
    expect(groups[1]).toContain("gol");
    expect(groups[2]).toEqual(expect.arrayContaining(["direito", "direita"]));
  });

  it("busca vazia ou só de stopwords retorna lista vazia", () => {
    expect(tokenizeSearch("")).toEqual([]);
    expect(tokenizeSearch("   ")).toEqual([]);
    expect(tokenizeSearch("de da do")).toEqual([]);
  });

  it("preserva tokens numéricos (ano / número de peça)", () => {
    const groups = tokenizeSearch("palio 2010");
    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual(["2010"]);
  });

  it("limita o número de grupos (proteção contra colagens enormes)", () => {
    const huge = Array.from({ length: 40 }, (_, i) => `termo${i}`).join(" ");
    expect(tokenizeSearch(huge).length).toBe(MAX_TOKEN_GROUPS);
  });
});

describe("reduceVariants", () => {
  it("colapsa variantes subsumidas por uma substring mais curta", () => {
    expect(reduceVariants(["tras", "traseira", "traseiro"])).toEqual(["tras"]);
    expect(reduceVariants(["esq", "esquerda", "esquerdo"])).toEqual(["esq"]);
    expect(reduceVariants(["fecha", "fechadura"])).toEqual(["fecha"]);
  });

  it("mantém variantes não-subsumidas (par de gênero sem stem comum no grupo)", () => {
    expect(reduceVariants(["dianteira", "dianteiro"])).toEqual([
      "dianteira",
      "dianteiro",
    ]);
  });

  it("nunca esvazia o grupo", () => {
    expect(reduceVariants(["palio"])).toEqual(["palio"]);
    expect(reduceVariants([]).length).toBe(0);
  });
});

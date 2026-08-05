import { describe, it, expect } from "vitest";

import {
  PRODUCT_SORTS,
  parseProductSort,
} from "../app/interfaces/product.interface";

/**
 * Ordenação da lista de Produtos.
 *
 * O que este spec protege é o CONTRATO: a allowlist do parâmetro e a garantia
 * de que ausência de `sort` significa "comportamento histórico". A ordenação em
 * si é SQL (`productOrderBySql`), e foi verificada contra produção — ver o
 * comentário do helper em `app/repositories/product.repository.ts`, que traz os
 * números do EXPLAIN ANALYZE e o resultado ponta a ponta.
 */

describe("parseProductSort — allowlist do parâmetro", () => {
  it("aceita exatamente os valores conhecidos", () => {
    for (const s of PRODUCT_SORTS) {
      expect(parseProductSort(s)).toBe(s);
    }
  });

  it("recusa qualquer coisa fora da lista", () => {
    for (const lixo of [
      "createdAt",
      "sku",
      "SKU_ASC",
      "price_asc",
      "",
      " ",
      "1",
    ]) {
      expect(parseProductSort(lixo)).toBeUndefined();
    }
  });

  it("recusa ausência e tipos errados, virando o padrão do repositório", () => {
    expect(parseProductSort(undefined)).toBeUndefined();
    expect(parseProductSort(null)).toBeUndefined();
    expect(parseProductSort(42)).toBeUndefined();
    expect(parseProductSort({})).toBeUndefined();
    expect(parseProductSort(["sku_asc"])).toBeUndefined();
  });

  it("não é vetor de SQL injection: entrada maliciosa nunca vira sort", () => {
    // O valor só chega ao ORDER BY depois de passar por aqui; qualquer coisa
    // que não seja um dos literais conhecidos vira `undefined`.
    expect(parseProductSort('sku_asc; DROP TABLE "Product"')).toBeUndefined();
    expect(parseProductSort("1; SELECT pg_sleep(10)--")).toBeUndefined();
  });

  it("a lista de opções é fechada e tem o padrão em primeiro", () => {
    expect(PRODUCT_SORTS[0]).toBe("recentes");
    expect([...PRODUCT_SORTS]).toEqual(["recentes", "sku_asc", "sku_desc"]);
  });
});

/**
 * Ordenação natural de SKU, replicada em JS a partir da mesma regra do SQL
 * (`NULLIF(regexp_replace(sku, '\D', '', 'g'), '')::numeric`, texto como
 * desempate e SKU sem dígito por último).
 *
 * Serve para travar a INTENÇÃO: 83% dos 220 mil SKUs em produção são só
 * dígitos, e alfabeticamente "1000" viria antes de "999".
 */
function ordenarComoOSql(skus: string[], dir: "asc" | "desc"): string[] {
  const chave = (sku: string) => {
    const digitos = sku.replace(/\D/g, "");
    return digitos === "" ? null : Number(digitos);
  };
  const sinal = dir === "asc" ? 1 : -1;
  return [...skus].sort((a, b) => {
    const ka = chave(a);
    const kb = chave(b);
    // NULLS LAST nos dois sentidos, como o SQL faz.
    if (ka === null && kb === null) return a < b ? -sinal : a > b ? sinal : 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    if (ka !== kb) return (ka - kb) * sinal;
    return a < b ? -sinal : a > b ? sinal : 0;
  });
}

describe("ordem natural de SKU", () => {
  it("põe 9 antes de 10 (o que a ordem alfabética erra)", () => {
    const skus = ["10", "9", "100", "1", "20"];
    expect(ordenarComoOSql(skus, "asc")).toEqual(["1", "9", "10", "20", "100"]);
    // Prova de que a alfabética estaria errada:
    expect([...skus].sort()).toEqual(["1", "10", "100", "20", "9"]);
  });

  it("acerta SKU alfanumérico: P1, P2, ... P10", () => {
    const skus = ["ESC P10", "ESC P1", "ESC P2"];
    expect(ordenarComoOSql(skus, "asc")).toEqual([
      "ESC P1",
      "ESC P2",
      "ESC P10",
    ]);
  });

  it("SKU sem dígito nenhum vai para o fim (NULLS LAST)", () => {
    expect(ordenarComoOSql(["ABC", "2", "ZZZ", "1"], "asc")).toEqual([
      "1",
      "2",
      "ABC",
      "ZZZ",
    ]);
  });

  it("empate numérico é desempatado pelo texto", () => {
    expect(ordenarComoOSql(["B1", "A1", "1"], "asc")).toEqual([
      "1",
      "A1",
      "B1",
    ]);
  });

  it("decrescente é o espelho, e o sem-dígito continua por último", () => {
    expect(ordenarComoOSql(["1", "9", "10", "ABC"], "desc")).toEqual([
      "10",
      "9",
      "1",
      "ABC",
    ]);
  });

  it("aguenta SKU gigante sem estourar (produção tem um de 43 dígitos)", () => {
    const gigante = "1".repeat(43);
    const out = ordenarComoOSql([gigante, "5"], "asc");
    expect(out[0]).toBe("5");
    expect(out[1]).toBe(gigante);
  });
});

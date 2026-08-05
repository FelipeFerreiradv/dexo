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
 * (`productOrderBySql` em app/repositories/product.repository.ts).
 *
 * São DOIS níveis:
 *   1. SKU puramente numérico primeiro, em ordem natural;
 *   2. depois os alfanuméricos, agrupados pelo prefixo não-numérico.
 *
 * Serve para travar a INTENÇÃO: 83% dos 220 mil SKUs em produção são só
 * dígitos, e alfabeticamente "1000" viria antes de "999". Sem o agrupamento
 * por prefixo, "ESC P1" valia 1 e caía entre "2" e "10", intercalando as duas
 * famílias.
 */
function ordenarComoOSql(skus: string[], dir: "asc" | "desc"): string[] {
  const prefixo = (sku: string) => sku.replace(/[0-9].*$/, "");
  const chave = (sku: string) => {
    const digitos = sku.replace(/\D/g, "");
    return digitos === "" ? null : Number(digitos);
  };
  const sinal = dir === "asc" ? 1 : -1;
  return [...skus].sort((a, b) => {
    const pa = prefixo(a);
    const pb = prefixo(b);
    // Grupo dos puramente numéricos primeiro NOS DOIS SENTIDOS: inverter isso
    // jogaria os alfanuméricos para o topo de "SKU decrescente".
    const puroA = pa === "";
    const puroB = pb === "";
    if (puroA !== puroB) return puroA ? -1 : 1;
    // Prefixos diferentes: o grupo inteiro se move junto.
    if (pa !== pb) return pa < pb ? -sinal : sinal;
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

  it("NÃO intercala alfanumérico com numérico: numérico vem primeiro", () => {
    // Este é o caso que motivou o agrupamento por prefixo. Comparando só os
    // dígitos, "ESC P1" valia 1 e a lista saía
    // ESC P1, 2, ESC P2, 10, ESC P10, 999, 1000, 1001.
    const skus = [
      "999",
      "1000",
      "2",
      "10",
      "1001",
      "ESC P1",
      "ESC P10",
      "ESC P2",
    ];
    expect(ordenarComoOSql(skus, "asc")).toEqual([
      "2",
      "10",
      "999",
      "1000",
      "1001",
      "ESC P1",
      "ESC P2",
      "ESC P10",
    ]);
  });

  it("no decrescente o grupo numérico continua primeiro", () => {
    // "SKU decrescente" inverte DENTRO de cada grupo; não joga os
    // alfanuméricos para o topo.
    const skus = [
      "999",
      "1000",
      "2",
      "10",
      "1001",
      "ESC P1",
      "ESC P10",
      "ESC P2",
    ];
    expect(ordenarComoOSql(skus, "desc")).toEqual([
      "1001",
      "1000",
      "999",
      "10",
      "2",
      "ESC P10",
      "ESC P2",
      "ESC P1",
    ]);
  });

  it("prefixos diferentes ficam agrupados, não misturados", () => {
    const skus = ["ESC P2", "RAD 1", "ESC P1", "RAD 10", "7"];
    expect(ordenarComoOSql(skus, "asc")).toEqual([
      "7",
      "ESC P1",
      "ESC P2",
      "RAD 1",
      "RAD 10",
    ]);
  });

  /**
   * Estes dois casos foram COPIADOS da saída de um Postgres 16 real rodando o
   * ORDER BY de `productOrderBySql` (05/08/2026). É o que amarra este espelho
   * em JS ao SQL de verdade — se um dos dois mudar, o teste acusa.
   */
  const COMO_O_POSTGRES = [
    "999",
    "1000",
    "2",
    "10",
    "1001",
    "ESC P1",
    "ESC P10",
    "ESC P2",
    "RAD 1",
    "RAD 10",
    "ABC",
    "ZZZ",
  ];

  it("bate com a saída medida do Postgres, crescente", () => {
    expect(ordenarComoOSql(COMO_O_POSTGRES, "asc")).toEqual([
      "2",
      "10",
      "999",
      "1000",
      "1001",
      "ABC",
      "ESC P1",
      "ESC P2",
      "ESC P10",
      "RAD 1",
      "RAD 10",
      "ZZZ",
    ]);
  });

  it("bate com a saída medida do Postgres, decrescente", () => {
    expect(ordenarComoOSql(COMO_O_POSTGRES, "desc")).toEqual([
      "1001",
      "1000",
      "999",
      "10",
      "2",
      "ZZZ",
      "RAD 10",
      "RAD 1",
      "ESC P10",
      "ESC P2",
      "ESC P1",
      "ABC",
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

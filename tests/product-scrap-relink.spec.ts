// BLOCO J — trocar (ou remover) a sucata de uma peça já cadastrada.
//
// Duas coisas podiam dar errado em silêncio, e é o que este spec trava:
//
//  1. A SUCATA DE ORIGEM FICAR PARA TRÁS. Depois do UPDATE o produto já não
//     aponta para ela, então a entrada por PRODUTOS do reconciliador — que
//     resolve o lote a partir do produto — nunca a alcançaria. E `Scrap.status`
//     é coluna PERSISTIDA: o lote ficaria "Esgotado" para sempre depois de
//     perder a peça, exatamente o bug que a Fase 3 corrigiu do outro lado.
//
//  2. O AVISO MENTIR. Os contadores da sucata são derivados do vínculo, então
//     a troca REATRIBUI o que a peça já vendeu. Se o texto de confirmação
//     omitir ou exagerar, o operador confirma uma coisa e acontece outra.

import { describe, it, expect } from "vitest";

import {
  NO_SCRAP,
  describeRelinkImpact,
  isScrapRelinkEnabled,
  scrapSelectValueToId,
} from "../app/produtos/lib/scrap-relink";

describe("Flag de backend — kill-switch da troca", () => {
  it("ausente ⇒ desligado", () => {
    expect(isScrapRelinkEnabled({})).toBe(false);
  });

  it("só a string exata '1' liga", () => {
    expect(isScrapRelinkEnabled({ PRODUCT_SCRAP_RELINK_ENABLED: "true" })).toBe(
      false,
    );
    expect(isScrapRelinkEnabled({ PRODUCT_SCRAP_RELINK_ENABLED: "1" })).toBe(
      true,
    );
  });
});

describe("Sentinela do seletor", () => {
  it("'sem sucata' vira null, nunca a palavra literal", () => {
    // Radix Select não aceita value=""; se a sentinela vazasse para o backend,
    // ela viraria um id de sucata inexistente.
    expect(scrapSelectValueToId(NO_SCRAP)).toBeNull();
    expect(scrapSelectValueToId("")).toBeNull();
    expect(scrapSelectValueToId("scrap-1")).toBe("scrap-1");
  });
});

describe("describeRelinkImpact — o aviso tem de bater com o que acontece", () => {
  const nada = {
    marketplaceSales: 0,
    counterSales: 0,
    pinnedCounterSales: 0,
  };

  it("peça sem venda ⇒ nenhuma linha (99,3% dos casos)", () => {
    // Sem venda, a troca é trivial. Um aviso aqui só ensinaria o operador a
    // ignorar avisos.
    expect(describeRelinkImpact(nada)).toEqual([]);
  });

  it("venda de marketplace SEGUE a peça", () => {
    // OrderItem não tem coluna de sucata: não há snapshot que a segure.
    expect(describeRelinkImpact({ ...nada, marketplaceSales: 3 })).toEqual([
      "3 vendas de marketplace passam a contar na nova sucata.",
    ]);
  });

  it("venda de balcão que gravou o lote FICA onde está", () => {
    expect(
      describeRelinkImpact({
        ...nada,
        counterSales: 2,
        pinnedCounterSales: 2,
      }),
    ).toEqual([
      "2 vendas de balcão continuam na sucata atual — elas gravaram o lote no momento da venda.",
    ]);
  });

  it("balcão sem snapshot segue a peça; com snapshot fica — e o aviso separa as duas", () => {
    expect(
      describeRelinkImpact({
        marketplaceSales: 1,
        counterSales: 5,
        pinnedCounterSales: 3,
      }),
    ).toEqual([
      "1 venda de marketplace passa a contar na nova sucata.",
      "2 vendas de balcão passam a contar na nova sucata.",
      "3 vendas de balcão continuam na sucata atual — elas gravaram o lote no momento da venda.",
    ]);
  });

  it("concorda em número — singular e plural", () => {
    expect(describeRelinkImpact({ ...nada, marketplaceSales: 1 })).toEqual([
      "1 venda de marketplace passa a contar na nova sucata.",
    ]);
  });

  it("números incoerentes não produzem frase absurda", () => {
    // `pinned` maior que o total só pode ser bug de contagem; o aviso NÃO pode
    // virar "-2 vendas passam a contar".
    const linhas = describeRelinkImpact({
      marketplaceSales: 0,
      counterSales: 2,
      pinnedCounterSales: 7,
    });
    expect(linhas).toEqual([
      "2 vendas de balcão continuam na sucata atual — elas gravaram o lote no momento da venda.",
    ]);
    expect(linhas.join(" ")).not.toContain("-");
  });

  it("negativo é tratado como zero", () => {
    expect(
      describeRelinkImpact({
        marketplaceSales: -3,
        counterSales: -1,
        pinnedCounterSales: -1,
      }),
    ).toEqual([]);
  });
});

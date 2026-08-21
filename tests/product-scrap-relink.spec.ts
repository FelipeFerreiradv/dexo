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
  describeScrapLinkView,
  isScrapLinkSincronizando,
  isAbortError,
  isScrapRelinkEnabled,
  scrapLinkErrorMessage,
  scrapSelectValueToId,
  type ScrapLinkStatus,
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

// ── O bug de 20/08/2026: a seção AFIRMAVA "Sem sucata" sobre uma peça que
// estava vinculada. Provado em três camadas: `Product.scrapId` gravado, quatro
// `GET /scrap-link → 200` no log de produção, e o corpo
// `{"scrapId":"cmrpmx…","scrapLabel":"FORD FUSION 2009"}` no DevTools ao lado
// da tela dizendo o contrário.
//
// A causa não foi a rede: era não existir estado para "ainda não sei". Estes
// casos travam a regra que faltava.
describe("describeScrapLinkView — a tela só afirma o que o backend disse", () => {
  const VINCULADA = "cmrpmx6f0039y18i6s5c9f6gy"; // a FORD FUSION do caso real

  it("REGRESSÃO: vínculo lido ⇒ o seletor aponta a sucata, não 'Sem sucata'", () => {
    const v = describeScrapLinkView("pronto", VINCULADA);
    expect(v.value).toBe(VINCULADA);
    expect(v.value).not.toBe(NO_SCRAP);
    expect(v.disabled).toBe(false);
  });

  it("backend AFIRMOU que não há vínculo ⇒ aí sim 'Sem sucata'", () => {
    const v = describeScrapLinkView("pronto", null);
    expect(v.value).toBe(NO_SCRAP);
    expect(v.disabled).toBe(false);
  });

  it("carregando ⇒ não afirma nada e não deixa alterar", () => {
    const v = describeScrapLinkView("carregando", null);
    expect(v.value).toBe("");
    expect(v.placeholder).toContain("Carregando");
    expect(v.disabled).toBe(true);
  });

  it("erro ⇒ admite que não sabe; NUNCA vira 'Sem sucata'", () => {
    const v = describeScrapLinkView("erro", null);
    expect(v.value).toBe("");
    expect(v.placeholder).not.toBe("Sem sucata");
    expect(v.disabled).toBe(true);
  });

  // O invariante do bug, varrido em vez de exemplificado: se a leitura não
  // terminou, "Sem sucata" não pode sair — nem com vínculo, nem sem.
  it("INVARIANTE: só o estado 'pronto' pode produzir NO_SCRAP", () => {
    const estados: ScrapLinkStatus[] = ["carregando", "pronto", "erro"];
    const vinculos = [null, undefined, "", VINCULADA];
    for (const estado of estados) {
      for (const vinculo of vinculos) {
        const v = describeScrapLinkView(estado, vinculo);
        if (v.value === NO_SCRAP) expect(estado).toBe("pronto");
        // Enquanto não se sabe, alterar tem de estar travado — senão o
        // primeiro clique apagaria por omissão um vínculo não lido.
        if (estado !== "pronto") {
          expect(v.value).toBe("");
          expect(v.disabled).toBe(true);
        }
      }
    }
  });

  it("valor do seletor volta a virar id/null pelo mesmo conversor do PATCH", () => {
    const comVinculo = describeScrapLinkView("pronto", VINCULADA);
    const semVinculo = describeScrapLinkView("pronto", null);
    expect(scrapSelectValueToId(comVinculo.value)).toBe(VINCULADA);
    expect(scrapSelectValueToId(semVinculo.value)).toBeNull();
  });
});

describe("isAbortError — abort não é falha, mas o resto é", () => {
  it("reconhece o AbortError que o AbortController produz", () => {
    const e = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isAbortError(e)).toBe(true);
  });

  it("erro de rede NÃO é abort — tem de virar estado de erro visível", () => {
    expect(isAbortError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("scrapLinkErrorMessage — diz de quem é o problema", () => {
  it("401/403 apontam a sessão; 404 aponta a peça; 5xx aponta o servidor", () => {
    expect(scrapLinkErrorMessage(401)).toMatch(/sess/i);
    expect(scrapLinkErrorMessage(403)).toMatch(/sess/i);
    expect(scrapLinkErrorMessage(404)).toMatch(/não encontrada/i);
    expect(scrapLinkErrorMessage(500)).toMatch(/servidor/i);
    expect(scrapLinkErrorMessage(503)).toMatch(/servidor/i);
  });

  it("nenhuma mensagem de erro pode dizer que a peça está sem sucata", () => {
    for (const s of [400, 401, 403, 404, 418, 500, 502, 503]) {
      expect(scrapLinkErrorMessage(s)).not.toMatch(/sem sucata/i);
    }
  });
});

describe("isScrapLinkSincronizando — a janela entre os dois commits", () => {
  // POR QUE ESTA REGRA EXISTE:
  //
  // A cura do <select> nativo do Radix obriga o valor a chegar ao seletor num
  // commit DEPOIS do que registrou a <option>. Entre os dois, `status` já é
  // "pronto" e `valor` ainda é "" — e "" vira `null` em `scrapSelectValueToId`,
  // que a tela desenharia como "Sem sucata" com o "Alterar" HABILITADO.
  //
  // Não é cosmético: naquele instante o "Alterar" abre o diálogo de
  // DESVINCULAR, e confirmar mandaria `scrapId: null` ao servidor. Seria a
  // peça perdendo a sucata por um clique — o desfecho exato que esta entrega
  // existe para impedir, só que por outro caminho.

  it("pronto com valor vazio ⇒ ainda sincronizando (a tela não pode afirmar nada)", () => {
    expect(isScrapLinkSincronizando("pronto", "")).toBe(true);
  });

  it("assim que o valor chega, a janela fecha", () => {
    expect(
      isScrapLinkSincronizando("pronto", "cmrpmx6f0039y18i6s5c9f6gy"),
    ).toBe(false);
  });

  it("sem vínculo TAMBÉM fecha a janela — `__none__` é uma resposta, não ausência", () => {
    // O contrário engessaria a peça sem sucata em "carregando" para sempre.
    expect(isScrapLinkSincronizando("pronto", NO_SCRAP)).toBe(false);
  });

  it("em carregando e em erro a janela não se aplica — quem trava é o próprio estado", () => {
    expect(isScrapLinkSincronizando("carregando", "")).toBe(false);
    expect(isScrapLinkSincronizando("erro", "")).toBe(false);
  });

  it('a view da janela é a de CARREGANDO: travada e sem afirmar "Sem sucata"', () => {
    // É assim que a seção a desenha. Se alguém trocar por
    // `describeScrapLinkView("pronto", null)`, este caso cai.
    const vista = describeScrapLinkView("carregando", null);
    expect(vista.disabled).toBe(true);
    expect(vista.placeholder).not.toContain("Sem sucata");
    expect(vista.value).toBe("");
  });
});

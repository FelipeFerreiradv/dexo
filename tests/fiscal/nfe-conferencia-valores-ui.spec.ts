import { describe, expect, it } from "vitest";
import {
  TOLERANCIA_DIVERGENCIA,
  conferirValores,
  pagamentoSeraDescartado,
  somarPagamentos,
  type ConferenciaValores,
  type LinhaPagamento,
} from "../../app/notas-fiscais/lib/nfe-conferencia-valores";

// Quadro de conferencia do ultimo passo do wizard ("Finalizar").
//
// O defeito de origem (DLS AUTO PEÇAS, 24/09/2026): o quadro ambar
// "Divergência nos valores — ... Diferença: R$ 864,58" aparecia em TODA
// devolucao, porque devolucao nao tem pagamento. A cliente passou o dia achando
// que era esse quadro que a impedia de emitir. Ele nunca bloqueou nada — e
// naquela nota os dois numeros estavam certos.
//
// A regra nova nao pode mentir em NENHUM dos dois sentidos:
//   * nao inventar divergencia onde "sem pagamento" e o certo (devolucao);
//   * nao calar sobre pagamento lancado numa devolucao, que a emissao DESCARTA.
// E, acima de tudo, nao pode desligar o alarme da nota de VENDA — a regressao
// obvia desta mudanca.

const texto = (c: ConferenciaValores) => [c.titulo, ...c.linhas].join(" ").toLowerCase();

/** A conta que a tela fazia ANTES, letra por letra. Serve de sentinela. */
const REGRA_ANTIGA = (produtos: number, frete: number, pagamentos: number) =>
  Math.abs(produtos + frete - pagamentos) > 0.01;

const pag = (valor: number, meio = "PIX"): LinhaPagamento => ({ meio, valor });
const SEM_PAGAMENTO: LinhaPagamento[] = [{ meio: "SEM_PAGAMENTO", valor: 0 }];

// O rascunho real da DLS: devolucao de compra da DISAUTO, 2 de 6 itens.
const DLS_TOTAL = 864.58;
const DLS = {
  finalidade: "DEVOLUCAO",
  totalProdutos: DLS_TOTAL,
  pagamentos: SEM_PAGAMENTO,
};

describe("somarPagamentos: a mesma aritmetica que a tela ja fazia", () => {
  it("soma os valores e trata lixo como zero", () => {
    expect(somarPagamentos([pag(100), pag(50.5)])).toBe(150.5);
    expect(somarPagamentos([])).toBe(0);
    expect(somarPagamentos(undefined)).toBe(0);
    expect(somarPagamentos(null)).toBe(0);
    // `Number(x) || 0` — exatamente o que o componente fazia antes.
    expect(somarPagamentos([{ meio: "PIX" }, { valor: "abc" }, { valor: null }])).toBe(0);
    // Linha nula nao derruba a tela (o reduce antigo estouraria aqui).
    expect(somarPagamentos([null, undefined, pag(10)])).toBe(10);
    // String numerica e o que o form entrega em campo recem-digitado.
    expect(somarPagamentos([{ meio: "PIX", valor: "12.5" }])).toBe(12.5);
  });
});

describe("NOTA DE VENDA: o alarme continua exatamente como era", () => {
  it("venda com divergencia ⇒ o quadro SAI, com os dois totais e a diferenca", () => {
    const c = conferirValores({
      finalidade: "NORMAL",
      totalProdutos: 1000,
      pagamentos: [pag(800)],
    });
    expect(c.mostrar).toBe(true);
    expect(c.motivo).toBe("DIVERGENCIA");
    expect(c.titulo).toBe("Divergência nos valores");
    expect(c.diferenca).toBeCloseTo(200, 2);
    const t = texto(c);
    expect(t).toContain("1.000,00");
    expect(t).toContain("800,00");
    expect(t).toContain("diferença: r$ 200,00");
  });

  it("venda SEM divergencia ⇒ nenhum quadro", () => {
    const c = conferirValores({
      finalidade: "NORMAL",
      totalProdutos: 1000,
      pagamentos: [pag(600), pag(400, "DINHEIRO")],
    });
    expect(c.mostrar).toBe(false);
    expect(c.motivo).toBe("SEM_ALERTA");
    expect(c.linhas).toEqual([]);
  });

  it("venda com pagamento esquecido (R$ 0) ⇒ o quadro SAI — o caso que o alarme existe para pegar", () => {
    // Esta e a regressao que a tarefa mandou nao cometer: se o quadro sumisse
    // para todo mundo, nota de venda sem pagamento passaria calada.
    for (const pagamentos of [[] as LinhaPagamento[], [pag(0)], SEM_PAGAMENTO]) {
      const c = conferirValores({ finalidade: "NORMAL", totalProdutos: 1000, pagamentos });
      expect(c.mostrar, JSON.stringify(pagamentos)).toBe(true);
      expect(c.motivo, JSON.stringify(pagamentos)).toBe("DIVERGENCIA");
    }
  });

  it("COMPLEMENTAR e AJUSTE nao sao devolucao: seguem na regra da venda", () => {
    for (const finalidade of ["NORMAL", "COMPLEMENTAR", "AJUSTE", undefined, null, ""]) {
      const c = conferirValores({ finalidade, totalProdutos: 500, pagamentos: SEM_PAGAMENTO });
      expect(c.motivo, String(finalidade)).toBe("DIVERGENCIA");
    }
  });

  it("o frete entra na conta E na frase — dois numeros iguais nunca 'diferem'", () => {
    // Com frete somado na conta mas ausente da frase, o quadro dizia
    // "Total dos produtos (R$ 100,00) difere do total dos pagamentos
    // (R$ 100,00). Diferença: R$ 20,00" — dois numeros IGUAIS e uma diferenca
    // do nada. So acontece com NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED ligado.
    const c = conferirValores({
      finalidade: "NORMAL",
      totalProdutos: 100,
      totalFrete: 20,
      pagamentos: [pag(100)],
    });
    expect(c.mostrar).toBe(true);
    const t = texto(c);
    expect(t).toContain("frete r$ 20,00");
    expect(t).toContain("= r$ 120,00");
    expect(t).toContain("diferença: r$ 20,00");
    // Frete fechando a conta ⇒ nada a dizer.
    expect(
      conferirValores({
        finalidade: "NORMAL",
        totalProdutos: 100,
        totalFrete: 20,
        pagamentos: [pag(120)],
      }).mostrar,
    ).toBe(false);
  });

  it("sem frete, a frase e a de sempre: 'Total dos produtos ... difere ...'", () => {
    const c = conferirValores({
      finalidade: "NORMAL",
      totalProdutos: 100,
      totalFrete: 0,
      pagamentos: [pag(80)],
    });
    expect(c.linhas[0]).toBe(
      "Total dos produtos (R$ 100,00) difere do total dos pagamentos (R$ 80,00). Diferença: R$ 20,00.",
    );
  });
});

describe("centavos: a tolerancia herdada, intocada", () => {
  it("dois centavos alarmam; menos de um centavo, nao", () => {
    expect(
      conferirValores({ finalidade: "NORMAL", totalProdutos: 100, pagamentos: [pag(99.98)] })
        .mostrar,
    ).toBe(true);
    expect(
      conferirValores({ finalidade: "NORMAL", totalProdutos: 100, pagamentos: [pag(99.996)] })
        .mostrar,
    ).toBe(false);
    expect(
      conferirValores({ finalidade: "NORMAL", totalProdutos: 100, pagamentos: [pag(100)] })
        .mostrar,
    ).toBe(false);
    expect(TOLERANCIA_DIVERGENCIA).toBe(0.01);
  });

  it("a fronteira de UM centavo responde igualzinho a regra antiga", () => {
    // `> 0.01` sobre float tem ruido: 1,00 − 0,99 da 0.010000000000000009 (passa
    // do limite) e 10,01 − 10,00 da 0.009999999999999787 (nao passa). Esse
    // ruido e ANTERIOR a esta mudanca e continua identico de proposito: mexer na
    // tolerancia mudaria o comportamento da nota de VENDA, que nao e o assunto
    // aqui. O teste nao afirma que o ruido esta certo — afirma que nao mudou.
    for (const [produtos, pagos] of [
      [1, 0.99],
      [10.01, 10],
      [100.1, 100.09],
      [0.3, 0.29],
      [864.58, 864.57],
    ] as const) {
      const c = conferirValores({
        finalidade: "NORMAL",
        totalProdutos: produtos,
        pagamentos: [pag(pagos)],
      });
      expect(c.mostrar, `${produtos} x ${pagos}`).toBe(REGRA_ANTIGA(produtos, 0, pagos));
    }
  });
});

describe("DEVOLUCAO: o alarme falso morre, sem abrir silencio novo", () => {
  it("o rascunho REAL da DLS (R$ 864,58, sem pagamento) ⇒ nenhum quadro", () => {
    const c = conferirValores(DLS);
    expect(c.mostrar).toBe(false);
    expect(c.motivo).toBe("SEM_ALERTA");
    // A diferenca continua sendo calculada e continua sendo 864,58 — ela so
    // deixou de ser tratada como defeito, porque ali ela e o estado NORMAL.
    expect(c.diferenca).toBeCloseTo(DLS_TOTAL, 2);
    expect(REGRA_ANTIGA(DLS_TOTAL, 0, 0)).toBe(true); // era o que fazia o quadro aparecer
    expect(texto(c)).not.toContain("divergência");
    expect(texto(c)).not.toContain("864,58");
  });

  it("devolucao com pagamento ZERO nunca mostra quadro, em qualquer valor de nota", () => {
    for (const total of [0, 0.01, 150, 864.58, 12000]) {
      const c = conferirValores({
        finalidade: "DEVOLUCAO",
        totalProdutos: total,
        pagamentos: SEM_PAGAMENTO,
      });
      expect(c.mostrar, `total ${total}`).toBe(false);
    }
    // Lista vazia ou ausente tambem e "sem pagamento".
    expect(conferirValores({ finalidade: "DEVOLUCAO", totalProdutos: 500 }).mostrar).toBe(false);
    expect(
      conferirValores({ finalidade: "DEVOLUCAO", totalProdutos: 500, pagamentos: [] }).mostrar,
    ).toBe(false);
  });

  it("devolucao COM pagamento ⇒ quadro que diz a verdade: esse dinheiro nao vai na nota", () => {
    // Por que nao silencio: `emissao.ts` sobrescreve `pagamentosJson` com
    // `[{meio:"SEM_PAGAMENTO", valor:0}]`, o `nfe-xml-builder-sefaz.service.ts`
    // monta o <pag> com esse mesmo literal e o `decorarFocusDevolucao` troca
    // `formas_pagamento` por `[{forma_pagamento:"90", valor_pagamento:"0.00"}]`.
    // O R$ 500 lancado aqui e JOGADO FORA na emissao, calado. O servidor ja
    // avisa (`validacao.ts`, AVISO PAGAMENTO_SERA_90) — mas so no servidor.
    const c = conferirValores({
      finalidade: "DEVOLUCAO",
      totalProdutos: 864.58,
      pagamentos: [pag(500)],
    });
    expect(c.mostrar).toBe(true);
    expect(c.motivo).toBe("PAGAMENTO_NAO_VAI");
    const t = texto(c);
    expect(t).toContain("não vai nesta devolução");
    expect(t).toContain("tpag 90");
    expect(t).toContain("r$ 500,00"); // o valor que sera descartado, dito com todas as letras
    // E deixa claro que NAO e bloqueio: foi por achar que era que a DLS parou.
    expect(t).toContain("não impede a emissão");
    // Nunca acusa "divergencia" na devolucao, nem exibe o total dos produtos
    // como se fosse defeito.
    expect(t).not.toContain("divergência");
    expect(t).not.toContain("864,58");
  });

  it("meio errado com valor zero tambem avisa — o criterio do servidor e o MEIO", () => {
    // `validacao.ts` dispara em `meio !== "SEM_PAGAMENTO"`, independente do
    // valor. Se a tela olhasse so a soma, ficaria calada onde o servidor avisa.
    const c = conferirValores({
      finalidade: "DEVOLUCAO",
      totalProdutos: 100,
      pagamentos: [{ meio: "OUTROS", valor: 0 }],
    });
    expect(c.motivo).toBe("PAGAMENTO_NAO_VAI");
    // E o inverso: meio certo, mas sobrou valor.
    expect(
      conferirValores({
        finalidade: "DEVOLUCAO",
        totalProdutos: 100,
        pagamentos: [{ meio: "SEM_PAGAMENTO", valor: 500 }],
      }).motivo,
    ).toBe("PAGAMENTO_NAO_VAI");
  });

  it("pagamentoSeraDescartado: espelha o criterio do validacao.ts", () => {
    expect(pagamentoSeraDescartado(SEM_PAGAMENTO)).toBe(false);
    expect(pagamentoSeraDescartado([])).toBe(false);
    expect(pagamentoSeraDescartado(undefined)).toBe(false);
    expect(pagamentoSeraDescartado([{ meio: "SEM_PAGAMENTO", valor: 0 }, null])).toBe(false);
    expect(pagamentoSeraDescartado([pag(0, "PIX")])).toBe(true);
    expect(pagamentoSeraDescartado([{ meio: "SEM_PAGAMENTO", valor: 0.01 }])).toBe(true);
    // Centavo partido nao inventa dinheiro (0,1 + 0,2 = 0,30000000000000004).
    expect(
      pagamentoSeraDescartado([
        { meio: "SEM_PAGAMENTO", valor: 0.1 },
        { meio: "SEM_PAGAMENTO", valor: -0.1 },
      ]),
    ).toBe(false);
  });

  it("caixa e espaco na finalidade nao ressuscitam o alarme falso", () => {
    for (const f of ["DEVOLUCAO", " devolucao ", "Devolucao"]) {
      expect(
        conferirValores({ finalidade: f, totalProdutos: 864.58, pagamentos: SEM_PAGAMENTO })
          .mostrar,
        String(f),
      ).toBe(false);
    }
  });
});

describe("invariante: fora da devolucao, nada mudou", () => {
  const TOTAIS = [0, 0.01, 99.99, 100, 864.58, 1000];
  const FRETES = [0, 20];
  const FINALIDADES = ["NORMAL", "COMPLEMENTAR", "AJUSTE", undefined, null, ""];

  it("varre a matriz e compara com a regra antiga, caso a caso", () => {
    let casos = 0;
    for (const finalidade of FINALIDADES)
      for (const totalProdutos of TOTAIS)
        for (const totalFrete of FRETES)
          for (const pagos of TOTAIS) {
            const c = conferirValores({
              finalidade,
              totalProdutos,
              totalFrete,
              pagamentos: [pag(pagos)],
            });
            const rotulo = JSON.stringify({ finalidade, totalProdutos, totalFrete, pagos });
            // O veredito e IDENTICO ao de antes: so a finalidade DEVOLUCAO muda
            // de regra, e ela nao esta nesta matriz.
            expect(c.mostrar, rotulo).toBe(REGRA_ANTIGA(totalProdutos, totalFrete, pagos));
            expect(c.motivo, rotulo).toBe(c.mostrar ? "DIVERGENCIA" : "SEM_ALERTA");
            // A devolucao nunca cai neste ramo: o texto do pagamento descartado
            // nao pode vazar para uma nota de venda.
            expect(texto(c), rotulo).not.toContain("devolução");
            if (c.mostrar) {
              expect(c.titulo, rotulo).toBe("Divergência nos valores");
              expect(c.linhas.length, rotulo).toBeGreaterThanOrEqual(1);
            } else {
              expect(c.linhas, rotulo).toEqual([]);
            }
            casos++;
          }
    expect(casos).toBe(
      FINALIDADES.length * TOTAIS.length * FRETES.length * TOTAIS.length,
    );
  });

  it("quadro nenhum sai vazio e quadro nenhum some com texto dentro", () => {
    for (const finalidade of [...FINALIDADES, "DEVOLUCAO"])
      for (const pagamentos of [SEM_PAGAMENTO, [pag(500)], [], undefined]) {
        const c = conferirValores({ finalidade, totalProdutos: 864.58, pagamentos });
        const rotulo = JSON.stringify({ finalidade, pagamentos });
        if (c.mostrar) {
          expect(c.titulo.length, rotulo).toBeGreaterThan(0);
          expect(c.linhas.length, rotulo).toBeGreaterThan(0);
          expect(c.linhas.every((l) => l.trim().length > 0), rotulo).toBe(true);
        } else {
          expect(c.titulo, rotulo).toBe("");
          expect(c.linhas, rotulo).toEqual([]);
        }
        // A diferenca e informada sempre, mostre-se o quadro ou nao.
        expect(Number.isFinite(c.diferenca), rotulo).toBe(true);
        expect(c.totalPagamentos, rotulo).toBe(somarPagamentos(pagamentos));
      }
  });
});

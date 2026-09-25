/**
 * O que o editor da devolução DECIDE sem desenhar (`nfe-devolucao-editor-ui.ts`):
 * o corpo do PUT de cada peça, o que trava o salvar, a recusa do servidor
 * traduzida por peça, a pergunta da entrega, os valores e os totais.
 *
 * Casos reais (DLS AUTO PEÇAS, 24/09/2026) que cada bloco prende:
 *  - N-fluxo-4: "Dados da requisição inválidos." jogava fora `erros[]`, que diz
 *    a peça e o campo — e o índice `itens[i]` é o do corpo ENVIADO, que não leva
 *    as peças tiradas (17:54:39: o nItem 2 zerado deslocava os índices).
 *  - K3/K4/N-fluxo-6/N-pis-cofins-ipi-4: o corpo levava outra coisa que a tela
 *    mostrava; o CST apagava a alíquota; campo vazio virava 0%.
 *  - N-fluxo-3: "não respondi" virava "não".
 *  - N-pis-cofins-ipi-6 / N-fluxo-8: ela nunca via o valor dos impostos nem o total.
 */
import { describe, expect, it } from "vitest";

import {
  ENTREGA_SIM,
  FALHA_VEJA_AS_PECAS,
  IPI_NAO_DEVOLVER,
  REVISAO_ACERTE_ALIQUOTA,
  REVISAO_DEPOIS_DE_SALVAR,
  chaveDaLinha,
  corpoDoItemImpostos,
  falhaDoSalvar,
  impostosDaLinha,
  linhaDoItem,
  linhaForaDaDevolucao,
  linhasDoDetalhe,
  perguntaEntrega,
  produtoDaLinha,
  quadroTotais,
  textoEscopo,
  tituloDaLinha,
  valoresDaTributacao,
  type LinhaEditor,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-editor-ui";
import { BLOQUEIO_CONFIRMAR } from "../../../app/notas-fiscais/lib/nfe-devolucao-icms-campo";
import { BLOQUEIO_CONFIRMAR_PIS_COFINS } from "../../../app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo";
import { regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";
import type { DevolucaoItemDetalhe } from "../../../app/fiscal/devolucao/contrato";
import type { TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

const CHAVE = "42260980689839000975550010008528991757991829";
const SIMPLES = regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA");
const NORMAL = regimeEmitenteDevolucao("LUCRO_REAL", "COMPRA_SAIDA");

function trib(p: Partial<TributacaoDevolucaoItem> = {}): TributacaoDevolucaoItem {
  return {
    versao: 1,
    fonte: "XML_ORIGINAL",
    icms: { tag: "ICMSSN102", cst: null, csosn: "102", orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
    pis: { cst: "49", vBC: 0, p: 0, v: 0 },
    cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
    ipiDevol: null,
    requerRevisao: true,
    motivosRevisao: [],
    avisos: [],
    confirmada: false,
    ...p,
  };
}

function item(nItem: number, extra: Partial<DevolucaoItemDetalhe> = {}): DevolucaoItemDetalhe {
  return {
    ordem: nItem,
    chaveAcesso: CHAVE,
    nItem,
    codigo: `P-${nItem}`,
    descricao: `Peça ${nItem}`,
    unidade: "UN",
    ncm: "87089990",
    quantidadeOriginal: 2,
    devolvidaAutorizada: 0,
    emProcessamento: 0,
    disponivel: 2,
    quantidade: 1,
    valorUnitario: 100,
    valor: 100,
    cfopOriginal: "5102",
    cfop: "5202",
    cfopStatus: "ESCOLHA",
    cfopOpcoes: ["5202"],
    tributacao: trib(),
    requerRevisao: true,
    ...extra,
  };
}

const com = (i: DevolucaoItemDetalhe, patch: Partial<LinhaEditor>): LinhaEditor => ({ ...linhaDoItem(i), ...patch });

describe("linhas — casadas pela CHAVE, nunca pela posição", () => {
  it("a chave é nota + item da nota original", () => {
    expect(chaveDaLinha(CHAVE, 5)).toBe(`${CHAVE}#5`);
    expect(Object.keys(linhasDoDetalhe({ itens: [item(5), item(6)] }))).toEqual([`${CHAVE}#5`, `${CHAVE}#6`]);
  });
  it("a linha nasce do GRAVADO, com os impostos 'não mexidos'", () => {
    const l = linhaDoItem(item(5, { quantidade: 2.5, tributacao: trib({ confirmada: true }) }));
    expect(l).toMatchObject({ quantidadeTexto: "2,5", cfop: "5202", confirmar: true, tirada: false, icms: null, pis: null, pPis: null });
    expect(linhaForaDaDevolucao(item(5)).tirada).toBe(true);
  });
});

describe("produtoDaLinha — o passo Produtos", () => {
  it("sem mudança: vai como está, mantendo a revisão feita", () => {
    const i = item(5, { tributacao: trib({ confirmada: true }) });
    const p = produtoDaLinha({ linha: linhaDoItem(i), item: i, naDevolucao: true });
    expect(p.corpo).toEqual({ chaveAcesso: CHAVE, nItem: 5, quantidade: 1, cfop: "5202", confirmarTributacao: true });
    expect(p.mudou).toBe(false);
    expect(p.bloqueia).toBe(false);
  });

  it("quantidade mudou: a revisão vale para os valores antigos, então vai false", () => {
    const i = item(5, { tributacao: trib({ confirmada: true }) });
    const p = produtoDaLinha({ linha: com(i, { quantidadeTexto: "2" }), item: i, naDevolucao: true });
    expect(p.corpo?.quantidade).toBe(2);
    expect(p.corpo?.confirmarTributacao).toBe(false);
    expect(p.mudou).toBe(true);
  });

  it("campo apagado NÃO tira a peça: trava o salvar e não vira 0", () => {
    const i = item(5);
    const p = produtoDaLinha({ linha: com(i, { quantidadeTexto: "" }), item: i, naDevolucao: true });
    expect(p.fora).toBe(false);
    expect(p.corpo).toBeNull();
    expect(p.bloqueia).toBe(true);
  });

  it("acima do disponível trava", () => {
    const i = item(2, { disponivel: 1 });
    expect(produtoDaLinha({ linha: com(i, { quantidadeTexto: "10" }), item: i, naDevolucao: true }).bloqueia).toBe(true);
  });

  it("tirar é a ação explícita (botão) ou o 0 digitado: a peça não vai no corpo", () => {
    const i = item(5);
    for (const linha of [com(i, { tirada: true }), com(i, { quantidadeTexto: "0" })]) {
      const p = produtoDaLinha({ linha, item: i, naDevolucao: true });
      expect(p.fora).toBe(true);
      expect(p.corpo).toBeNull();
      expect(p.bloqueia).toBe(false);
      expect(p.mudou).toBe(true);
    }
  });

  it("peça que já saiu e continua fora não é mudança; trazida de volta, vai sem a revisão", () => {
    const i = item(3);
    expect(produtoDaLinha({ linha: linhaForaDaDevolucao(i), item: i, naDevolucao: false }).mudou).toBe(false);
    const volta = produtoDaLinha({ linha: com(i, { tirada: false }), item: i, naDevolucao: false });
    expect(volta.corpo).toMatchObject({ nItem: 3, quantidade: 1, confirmarTributacao: false });
    expect(volta.mudou).toBe(true);
  });

  it("CFOP vazio numa peça que vai: trava, com a frase", () => {
    const i = item(1, { cfop: "" });
    const p = produtoDaLinha({ linha: linhaDoItem(i), item: i, naDevolucao: true });
    expect(p.bloqueia).toBe(true);
    expect(p.erroCfop).toBe("Escolha o CFOP de devolução desta peça.");
  });
});

describe("impostosDaLinha — o corpo sai do que a tela MOSTRA", () => {
  const icms00 = trib({
    icms: { tag: "ICMS00", cst: "00", csosn: null, orig: 0, modBC: "3", vBC: 123.56, pICMS: 12, vICMS: 14.83 },
  });

  it("sem mexer: nada de imposto no corpo ('não mexi' é não mexer)", () => {
    const i = item(5);
    const r = impostosDaLinha({ linha: linhaDoItem(i), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.tributacao).toBeUndefined();
    expect(r.mudou).toBe(false);
  });

  it("K4: 900 → 102 → 900 com 5 digitado: a caixa mostra 5 e o corpo leva 5", () => {
    const i = item(5, { tributacao: icms00 });
    const r = impostosDaLinha({ linha: com(i, { icms: "900", pIcms: "5" }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.pIcmsTexto).toBe("5");
    expect(r.tributacao?.icms).toEqual({ csosn: "900", cst: null, pICMS: 5 });
  });

  it("K4: escolhido o 900 sem digitar, a caixa mostra o GRAVADO e o corpo leva o mesmo número", () => {
    const i = item(5, { tributacao: icms00 });
    const r = impostosDaLinha({ linha: com(i, { icms: "900" }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.pIcmsTexto).toBe("12");
    expect(r.tributacao?.icms).toEqual({ csosn: "900", cst: null, pICMS: 12 });
  });

  it("K4: caixa apagada NÃO vira 0%: trava o salvar e o ICMS não vai", () => {
    const i = item(5, { tributacao: icms00 });
    const r = impostosDaLinha({ linha: com(i, { icms: "900", pIcms: "" }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.erros.icms).toBe("Informe a alíquota do ICMS (de 0 a 100).");
    expect(r.bloqueiaSalvar).toBe(true);
    expect(r.tributacao?.icms).toBeUndefined();
    expect(r.bloqueioRevisao).toBe(REVISAO_ACERTE_ALIQUOTA);
  });

  it("N-pis-cofins-ipi-4: alíquota digitada ANTES do CST não se perde", () => {
    const i = item(5, { tributacao: trib({ pis: { cst: "01", vBC: 108.73, p: 1.65, v: 1.79 } }) });
    const r = impostosDaLinha({ linha: com(i, { pPis: "3", pis: "02" }), item: i, emitente: NORMAL, tipo: "COMPRA_SAIDA" });
    expect(r.tributacao?.pis).toEqual({ cst: "02", p: 3 });
  });

  it("N-fluxo-6: trocar só o CST leva a alíquota que a caixa mostra (a gravada), não a do fornecedor", () => {
    const i = item(6, { tributacao: trib({ fonte: "USUARIO", pis: { cst: "01", vBC: 295.88, p: 1.65, v: 4.88 } }) });
    const r = impostosDaLinha({ linha: com(i, { pis: "02" }), item: i, emitente: NORMAL, tipo: "COMPRA_SAIDA" });
    expect(r.pPisTexto).toBe("1.65");
    expect(r.tributacao?.pis).toEqual({ cst: "02", p: 1.65 });
  });

  it("K1: no Simples o 01 gravado não serve — a revisão trava até escolher", () => {
    const i = item(5, { tributacao: trib({ pis: { cst: "01", vBC: 0, p: 0, v: 0 }, cofins: { cst: "01", vBC: 0, p: 0, v: 0 } }) });
    const r = impostosDaLinha({ linha: com(i, { confirmar: true }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.pis.precisaEscolher).toBe(true);
    expect(r.bloqueioRevisao).toBe(BLOQUEIO_CONFIRMAR_PIS_COFINS);
    expect(r.confirmar).toBe(false);
    // Escolhido o 49 nos dois: vão os dois pares, com a alíquota da caixa.
    const ok = impostosDaLinha({ linha: com(i, { pis: "49", cofins: "49" }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(ok.tributacao).toEqual({ pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } });
    expect(ok.bloqueioRevisao).toBe("");
  });

  it("o ICMS que não serve trava a revisão ANTES do PIS (a frase de sempre)", () => {
    const i = item(5, { tributacao: icms00 });
    expect(impostosDaLinha({ linha: linhaDoItem(i), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" }).bloqueioRevisao).toBe(BLOQUEIO_CONFIRMAR);
  });

  it("mudança que muda VALOR: 'Revisei' só depois de salvar e ver o valor novo", () => {
    const i = item(5, { tributacao: icms00 });
    const r = impostosDaLinha({ linha: com(i, { icms: "900", confirmar: true }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.valoresPendentes).toBe(true);
    expect(r.bloqueioRevisao).toBe(REVISAO_DEPOIS_DE_SALVAR);
    expect(r.confirmar).toBe(false);
  });

  it("código sem valor (102): nada a calcular, a revisão fica livre", () => {
    const i = item(5, { tributacao: icms00 });
    const r = impostosDaLinha({ linha: com(i, { icms: "102", confirmar: true }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.valoresPendentes).toBe(false);
    expect(r.confirmar).toBe(true);
  });

  it("valor gravado inválido (01 a 0% no regime normal) trava a revisão mas NÃO o salvar de outra coisa", () => {
    const i = item(5, {
      tributacao: trib({
        icms: { tag: "ICMS40", cst: "40", csosn: null, orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
        pis: { cst: "01", vBC: 0, p: 0, v: 0 },
      }),
    });
    const r = impostosDaLinha({ linha: linhaDoItem(i), item: i, emitente: NORMAL, tipo: "COMPRA_SAIDA" });
    expect(r.erros.pis).toContain("06");
    expect(r.bloqueiaSalvar).toBe(false);
    expect(r.bloqueioRevisao).toBe(REVISAO_ACERTE_ALIQUOTA);
  });

  it("IPI: 'Não devolver' manda ipiDevol:false; desmarcar depois de gravado manda true", () => {
    const comIpi = item(5, { tributacao: trib({ ipiDevol: { pDevol: 50, vIPIDevol: 6.5 }, motivosRevisao: ["IPI_DESTACADO"] }) });
    const r = impostosDaLinha({ linha: com(comIpi, { ipiRetirar: true }), item: comIpi, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.ipi).toEqual({ tem: true, retirado: true });
    expect(r.tributacao).toEqual({ ipiDevol: false });
    const retirado = item(5, { tributacao: trib({ ipiDevol: null, motivosRevisao: ["IPI_DESTACADO"] }) });
    expect(impostosDaLinha({ linha: linhaDoItem(retirado), item: retirado, emitente: SIMPLES, tipo: "COMPRA_SAIDA" }).ipi.retirado).toBe(true);
    expect(
      impostosDaLinha({ linha: com(retirado, { ipiRetirar: false }), item: retirado, emitente: SIMPLES, tipo: "COMPRA_SAIDA" }).tributacao,
    ).toEqual({ ipiDevol: true });
    expect(IPI_NAO_DEVOLVER).toBe("Não devolver o IPI desta peça");
  });

  it("o corpo do passo Impostos leva quantidade e CFOP gravados", () => {
    const i = item(5, { quantidade: 1, cfop: "5202" });
    const linha = com(i, { pis: "04" });
    const imp = impostosDaLinha({ linha, item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(corpoDoItemImpostos({ linha, item: i, impostos: imp })).toEqual({
      chaveAcesso: CHAVE,
      nItem: 5,
      quantidade: 1,
      cfop: "5202",
      confirmarTributacao: false,
      tributacao: { pis: { cst: "04", p: 0 } },
    });
  });
});

describe("falhaDoSalvar — a frase do servidor vai para a PEÇA dela", () => {
  const pecas = [
    { chaveAcesso: CHAVE, nItem: 1, ordem: 1, codigo: "P-1" },
    { chaveAcesso: CHAVE, nItem: 2, ordem: 2, codigo: "P-2" },
    { chaveAcesso: CHAVE, nItem: 5, ordem: 3, codigo: "P-5" },
  ];
  // O nItem 2 foi zerado: o corpo enviado é [1, 5], e `itens[1]` é o nItem 5.
  const enviado = [{ chaveAcesso: CHAVE, nItem: 1 }, { chaveAcesso: CHAVE, nItem: 5 }];

  it("400 com `erros`: pelo corpo ENVIADO, não pela posição na tela (a DLS às 17:54:39)", () => {
    const f = falhaDoSalvar({
      corpo: { error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO", erros: [{ campo: "itens[1].cfop", mensagem: "Escolha o CFOP de devolução (4 dígitos)." }] },
      enviado,
      pecas,
      passo: 3,
    });
    expect(f.mensagem).toBe(FALHA_VEJA_AS_PECAS);
    expect(f.porLinha[`${CHAVE}#5`]).toEqual(["CFOP: Escolha o CFOP de devolução (4 dígitos)."]);
    expect(f.porLinha[`${CHAVE}#2`]).toBeUndefined();
  });

  it("o `nItem` que o servidor devolve manda sobre a posição", () => {
    const f = falhaDoSalvar({
      corpo: { code: "PAYLOAD_INVALIDO", erros: [{ campo: "itens[0].tributacao.pis.cst", mensagem: "Use 2 dígitos.", nItem: 5, chaveAcesso: CHAVE }] },
      enviado,
      pecas,
      passo: 8,
    });
    expect(f.porLinha[`${CHAVE}#5`]).toEqual(["Código do PIS: Use 2 dígitos."]);
  });

  it("CFOP recusado fora do passo 3 manda voltar ao passo 3", () => {
    const f = falhaDoSalvar({ corpo: { code: "PAYLOAD_INVALIDO", erros: [{ campo: "itens[0].cfop", mensagem: "Escolha o CFOP de devolução (4 dígitos)." }] }, enviado, pecas, passo: 8 });
    expect(f.porLinha[`${CHAVE}#1`]?.[0]).toContain('passo 3 ("Produtos")');
  });

  it("erro sem peça fica em cima; sem `erros` nem `issues`, a frase do servidor como está", () => {
    const f = falhaDoSalvar({ corpo: { code: "PAYLOAD_INVALIDO", error: "Dados da requisição inválidos.", erros: [{ campo: "itens", mensagem: "Escolha pelo menos um item para devolver." }] }, enviado, pecas, passo: 3 });
    expect(f.gerais).toEqual(["Escolha pelo menos um item para devolver."]);
    expect(falhaDoSalvar({ corpo: { error: "Esta nota já foi enviada à SEFAZ." }, enviado, pecas, passo: 3 }).mensagem).toBe("Esta nota já foi enviada à SEFAZ.");
    expect(falhaDoSalvar({ corpo: null, enviado, pecas, passo: 3 }).mensagem).toBe("Não foi possível salvar a devolução.");
  });

  it("422 com `issues`: o quadro de pendências e a frase na peça (pela ordem)", () => {
    const f = falhaDoSalvar({
      corpo: {
        error: "Tributação não suportada na devolução.",
        code: "TRIBUTACAO_NAO_SUPORTADA",
        issues: [{ code: "PIS_COFINS_REGIME_INCOMPATIVEL", severidade: "ERRO", ordem: 2, mensagem: "Item 2: PIS: O CST 01 é de empresa do regime normal." }],
      },
      enviado,
      pecas,
      passo: 3,
    });
    expect(f.pendencias?.bloqueios[0].codigo).toBe("PIS_COFINS_REGIME_INCOMPATIVEL");
    expect(f.porLinha[`${CHAVE}#2`]).toEqual(["PIS: O CST 01 é de empresa do regime normal."]);
    expect(f.mensagem).toBe("Tributação não suportada na devolução.");
  });
});

describe("perguntaEntrega — pergunta do TIPO da devolução, três estados", () => {
  it("compra: fala do fornecedor; venda: do cliente; o 'Sim' é o texto que o catálogo cita", () => {
    const c = perguntaEntrega("COMPRA_SAIDA");
    expect(c.pergunta).toContain("fornecedor");
    expect(c.pergunta).not.toContain("cliente");
    expect(c.sim.startsWith(ENTREGA_SIM)).toBe(true);
    const v = perguntaEntrega("VENDA_ENTRADA");
    expect(v.pergunta).toContain("cliente");
    expect(v.sim.startsWith(ENTREGA_SIM)).toBe(true);
    expect(ENTREGA_SIM).toBe("A mercadoria foi entregue e está sendo devolvida");
  });
  it("o escopo é dito em português (e não é mais escolhido)", () => {
    expect(textoEscopo("TOTAL")).toContain("todas as peças");
    expect(textoEscopo("PARCIAL")).toContain("só parte");
    expect(textoEscopo("PARCIAL")).not.toContain("escopo");
  });
});

describe("títulos, valores e totais", () => {
  it("N-fluxo-7: o número de cima é o das pendências; o da nota original vai embaixo", () => {
    expect(tituloDaLinha({ ordem: 1, codigo: "33603-3", descricao: "RETENTOR", nItem: 5 })).toEqual({
      titulo: "Item 1 — 33603-3 — RETENTOR",
      origem: "(item 5 da nota original)",
    });
    expect(tituloDaLinha({ ordem: null, codigo: "X", descricao: "", nItem: 2 }).titulo).toBe("X");
  });

  it("os valores do item com a base (a DISAUTO: R$ 108,73 × 1,65% = R$ 1,79)", () => {
    const v = valoresDaTributacao(
      trib({
        icms: { tag: "ICMSSN900", cst: null, csosn: "900", orig: 0, modBC: "3", vBC: 123.56, pICMS: 12, vICMS: 14.83 },
        pis: { cst: "49", vBC: 108.73, p: 1.65, v: 1.79 },
        cofins: { cst: "04", vBC: 0, p: 0, v: 0 },
        ipiDevol: { pDevol: 100, vIPIDevol: 6.5 },
      }),
    );
    expect(v).toEqual([
      { tributo: "ICMS", texto: "base R$ 123,56 × 12% = R$ 14,83" },
      { tributo: "PIS", texto: "base R$ 108,73 × 1,65% = R$ 1,79" },
      { tributo: "COFINS", texto: "sem valor na nota" },
      { tributo: "IPI devolvido", texto: "100% do IPI da nota original = R$ 6,50" },
    ]);
  });

  it("quadro de totais: valor da nota com o IPI devolvido, e 'prévia' com os itens que faltam", () => {
    const q = quadroTotais({
      totalProdutos: 419.44,
      totalDesconto: 0,
      totalFrete: 0,
      totalBcIcms: 419.44,
      totalIcms: 50.34,
      totalPis: 0,
      totalCofins: 0,
      totalIpiDevol: 6.5,
      totalNota: 425.94,
      completo: false,
      itensPendentes: [1, 2],
    });
    expect(q?.nota.map((l) => `${l.rotulo}=${l.valor}`)).toEqual([
      "Produtos=R$ 419,44",
      "IPI devolvido=R$ 6,50",
      "Valor da nota=R$ 425,94",
    ]);
    expect(q?.previa).toContain("dos itens 1 e 2");
    expect(q?.impostos.find((l) => l.rotulo === "ICMS")?.valor).toBe("R$ 50,34");
    expect(quadroTotais(undefined)).toBeNull();
  });
});

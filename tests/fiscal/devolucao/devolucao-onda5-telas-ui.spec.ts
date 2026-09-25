/**
 * Onda 5 da NF-e de devolução — grupo I3 (telas), a parte que se decide SEM
 * desenhar (módulos puros de `app/notas-fiscais/lib/`).
 *
 * O que mais doeu na DLS AUTO PEÇAS (Simples Nacional, SC): documento fiscal
 * errado que a SEFAZ AUTORIZA — PIS/COFINS com alíquota numa empresa do Simples
 * não tem rejeição, só se desfaz cancelando — e texto que manda fazer o que a
 * tela não tem. Estes testes prendem:
 *  - decisão 2 do dono na TELA: no Simples a alíquota do PIS/COFINS é travada
 *    em 0, com a frase do porquê, e o corpo leva 0;
 *  - K11 depois de recarregar: a peça tirada volta (`itensForaDaDevolucao`);
 *  - a recusa do servidor vai para a PEÇA (chave + nº do item), e a `ordem` só
 *    na falta;
 *  - "esta peça também está no rascunho X / na devolução nº Y";
 *  - "Devoluções em andamento" não chama /abertas com a devolução desligada, e
 *    o seletor de CNPJ da devolução manual;
 *  - textos: o subtítulo "salvo automaticamente", o "pagamento 90", a origem.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  cabecalhoDevolucao,
  falhaDoSalvar,
  impostosDaLinha,
  textoNotaOriginal,
  linhaDoItem,
  pecasForaDaDevolucao,
  quantidadeAoVoltar,
  saldoDaPeca,
  textosOutrasDevolucoes,
  type LinhaEditor,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-editor-ui";
import {
  ALIQUOTA_TRAVADA_SIMPLES,
  aliquotaGravadaNoSimples,
  campoPisCofins,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo";
import {
  DEVOLUCAO_DESLIGADA,
  consultarDisponibilidade,
  lerDisponibilidade,
  precisaEscolherEmpresa,
  rotuloEmpresa,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-disponibilidade-ui";
import {
  ORIGENS_MERCADORIA,
  ROTULO_DEVOLVER_PELA_CHAVE,
  lerItensDigitados,
  linhasDaNota,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-manual-ui";
import {
  AVISO_SALVAR_DEVOLUCAO,
  SUBTITULO_EMITIR_NFE,
  TEXTO_DEVOLUCAO_SEM_COBRANCA,
  quadroDevolucaoAMao,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-wizard-ui";
import { viewDevolucoesDaNota } from "../../../app/notas-fiscais/lib/nfe-devolucao-vinculo-ui";
import {
  AVISO_FEITA_A_MAO,
  AVISO_REJEITADA,
  ROTULO_CONTINUAR,
  TITULO_DEVOLUCOES_EM_ANDAMENTO,
} from "../../../app/notas-fiscais/lib/nfe-devolucoes-abertas-ui";
import { QUANTIDADE_VAZIA, lerQuantidadeDevolucao } from "../../../app/notas-fiscais/lib/nfe-devolucao-quantidade-campo";
import { MOTIVO_ALIQUOTA_SIMPLES, regimeEmitenteDevolucao } from "../../../app/fiscal/devolucao/tributacao";
import type { DevolucaoItemDetalhe, SaldoResposta } from "../../../app/fiscal/devolucao/contrato";
import type { TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

const CHAVE = "42260980689839000975550010008528991757991829";
const SIMPLES = regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA");
const NORMAL = regimeEmitenteDevolucao("LUCRO_REAL", "COMPRA_SAIDA");
const SIMPLES_VENDA = regimeEmitenteDevolucao("SIMPLES", "VENDA_ENTRADA");

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

// ─────────────────────── decisão 2 na tela: alíquota travada em 0 ───────────────────────

describe("decisão 2 — no Simples a alíquota do PIS/COFINS é TRAVADA em 0", () => {
  it("o campo sabe: Simples + código com alíquota ⇒ travada; regime normal e código sem alíquota ⇒ não", () => {
    expect(campoPisCofins({ emitente: SIMPLES, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "49" } }).aliquotaTravadaEmZero).toBe(true);
    expect(campoPisCofins({ emitente: SIMPLES_VENDA, tipo: "VENDA_ENTRADA", tributo: "cofins", gravado: { cst: "99" } }).aliquotaTravadaEmZero).toBe(true);
    expect(campoPisCofins({ emitente: NORMAL, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "01" } }).aliquotaTravadaEmZero).toBe(false);
    // 04 não leva alíquota: não há caixa a travar.
    expect(campoPisCofins({ emitente: SIMPLES, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "04" } }).aliquotaTravadaEmZero).toBe(false);
    // Código que não serve: nem há alíquota a mostrar.
    expect(campoPisCofins({ emitente: SIMPLES, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "01" } }).aliquotaTravadaEmZero).toBe(false);
  });

  it("CRT 2 (Simples acima do sublimite) também: o PIS/COFINS continua na guia do Simples", () => {
    const crt2 = { ...SIMPLES, crt: "2" as const };
    expect(campoPisCofins({ emitente: crt2, tipo: "COMPRA_SAIDA", tributo: "pis", gravado: { cst: "49" } }).aliquotaTravadaEmZero).toBe(true);
  });

  it("a frase é a MESMA do servidor (ajuste e validação)", () => {
    expect(ALIQUOTA_TRAVADA_SIMPLES).toBe(MOTIVO_ALIQUOTA_SIMPLES);
    expect(ALIQUOTA_TRAVADA_SIMPLES).toContain("guia do Simples");
  });

  it("COFINS 49 a 1,64% GRAVADA (a DLS chegou a gravar): a caixa mostra 0, o corpo leva 0 e a frase diz o que estava", () => {
    const i = item(5, { tributacao: trib({ cofins: { cst: "49", vBC: 123.56, p: 1.64, v: 2.03 } }) });
    const r = impostosDaLinha({ linha: linhaDoItem(i), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.pCofinsTexto).toBe("0");
    expect(r.erros.cofins).toBe("");
    expect(r.tributacao).toEqual({ cofins: { cst: "49", p: 0 } });
    expect(r.mudou).toBe(true);
    expect(r.aliquotaGravada.cofins).toBe(aliquotaGravadaNoSimples("cofins", 1.64));
    expect(r.aliquotaGravada.cofins).toContain("1,64%");
    expect(r.aliquotaGravada.cofins).toContain('"Salvar devolução"');
    expect(r.aliquotaGravada.pis).toBe("");
    // Zerar não esconde valor novo: a revisão fica livre (é o que o catálogo manda fazer).
    expect(r.bloqueioRevisao).toBe("");
  });

  it("número digitado ANTES não vaza: no Simples o corpo leva 0 mesmo com 1,65 na linha", () => {
    const i = item(5);
    const r = impostosDaLinha({ linha: com(i, { pis: "99", pPis: "1.65" }), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.pPisTexto).toBe("0");
    expect(r.tributacao?.pis).toEqual({ cst: "99", p: 0 });
    expect(r.erros.pis).toBe("");
  });

  it("49 a 0 gravado no Simples: nada muda, nada vai no corpo", () => {
    const i = item(5);
    const r = impostosDaLinha({ linha: linhaDoItem(i), item: i, emitente: SIMPLES, tipo: "COMPRA_SAIDA" });
    expect(r.tributacao).toBeUndefined();
    expect(r.mudou).toBe(false);
    expect(r.aliquotaGravada).toEqual({ pis: "", cofins: "" });
  });

  it("regime normal: a caixa continua livre — 1,65 digitado vai 1,65", () => {
    const i = item(5, { tributacao: trib({ pis: { cst: "01", vBC: 100, p: 1.65, v: 1.65 } }) });
    const r = impostosDaLinha({ linha: com(i, { pis: "02", pPis: "3" }), item: i, emitente: NORMAL, tipo: "COMPRA_SAIDA" });
    expect(r.pis.aliquotaTravadaEmZero).toBe(false);
    expect(r.tributacao?.pis).toEqual({ cst: "02", p: 3 });
  });
});

// ─────────────────────── K11: a peça tirada volta depois de recarregar ───────────────────────

describe("K11 — peças fora da devolução, também depois de recarregar", () => {
  it("junta as tiradas nesta visita com as que o servidor devolve, sem repetir e sem as que estão dentro", () => {
    const dentro = item(1);
    const servidor = [item(3, { ordem: 0, quantidade: 2 }), item(2, { ordem: 0, quantidade: 1 }), item(1, { ordem: 0 })];
    const local = item(2, { quantidade: 1.5 });
    const fora = pecasForaDaDevolucao({ itens: [dentro], itensForaDaDevolucao: servidor }, [local]);
    expect(fora.map((i) => i.nItem)).toEqual([2, 3]);
    // Na peça tirada agora vale o que ela tinha escrito.
    expect(fora[0].quantidade).toBe(1.5);
  });

  it("servidor antigo (sem o campo): só as tiradas nesta visita, como antes", () => {
    expect(pecasForaDaDevolucao({ itens: [item(1)] }, [item(2)]).map((i) => i.nItem)).toEqual([2]);
    expect(pecasForaDaDevolucao({ itens: [item(1)] }, [])).toEqual([]);
  });

  it("ao VOLTAR: o que ela escreveu; senão a quantidade da peça; saldo desconhecido (0) ⇒ caixa vazia, nunca 0", () => {
    expect(quantidadeAoVoltar({ quantidadeTexto: "1,5" }, { quantidade: 2 })).toBe("1,5");
    expect(quantidadeAoVoltar({ quantidadeTexto: "0" }, { quantidade: 2 })).toBe("2");
    expect(quantidadeAoVoltar({ quantidadeTexto: "  " }, { quantidade: 2.5 })).toBe("2,5");
    const vazia = quantidadeAoVoltar({ quantidadeTexto: "0" }, { quantidade: 0 });
    expect(vazia).toBe("");
    // Caixa vazia pede a quantidade (e trava o salvar) — com 0 a peça sairia de novo.
    expect(lerQuantidadeDevolucao(vazia, null)).toMatchObject({ estado: "VAZIA", mensagem: QUANTIDADE_VAZIA, bloqueia: true });
  });
});

// ─────────────────────── a recusa vai para a PEÇA ───────────────────────

describe("falhaDoSalvar — issue casada pela peça (chave + nº do item); `ordem` só na falta", () => {
  const pecas = [
    { chaveAcesso: CHAVE, nItem: 1, ordem: 1, codigo: "P-1" },
    { chaveAcesso: CHAVE, nItem: 5, ordem: 2, codigo: "P-5" },
    // Peça trazida de volta nesta visita: sem ordem gravada.
    { chaveAcesso: CHAVE, nItem: 7, ordem: null, codigo: "P-7" },
  ];
  const enviado = pecas.map((p) => ({ chaveAcesso: p.chaveAcesso, nItem: p.nItem }));
  const recusa = (issue: Record<string, unknown>) =>
    falhaDoSalvar({
      corpo: { error: "Quantidade maior que o saldo disponível para devolução.", code: "SALDO_INSUFICIENTE", issues: [{ code: "SALDO_EXCEDIDO", severidade: "ERRO", mensagem: "Item 3: P-7 (item 7 da nota original): pedida 2, disponível 1.", ...issue }] },
      enviado,
      pecas,
      passo: 3,
    });

  it("com chave e nº do item, vai para ESSA peça — mesmo que a `ordem` aponte outra", () => {
    const f = recusa({ ordem: 2, nItem: 7, chaveAcesso: CHAVE });
    expect(f.porLinha[`${CHAVE}#7`]).toEqual(["P-7 (item 7 da nota original): pedida 2, disponível 1."]);
    expect(f.porLinha[`${CHAVE}#5`]).toBeUndefined();
  });

  it("servidor antigo (só `ordem`): vale a ordem, como antes", () => {
    const f = recusa({ ordem: 2 });
    expect(f.porLinha[`${CHAVE}#5`]).toHaveLength(1);
  });

  it("peça que não está na tela: não chuta pela ordem (a frase fica no quadro de pendências)", () => {
    const f = recusa({ ordem: 1, nItem: 99, chaveAcesso: CHAVE });
    expect(Object.keys(f.porLinha)).toEqual([]);
    expect(f.pendencias?.bloqueios.length).toBeGreaterThan(0);
  });
});

// ─────────────────────── onde mais a peça está ───────────────────────

describe("outrasDevolucoes — 'esta peça também está no rascunho X / na devolução nº Y'", () => {
  it("uma frase por devolução, dizendo o que cada uma muda", () => {
    const t = textosOutrasDevolucoes({
      unidade: "UN",
      outrasDevolucoes: [
        { nfeId: "r1", status: "DRAFT", numero: null, serie: 1, quantidade: 1, criadaEm: "2026-09-24T20:03:00.000Z" },
        { nfeId: "e1", status: "SENDING", numero: 716, serie: 1, quantidade: 2, criadaEm: null },
        { nfeId: "a1", status: "AUTHORIZED", numero: 715, serie: 1, quantidade: 1.5, criadaEm: null },
        { nfeId: "x1", status: "REJECTED", numero: 714, serie: 1, quantidade: 1, criadaEm: null },
        { nfeId: "c1", status: "CANCELLED", numero: 713, serie: 1, quantidade: 1, criadaEm: null },
      ],
    });
    expect(t).toHaveLength(4);
    expect(t[0]).toContain("Também está em outro rascunho de devolução (1 UN, começado em 24/09 17:03)");
    expect(t[0]).toContain(`"Notas Emitidas" › "${TITULO_DEVOLUCOES_EM_ANDAMENTO}"`);
    expect(t[1]).toContain("na NF-e de devolução nº 716 (série 1), que está sendo enviada à SEFAZ (2 UN)");
    expect(t[2]).toBe("Já foi devolvida na NF-e de devolução nº 715 (série 1), autorizada: 1,5 UN.");
    expect(t[3]).toContain("na devolução nº 714 (série 1) recusada pela SEFAZ");
    expect(t.join(" ")).not.toContain("713");
  });

  it("sem outras devoluções (ou servidor antigo): nada", () => {
    expect(textosOutrasDevolucoes({ unidade: "UN" })).toEqual([]);
    expect(textosOutrasDevolucoes({ unidade: "UN", outrasDevolucoes: [] })).toEqual([]);
  });

  it("o saldo da peça numa linha: nota, já devolvida, em envio e em outro rascunho", () => {
    expect(saldoDaPeca({ quantidadeOriginal: 3, devolvidaAutorizada: 1, emProcessamento: 0.5, emRascunho: 1, unidade: "PC" })).toBe(
      "Na nota original: 3 PC · já devolvida: 1 · em envio à SEFAZ: 0,5 · em outro rascunho: 1",
    );
    expect(saldoDaPeca({ quantidadeOriginal: null, devolvidaAutorizada: 0, emProcessamento: 0, unidade: "UN" })).toBe("");
  });
});

// ─────────────────────── disponibilidade e o seletor de CNPJ ───────────────────────

describe("disponibilidade da devolução — ligada? em quais empresas?", () => {
  const EMPRESA = (id: string, extra: Record<string, unknown> = {}) => ({
    companyFiscalConfigId: id, cnpj: "57502966000144", razaoSocial: "DLS AUTO PECAS LTDA", nomeFantasia: "DLS AUTO PEÇAS", uf: "SC", ambiente: "PRODUCAO", isDefault: false, ...extra,
  });

  it("servidor antigo (sem `empresas`): vale o companyFiscalConfigId, como antes", () => {
    expect(lerDisponibilidade(200, { disponivel: true, companyFiscalConfigId: "cfg" })).toEqual({ ligada: true, companyFiscalConfigId: "cfg", empresas: [] });
  });

  it("404, corpo estranho ou sem empresa ⇒ desligada", () => {
    expect(lerDisponibilidade(404, { error: "Recurso indisponível" })).toEqual(DEVOLUCAO_DESLIGADA);
    expect(lerDisponibilidade(200, null)).toEqual(DEVOLUCAO_DESLIGADA);
    expect(lerDisponibilidade(200, { disponivel: true, companyFiscalConfigId: null, empresas: [] })).toEqual(DEVOLUCAO_DESLIGADA);
  });

  it("uma ligada só, sem o id na raiz: é ela (a tela não pede para escolher sem ter o que escolher)", () => {
    expect(lerDisponibilidade(200, { disponivel: true, companyFiscalConfigId: null, empresas: [EMPRESA("unica")] }).companyFiscalConfigId).toBe("unica");
  });

  it("duas ligadas fora da padrão: ligada, sem empresa escolhida — ela escolhe", () => {
    const d = lerDisponibilidade(200, { disponivel: true, companyFiscalConfigId: null, empresas: [EMPRESA("a"), EMPRESA("b", { cnpj: "11222333000181" })] });
    expect(d.ligada).toBe(true);
    expect(d.companyFiscalConfigId).toBeNull();
    expect(precisaEscolherEmpresa(d)).toBe(true);
    expect(precisaEscolherEmpresa(lerDisponibilidade(200, { disponivel: true, companyFiscalConfigId: "a", empresas: [EMPRESA("a")] }))).toBe(false);
  });

  it("o nome da empresa no seletor é o que ela conhece, com o CNPJ e a UF (e homologação avisada)", () => {
    expect(rotuloEmpresa(EMPRESA("a"))).toBe("DLS AUTO PEÇAS — CNPJ 57.502.966/0001-44 (SC)");
    expect(rotuloEmpresa(EMPRESA("a", { nomeFantasia: null, ambiente: "HOMOLOGACAO" }))).toBe(
      "DLS AUTO PECAS LTDA — CNPJ 57.502.966/0001-44 (SC) — em homologação (teste, sem valor fiscal)",
    );
  });

  it("as duas caixas da lista dividem UMA pergunta em voo; depois de respondida, pergunta de novo", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ disponivel: true, companyFiscalConfigId: "cfg", empresas: [] }) }));
    const fetchImpl = f as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      consultarDisponibilidade({ base: "http://api", email: "x@y", fetchImpl }),
      consultarDisponibilidade({ base: "http://api", email: "x@y", fetchImpl }),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    await consultarDisponibilidade({ base: "http://api", email: "x@y", fetchImpl });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("rede caída ⇒ desligada (não afirma nada)", async () => {
    const fetchImpl = (async () => { throw new Error("rede"); }) as unknown as typeof fetch;
    expect(await consultarDisponibilidade({ base: "http://api", email: "z@y", fetchImpl })).toEqual(DEVOLUCAO_DESLIGADA);
  });
});

// ─────────────────────── devolução manual pela chave: origem e quantidade original ───────────────────────

describe("devolução manual pela chave — origem e quantidade da nota original", () => {
  const LINHA = { nItem: "3", codigo: "X", descricao: "Porta", ncm: "87082999", unidade: "UN", cfopOriginal: "", valorUnitario: "45,90", quantidade: "1" };

  it("origem SEM valor pré-escolhido: vazia não vai no corpo (o Dexo não inventa)", () => {
    expect(lerItensDigitados([LINHA]).itens[0]).not.toHaveProperty("origem");
    expect(lerItensDigitados([LINHA]).itens[0]).not.toHaveProperty("quantidadeOriginal");
  });

  it("escolhida, vai como número; quantidade da nota original lida no formato brasileiro", () => {
    const r = lerItensDigitados([{ ...LINHA, origem: "2", quantidadeOriginal: "1,5" }]);
    expect(r.erros).toEqual([]);
    expect(r.itens[0]).toMatchObject({ origem: 2, quantidadeOriginal: 1.5 });
  });

  it("quantidade que volta acima da nota original: erro NO campo, e nada vai", () => {
    const r = lerItensDigitados([{ ...LINHA, quantidade: "3", quantidadeOriginal: "2" }]);
    expect(r.itens).toEqual([]);
    expect(r.erros).toEqual([{ campo: "itens[0].quantidade", mensagem: "A quantidade que volta (3) passa da quantidade da nota original (2)." }]);
  });

  it("origem fora da tabela é recusada no campo", () => {
    expect(lerItensDigitados([{ ...LINHA, origem: "9" }]).erros.map((e) => e.campo)).toEqual(["itens[0].origem"]);
  });

  it("a venda do Dexo traz a origem da PRÓPRIA nota; sem ela, o campo fica vazio", () => {
    expect(linhasDaNota([{ numero: 2, codigo: "P", origem: 1 }])[0].origem).toBe("1");
    expect(linhasDaNota([{ numero: 2, codigo: "P" }])[0]).not.toHaveProperty("origem");
  });

  it("as 9 origens da tabela da NF-e, com o número primeiro", () => {
    expect(ORIGENS_MERCADORIA.map((o) => o.codigo)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
    for (const o of ORIGENS_MERCADORIA) expect(o.rotulo.startsWith(`${o.codigo} — `)).toBe(true);
  });
});

// ─────────────────────── textos de tela ───────────────────────

describe("textos de tela da devolução — o que a tela diz existe, e sem jargão", () => {
  it("G4 #1: o subtítulo de 'Emitir NF-e' não promete mais 'salvo automaticamente'", () => {
    expect(SUBTITULO_EMITIR_NFE).not.toContain("salvo automaticamente");
    expect(SUBTITULO_EMITIR_NFE).toContain('"Salvar devolução"');
    // O mesmo botão que o aviso dos passos da devolução cita.
    expect(AVISO_SALVAR_DEVOLUCAO).toContain('"Salvar devolução"');
    const pagina = readFileSync(resolve(__dirname, "../../../app/notas-fiscais/nfe/page.tsx"), "utf8");
    expect(pagina).toContain("subtitle={SUBTITULO_EMITIR_NFE}");
    expect(pagina).not.toContain("O rascunho é salvo automaticamente");
  });

  it("o topo do quadro fala para onde a peça vai, sem 'operação fiscal'; e de quem é a nota original", () => {
    const compra = cabecalhoDevolucao("COMPRA_SAIDA");
    expect(compra.titulo).toContain("a peça volta para o fornecedor");
    expect(cabecalhoDevolucao("VENDA_ENTRADA").titulo).toContain("o cliente devolveu a peça");
    expect(compra.estoque).not.toMatch(/exclusivamente fiscal/i);
    expect(compra.estoque).toContain("estoque");
    expect(textoNotaOriginal("COMPRA_SAIDA", { numero: 852899, serie: 1 })).toBe("Nota do fornecedor: NF-e nº 852899, série 1");
    expect(textoNotaOriginal("VENDA_ENTRADA", { numero: 711, serie: 1 })).toBe("Sua nota de venda: NF-e nº 711, série 1");
  });

  it("os botões que os avisos citam existem com ESTE texto", () => {
    // Rascunho feito à mão (passo 1): a venda sem XML não tem "Devolver total/parcial".
    expect(quadroDevolucaoAMao("ABERTO").caminhos.join(" ")).toContain(`"${ROTULO_DEVOLVER_PELA_CHAVE}"`);
    expect(ROTULO_DEVOLVER_PELA_CHAVE).toBe("Devolver pela chave");
    // "Devoluções em andamento": não há botão "Devolver" nem "Abra" — são estes.
    expect(AVISO_FEITA_A_MAO).toContain('"Devolver total" ou "Devolver parcial"');
    expect(AVISO_FEITA_A_MAO).not.toContain('"Devolver" na');
    // Revisão final (textos): a venda sem XML no Dexo também aqui — o botão dela é outro.
    expect(AVISO_FEITA_A_MAO).toContain(`"${ROTULO_DEVOLVER_PELA_CHAVE}"`);
    expect(AVISO_REJEITADA).toContain(`"${ROTULO_CONTINUAR}"`);
  });

  it("passos 6 e 7 da devolução: sem o 'pagamento 90' do XML, e com o botão que existe", () => {
    expect(TEXTO_DEVOLUCAO_SEM_COBRANCA).not.toMatch(/\b90\b/);
    expect(TEXTO_DEVOLUCAO_SEM_COBRANCA).toContain('"Próximo"');
  });

  it("ficha da venda: devolução em VALIDATING/SIGNING aparece como 'em envio', não o código cru", () => {
    const s = {
      original: {} as SaldoResposta["original"],
      elegivel: true,
      motivo: null,
      totalmenteDevolvida: false,
      devolucoes: [
        { nfeId: "d1", numero: 716, serie: 1, status: "VALIDATING", itens: [{ nItem: 1, quantidade: 1 }] },
        { nfeId: "d2", numero: 717, serie: 1, status: "SIGNING", itens: [] },
      ],
      itens: [],
    } as unknown as SaldoResposta;
    const v = viewDevolucoesDaNota(s);
    expect(v.devolucoes.map((d) => d.texto)).toEqual(["NF-e 716 (série 1) — em envio — item 1 (1)", "NF-e 717 (série 1) — em envio"]);
  });
});

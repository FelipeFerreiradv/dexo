/**
 * Onda 5 da NF-e de devolução (grupo I1 — domínio fiscal e textos).
 *
 * O que mais doeu na DLS AUTO PEÇAS (Simples Nacional, SC) foram dois tipos de
 * defeito: documento fiscal ERRADO que a SEFAZ AUTORIZA (PIS/COFINS de regime
 * normal numa empresa do Simples não tem rejeição — só se desfaz cancelando) e
 * texto que manda fazer o que a tela não tem. Estes testes prendem as decisões
 * do dono que fecham os dois:
 *
 *  2. No Simples (CRT 1/2/4) o PIS/COFINS vai na guia do Simples: alíquota > 0 é
 *     RECUSADA (tela, ajuste e validação), e os códigos de CRÉDITO (50–56, 60–67)
 *     saem das opções e do juiz, no molde do 01/02.
 *  3. CST de ENTRADA (50–98) numa devolução de COMPRA (nota de saída) é RECUSADO.
 *     O 99 serve aos dois sentidos.
 *  4. O 49 herdado numa devolução de VENDA (entrada) continua AVISO — e o
 *     servidor e a tela dizem o mesmo.
 *  5. Um valor IGUAL ao já SALVO não é ajuste novo: não barra o salvamento de
 *     outra coisa. A emissão continua barrando (`validarDevolucao`).
 */
import { describe, expect, it } from "vitest";

import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import { CFOPS_DEVOLUCAO, EXCECAO_1949_2949 } from "../../../app/fiscal/domain/devolucao-cfop";
import { findCfop } from "../../../app/fiscal/domain/cfop-catalog";
import {
  DEVOLUCAO_ERRO_HTTP,
  DEVOLUCAO_ERRO_MENSAGEM,
  parseCriarDevolucaoResposta,
} from "../../../app/fiscal/devolucao/contrato";
import type { DevolucaoIssue, TributacaoDevolucaoItem, TributacaoOverride } from "../../../app/fiscal/devolucao/tipos";
import {
  MOTIVO_ALIQUOTA_SIMPLES,
  aplicarOverrideTributacao,
  checarCstPisCofinsDevolucao,
  normalizarImpostoOriginal,
  opcoesPisCofinsDevolucao,
  proporcionalizar,
  regimeEmitenteDevolucao,
  sentidoCstPisCofins,
  tagCompativelComCrt,
} from "../../../app/fiscal/devolucao/tributacao";
import { validarDevolucao, type ContextoValidacaoDevolucao } from "../../../app/fiscal/devolucao/validacao";
import {
  OPCAO_ENTREGUE_COMPRA,
  OPCAO_ENTREGUE_VENDA,
  pendenciasDeIssues,
  viewPendenciasDoDetalhe,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-pendencias-ui";
import { perguntaEntrega, TIRAR_DA_DEVOLUCAO } from "../../../app/notas-fiscais/lib/nfe-devolucao-editor-ui";
import { rotuloCampoPisCofins } from "../../../app/notas-fiscais/lib/nfe-devolucao-pis-cofins-campo";
import { rotuloCfop } from "../../../app/notas-fiscais/lib/nfe-devolucao-cfop-campo";
import { ROTULO_DESCARTAR, TITULO_DEVOLUCOES_EM_ANDAMENTO } from "../../../app/notas-fiscais/lib/nfe-devolucoes-abertas-ui";
import { viewErroCalculo } from "../../../app/notas-fiscais/lib/nfe-erro-calculo-ui";

// ───────────────────────────── o caso da DLS ─────────────────────────────

const CNPJ_DLS = "57502966000144";
const CNPJ_DISAUTO = "80689839000975";

function chave(cnpj: string, cuf = "42", numero = 852899): string {
  const base = cuf + "2609" + cnpj + "55" + "001" + String(numero).padStart(9, "0") + "1" + "75799182";
  return base + calcularDvChaveAcesso(base)!;
}
const CHAVE_COMPRA = chave(CNPJ_DISAUTO);

// Item 5 da DISAUTO (33603-3): regime normal, PIS/COFINS 01 a 1,65%/7,6%.
const ITEM5 = normalizarImpostoOriginal({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
  PIS: { PISAliq: { CST: "01", vBC: "108.73", pPIS: "1.65", vPIS: "1.79" } },
  COFINS: { COFINSAliq: { CST: "01", vBC: "108.73", pCOFINS: "7.60", vCOFINS: "8.26" } },
});

// Item 6 da DISAUTO (24171-7): PIS/COFINS 04.
const ITEM6 = normalizarImpostoOriginal({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "295.88", pICMS: "12.00", vICMS: "35.51" } },
  PIS: { PISNT: { CST: "04" } },
  COFINS: { COFINSNT: { CST: "04" } },
});

const baseCompra = (imposto = ITEM5, vUn = 123.56, crtEmitente = "1") =>
  proporcionalizar({ impostoOriginal: imposto, qOriginal: 1, qDevolvida: 1, vUnCom: vUn, crtEmitente, crtOriginal: "3", tipoOperacao: "SAIDA" });

/** Devolução de COMPRA da DLS à DISAUTO, item 5, com a tributação dada (o caso bom: 900 a 12% + 49 a 0). */
function ctxCompra(trib: TributacaoDevolucaoItem): ContextoValidacaoDevolucao {
  return {
    cabecalho: { tipo: "COMPRA_SAIDA", devolvidaAposEntrega: true, confirmadoSemXml: false, origensJson: [{ chaveAcesso: CHAVE_COMPRA, crtOriginal: "3" }] },
    nota: {
      modelo: "55", finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA", destinoOperacao: "INTERNA", ambiente: "PRODUCAO",
      destinatarioCpfCnpj: CNPJ_DISAUTO, destinatarioJson: { tipoPessoa: "PJ", inscricaoEstadual: "258272414", uf: "SC" },
      notasReferenciadasJson: null, pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }], duplicatasJson: null,
    },
    emitente: { cnpj: CNPJ_DLS, crt: "1" },
    itens: [{ numero: 1, codigo: "33603-3", quantidade: 1, cfop: "5202" }],
    refs: [{ ordem: 1, chaveAcesso: CHAVE_COMPRA, nItem: 5, codigoOriginal: "33603-3", quantidade: 1, quantidadeOriginal: 1, tributacao: trib, impostoOriginal: ITEM5 }],
    saldos: [{ chaveAcesso: CHAVE_COMPRA, nItem: 5, disponivel: 1 }],
    originais: [],
    idDestOriginal: 1,
  };
}

function bom(): TributacaoDevolucaoItem {
  const r = aplicarOverrideTributacao({
    base: baseCompra(), confirmar: true, crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    override: { icms: { csosn: "900", cst: null, pICMS: 12 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } },
  });
  if (!r.ok) throw new Error("fixture: " + r.erros.join("; "));
  return r.tributacao;
}

const codigos = (issues: DevolucaoIssue[]) => issues.map((i) => i.code);
const CREDITO = ["50", "51", "52", "53", "54", "55", "56", "60", "61", "62", "63", "64", "65", "66", "67"];
const ENTRADA = Array.from({ length: 49 }, (_, i) => String(50 + i)); // 50..98

describe("o caso bom da DLS continua limpo (nada de pendência nova)", () => {
  it("900 a 12% + PIS/COFINS 49 a 0, confirmado: nenhuma pendência", () => {
    expect(validarDevolucao(ctxCompra(bom()))).toEqual([]);
  });
});

// ───────────────────────────── decisão 2 ─────────────────────────────

describe("decisão 2 — Simples: alíquota de PIS/COFINS fica 0, e sem código de crédito", () => {
  it("o juiz recusa alíquota > 0 no Simples (CRT 1, 2 e 4), com a frase da guia do Simples; 0 passa", () => {
    for (const crt of ["1", "2", "4"]) {
      const r = checarCstPisCofinsDevolucao({ crt, tipo: "COMPRA_SAIDA", codigo: "49", p: 1.65 });
      expect(r, `CRT ${crt}`).toMatchObject({ ok: false, causa: "ALIQUOTA", motivo: MOTIVO_ALIQUOTA_SIMPLES });
      expect(checarCstPisCofinsDevolucao({ crt, tipo: "COMPRA_SAIDA", codigo: "49", p: 0 }).ok).toBe(true);
      expect(checarCstPisCofinsDevolucao({ crt, tipo: "VENDA_ENTRADA", codigo: "99", p: 0.01 }).ok).toBe(false);
    }
    expect(MOTIVO_ALIQUOTA_SIMPLES).toContain("guia do Simples");
    expect(MOTIVO_ALIQUOTA_SIMPLES).toContain("fica 0");
    // Regime normal continua informando a alíquota.
    expect(checarCstPisCofinsDevolucao({ crt: "3", tipo: "COMPRA_SAIDA", codigo: "49", p: 1.65 }).ok).toBe(true);
    // Sem alíquota informada, o juiz não confere a alíquota (a lista do seletor).
    expect(checarCstPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA", codigo: "49" }).ok).toBe(true);
  });

  it("o ajuste recusa 49 a 1,65% no Simples com código próprio — o caso E da revisão (vPIS 2,04 autorizado)", () => {
    const r = aplicarOverrideTributacao({
      base: baseCompra(), override: { pis: { cst: "49", p: 1.65 }, cofins: { cst: "49", p: 7.6 } },
      crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.recusas.map((x) => [x.tributo, x.code])).toEqual([
      ["PIS", "PIS_COFINS_ALIQUOTA_SIMPLES"],
      ["COFINS", "PIS_COFINS_ALIQUOTA_SIMPLES"],
    ]);
    expect(r.recusas[0].motivo).toBe(MOTIVO_ALIQUOTA_SIMPLES);
    // Fora de 0–100 continua sendo a outra recusa (e o 01/02 a zero, no regime normal).
    const fora = aplicarOverrideTributacao({ base: baseCompra(), override: { pis: { cst: "49", p: 150 } }, crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (fora.ok) throw new Error("deveria recusar");
    expect(fora.recusas[0].code).toBe("PIS_COFINS_ALIQUOTA_INVALIDA");
  });

  it("a validação dá ERRO (mesmo com 'Revisei') e cita a alíquota; o 01 do Simples leva SÓ a recusa de regime", () => {
    const t = bom();
    const comAliquota = { ...t, pis: { cst: "49", vBC: 123.56, p: 1.65, v: 2.04 }, cofins: { cst: "49", vBC: 123.56, p: 7.6, v: 9.39 } };
    const issues = validarDevolucao(ctxCompra(comAliquota));
    expect(codigos(issues)).toEqual(["PIS_COFINS_ALIQUOTA_SIMPLES"]);
    expect(issues[0].severidade).toBe("ERRO");
    expect(issues[0].mensagem).toContain("PIS com alíquota de 1,65%");
    expect(issues[0].mensagem).toContain("COFINS com alíquota de 7,6%");
    expect(issues[0].mensagem).toContain("só se desfaz cancelando");
    // O 01 a 1,65% do rascunho 4a3698ee: uma frase só (a de regime), não duas.
    const o01 = { ...t, pis: { cst: "01", vBC: 123.56, p: 1.65, v: 2.04 } };
    expect(codigos(validarDevolucao(ctxCompra(o01)))).toEqual(["PIS_COFINS_REGIME_INCOMPATIVEL"]);
    // Regime normal com alíquota: nada.
    const normal = ctxCompra({ ...t, icms: { tag: "ICMS00", cst: "00", csosn: null, orig: 0, modBC: "3", vBC: 123.56, pICMS: 12, vICMS: 14.83 }, pis: { cst: "49", vBC: 123.56, p: 1.65, v: 2.04 } });
    normal.emitente.crt = "3";
    expect(codigos(validarDevolucao(normal))).not.toContain("PIS_COFINS_ALIQUOTA_SIMPLES");
  });

  it("códigos de crédito (50–56, 60–67): fora da lista e recusados no Simples, em qualquer tipo; no regime normal servem", () => {
    for (const crt of ["1", "2", "4"]) {
      for (const tipo of ["VENDA_ENTRADA", "COMPRA_SAIDA", undefined] as const) {
        const oferecidos = opcoesPisCofinsDevolucao({ crt, tipo }).map((o) => o.codigo);
        for (const c of CREDITO) {
          expect(oferecidos, `${crt}/${tipo}/${c}`).not.toContain(c);
          const r = checarCstPisCofinsDevolucao({ crt, tipo, codigo: c });
          expect(r, `${crt}/${tipo}/${c}`).toMatchObject({ ok: false, causa: "REGIME" });
        }
      }
    }
    const r50 = checarCstPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA", codigo: "50" });
    if (r50.ok) throw new Error("deveria recusar");
    expect(r50.motivo).toContain("crédito");
    expect(r50.motivo).toContain("Simples Nacional");
    // Regime normal, devolução de venda (entrada): os de crédito continuam.
    const normal = opcoesPisCofinsDevolucao({ crt: "3", tipo: "VENDA_ENTRADA" }).map((o) => o.codigo);
    for (const c of CREDITO) expect(normal).toContain(c);
    // O ajuste usa o código de pendência de regime.
    const venda = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } }, PIS: { PISOutr: { CST: "98", vBC: "0", pPIS: "0", vPIS: "0" } }, COFINS: { COFINSOutr: { CST: "98", vBC: "0", pCOFINS: "0", vCOFINS: "0" } } }),
      qOriginal: 1, qDevolvida: 1, vUnCom: 10, crtEmitente: "1", crtOriginal: "1",
    });
    const a = aplicarOverrideTributacao({ base: venda, override: { cofins: { cst: "56", p: 0 } }, crtEmitente: "1", baseCalculoItem: 10 });
    if (a.ok) throw new Error("deveria recusar");
    expect(a.recusas[0]).toMatchObject({ tributo: "COFINS", code: "PIS_COFINS_REGIME_INCOMPATIVEL" });
  });

  it("a validação barra o crédito no Simples com a frase de regime (e não repete a de sentido numa saída)", () => {
    const t = bom();
    const issues = validarDevolucao(ctxCompra({ ...t, pis: { cst: "50", vBC: 0, p: 0, v: 0 } }));
    expect(codigos(issues)).toEqual(["PIS_COFINS_REGIME_INCOMPATIVEL"]);
    expect(issues[0].mensagem).toContain("50 do PIS");
    expect(issues[0].mensagem).toContain("crédito de PIS/COFINS");
  });

  it("derivação: o Simples não herda alíquota nem de nota do próprio Simples", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
        PIS: { PISOutr: { CST: "49", vBC: "100.00", pPIS: "0.65", vPIS: "0.65" } },
        COFINS: { COFINSOutr: { CST: "49", vBC: "100.00", pCOFINS: "3.00", vCOFINS: "3.00" } },
      }),
      qOriginal: 1, qDevolvida: 1, vUnCom: 100, crtEmitente: "1", crtOriginal: "1",
    });
    expect(t.pis).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
    expect(t.cofins).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
    // Regime normal continua herdando.
    const n = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "100", pICMS: "18", vICMS: "18" } },
        PIS: { PISOutr: { CST: "49", vBC: "100.00", pPIS: "0.65", vPIS: "0.65" } },
        COFINS: { COFINSOutr: { CST: "49", vBC: "100.00", pCOFINS: "3.00", vCOFINS: "3.00" } },
      }),
      qOriginal: 1, qDevolvida: 1, vUnCom: 100, crtEmitente: "3", crtOriginal: "3",
    });
    expect(n.pis).toEqual({ cst: "49", vBC: 100, p: 0.65, v: 0.65 });
  });

  it("a ajuda do Simples diz que a alíquota fica 0 e cita os de crédito", () => {
    const e = regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA");
    expect(e.pisCofinsAjuda).toContain("alíquota na nota fica 0");
    expect(e.pisCofinsAjuda).toContain("50 a 56 e 60 a 67");
  });
});

// ───────────────────────────── decisão 3 ─────────────────────────────

describe("decisão 3 — CST de entrada (50–98) numa devolução de compra é RECUSADO; o 99 serve aos dois", () => {
  it("fora da lista e recusado pelo juiz, em todo regime; o 99 fica", () => {
    for (const crt of ["1", "2", "3", "4", null] as const) {
      for (const tipo of ["COMPRA_SAIDA", "SAIDA"] as const) {
        const oferecidos = opcoesPisCofinsDevolucao({ crt, tipo }).map((o) => o.codigo);
        expect(oferecidos, `${crt}/${tipo}`).toContain("99");
        expect(oferecidos.filter((c) => sentidoCstPisCofins(c) === "ENTRADA"), `${crt}/${tipo}`).toEqual([]);
        for (const c of ENTRADA) {
          const r = checarCstPisCofinsDevolucao({ crt, tipo, codigo: c });
          expect(r.ok, `${crt}/${tipo}/${c}`).toBe(false);
        }
        expect(checarCstPisCofinsDevolucao({ crt, tipo, codigo: "99" }).ok).toBe(true);
      }
    }
    // Regime normal: 98 é recusado por SENTIDO (no Simples, 50–67 caem antes por REGIME).
    expect(checarCstPisCofinsDevolucao({ crt: "3", tipo: "COMPRA_SAIDA", codigo: "98" })).toMatchObject({ ok: false, causa: "SENTIDO" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA", codigo: "70" })).toMatchObject({ ok: false, causa: "SENTIDO" });
  });

  it("numa devolução de VENDA (entrada) os de entrada seguem servindo", () => {
    expect(checarCstPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA", codigo: "98" })).toMatchObject({ ok: true, aviso: null });
    expect(checarCstPisCofinsDevolucao({ crt: "3", tipo: "VENDA_ENTRADA", codigo: "50" })).toMatchObject({ ok: true, aviso: null });
  });

  it("a ajuda da devolução de compra diz que os de entrada não aparecem", () => {
    expect(regimeEmitenteDevolucao("LUCRO_REAL", "COMPRA_SAIDA").pisCofinsAjuda).toContain("50 a 98");
    expect(regimeEmitenteDevolucao("LUCRO_REAL", "VENDA_ENTRADA").pisCofinsAjuda).not.toContain("50 a 98");
  });
});

// ───────────────────────────── decisão 4 ─────────────────────────────

describe("decisão 4 — CST de saída numa devolução de VENDA: AVISO, e o servidor diz o mesmo que a tela", () => {
  const venda = (cst: string): ContextoValidacaoDevolucao => {
    const chaveVenda = chave(CNPJ_DLS, "42", 711);
    const trib = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
        PIS: cst === "04" || cst === "06" || cst === "07" || cst === "08" || cst === "09"
          ? { PISNT: { CST: cst } }
          : { PISOutr: { CST: cst, vBC: "0", pPIS: "0", vPIS: "0" } },
        COFINS: cst === "04" || cst === "06" || cst === "07" || cst === "08" || cst === "09"
          ? { COFINSNT: { CST: cst } }
          : { COFINSOutr: { CST: cst, vBC: "0", pCOFINS: "0", vCOFINS: "0" } },
      }),
      qOriginal: 1, qDevolvida: 1, vUnCom: 12000, crtEmitente: "1", crtOriginal: "1",
    });
    return {
      cabecalho: { tipo: "VENDA_ENTRADA", devolvidaAposEntrega: true, confirmadoSemXml: false },
      nota: { modelo: "55", finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA", destinoOperacao: "INTERNA", notasReferenciadasJson: null, pagamentosJson: null, duplicatasJson: null },
      emitente: { cnpj: CNPJ_DLS, crt: "1" },
      itens: [{ numero: 1, codigo: "P1", quantidade: 1, cfop: "1202" }],
      refs: [{ ordem: 1, chaveAcesso: chaveVenda, nItem: 1, codigoOriginal: "P1", quantidade: 1, quantidadeOriginal: 1, tributacao: { ...trib, confirmada: true } }],
      saldos: [{ chaveAcesso: chaveVenda, nItem: 1, disponivel: 1 }],
      idDestOriginal: 1,
    };
  };

  it("para cada código que o seletor oferece numa devolução de venda: aviso do campo ⇔ aviso do servidor", () => {
    for (const o of opcoesPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA" })) {
      const campo = checarCstPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA", codigo: o.codigo });
      if (!campo.ok) throw new Error(`o seletor ofereceu ${o.codigo} e o juiz recusou`);
      const servidor = validarDevolucao(venda(o.codigo));
      const avisa = servidor.some((i) => i.code === "PIS_CST_SAIDA_EM_ENTRADA" && i.severidade === "AVISO");
      expect(avisa, `CST ${o.codigo}`).toBe(campo.aviso === "PIS_CST_SAIDA_EM_ENTRADA");
      // Nunca vira impedimento.
      expect(servidor.filter((i) => i.severidade === "ERRO"), `CST ${o.codigo}`).toEqual([]);
    }
  });

  it("o rascunho d93eb8c8 (nota 711: 102 + 49 herdados, avisos []) ganha o aviso — e só ele", () => {
    const issues = validarDevolucao(venda("49"));
    expect(issues).toEqual([
      { code: "PIS_CST_SAIDA_EM_ENTRADA", severidade: "AVISO", ordem: 1, mensagem: expect.stringContaining("49 do PIS e 49 da COFINS") },
    ]);
  });
});

// ───────────────────────────── decisão 5 ─────────────────────────────

describe("decisão 5 — o valor IGUAL ao salvo não é ajuste novo (`salvo` em aplicarOverrideTributacao)", () => {
  // O ajuste gravado no item 2 do rascunho 4a3698ee da DLS (lido em produção,
  // só leitura): 900 + PIS/COFINS 01 a 0% numa empresa do Simples.
  const SALVO_4A36_ITEM2: TributacaoOverride = {
    icms: { cst: null, csosn: "900", modBC: "3", pICMS: 12 },
    pis: { cst: "01", p: 0 },
    cofins: { cst: "01", p: 0 },
  };

  it("sem `salvo` (chamada antiga): igual a antes — o 01 salvo é julgado e recusado", () => {
    const r = aplicarOverrideTributacao({
      base: baseCompra(ITEM6, 295.88), override: SALVO_4A36_ITEM2,
      crtEmitente: "1", baseCalculoItem: 295.88, tipoOperacao: "SAIDA",
    });
    if (r.ok) throw new Error("sem o salvo, o comportamento é o de antes");
    expect(r.recusas.map((x) => x.code)).toEqual(["PIS_COFINS_REGIME_INCOMPATIVEL", "PIS_COFINS_REGIME_INCOMPATIVEL"]);
  });

  it("com `salvo`: salvar a QUANTIDADE (reenvio do gravado) passa; o 01 é regravado como está", () => {
    const r = aplicarOverrideTributacao({
      base: baseCompra(ITEM6, 295.88), override: SALVO_4A36_ITEM2, salvo: SALVO_4A36_ITEM2,
      crtEmitente: "1", baseCalculoItem: 295.88, tipoOperacao: "SAIDA",
    });
    if (!r.ok) throw new Error(r.erros.join("; "));
    expect(r.tributacao.pis).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    expect(r.tributacao.cofins).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    expect(r.tributacao.icms).toMatchObject({ tag: "ICMSSN900", csosn: "900", pICMS: 12, vBC: 295.88, vICMS: 35.51 });
    // A EMISSÃO continua barrada por ele.
    const ctx = ctxCompra({ ...r.tributacao, confirmada: true });
    expect(codigos(validarDevolucao(ctx))).toContain("PIS_COFINS_REGIME_INCOMPATIVEL");
  });

  it("item 1 do mesmo rascunho (01 a 1,65% salvo): regravado com a base do item; mudar SÓ o PIS julga só o PIS", () => {
    const salvo: TributacaoOverride = { icms: { cst: null, csosn: "900", modBC: "3", pICMS: 12 }, pis: { cst: "01", p: 1.65 }, cofins: { cst: "01", p: 7.6 } };
    const base = baseCompra();
    expect(base.pis).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    const reenvio = aplicarOverrideTributacao({ base, override: salvo, salvo, crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (!reenvio.ok) throw new Error(reenvio.erros.join("; "));
    expect(reenvio.tributacao.pis).toEqual({ cst: "01", vBC: 123.56, p: 1.65, v: 2.04 });

    // Ela troca o PIS para 49 a 0 (a COFINS segue a salva): passa — o PIS foi julgado e serve.
    const soPis = aplicarOverrideTributacao({ base, override: { ...salvo, pis: { cst: "49", p: 0 } }, salvo, crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (!soPis.ok) throw new Error(soPis.erros.join("; "));
    expect(soPis.tributacao.pis).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
    expect(soPis.tributacao.cofins.cst).toBe("01");

    // Mas o que ela MUDOU é julgado: 49 a 1,65% no Simples é recusado.
    const errado = aplicarOverrideTributacao({ base, override: { ...salvo, pis: { cst: "49", p: 1.65 } }, salvo, crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (errado.ok) throw new Error("deveria recusar");
    expect(errado.recusas).toEqual([{ tributo: "PIS", code: "PIS_COFINS_ALIQUOTA_SIMPLES", motivo: MOTIVO_ALIQUOTA_SIMPLES }]);
  });

  it("ICMS igual ao salvo depois de a empresa trocar de regime: não barra o salvamento; a validação barra a emissão", () => {
    const salvo: TributacaoOverride = { icms: { cst: null, csosn: "900", modBC: "3", pICMS: 12 } };
    const base = baseCompra(ITEM5, 123.56, "3");
    const sem = aplicarOverrideTributacao({ base, override: salvo, crtEmitente: "3", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (sem.ok) throw new Error("sem o salvo, o CSOSN numa empresa do regime normal é recusado");
    expect(sem.recusas[0].code).toBe("TRIBUTACAO_REGIME_INCOMPATIVEL");
    const com = aplicarOverrideTributacao({ base, override: salvo, salvo, crtEmitente: "3", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (!com.ok) throw new Error(com.erros.join("; "));
    expect(com.tributacao.icms).toMatchObject({ tag: "ICMSSN900", csosn: "900", cst: null, pICMS: 12 });
    expect(tagCompativelComCrt(com.tributacao.icms.tag!, "3")).toBe(false);
  });
});

describe("N-icms-residual-4 — só o modBC que vem EXPLÍCITO é julgado", () => {
  // ICMS00 da nota original com modBC 0 (margem de valor agregado).
  const base = proporcionalizar({
    impostoOriginal: normalizarImpostoOriginal({ ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "0", vBC: "10", pICMS: "18", vICMS: "1.80" } }, PIS: { PISNT: { CST: "04" } }, COFINS: { COFINSNT: { CST: "04" } } }),
    qOriginal: 1, qDevolvida: 1, vUnCom: 10, crtEmitente: "3", crtOriginal: "3",
  });

  it("trocar para 90 sem mandar modBC: aceito, com modBC 3 (antes o 0 herdado do XML recusava toda troca)", () => {
    expect(base.icms.modBC).toBe("0");
    const r = aplicarOverrideTributacao({ base, override: { icms: { cst: "90", csosn: null, pICMS: 18 } }, crtEmitente: "3", baseCalculoItem: 10 });
    if (!r.ok) throw new Error(r.erros.join("; "));
    expect(r.tributacao.icms).toMatchObject({ tag: "ICMS90", cst: "90", modBC: "3", vBC: 10, pICMS: 18, vICMS: 1.8 });
  });

  it("modBC 0 mandado explicitamente continua recusado; igual ao salvo, não", () => {
    const explicito = aplicarOverrideTributacao({ base, override: { icms: { cst: "90", csosn: null, modBC: "0", pICMS: 18 } }, crtEmitente: "3", baseCalculoItem: 10 });
    expect(explicito.ok).toBe(false);
    const doSalvo = aplicarOverrideTributacao({
      base, override: { icms: { cst: "90", csosn: null, modBC: "0", pICMS: 18 } },
      salvo: { icms: { cst: "00", csosn: null, modBC: "0", pICMS: 18 } },
      crtEmitente: "3", baseCalculoItem: 10,
    });
    if (!doSalvo.ok) throw new Error(doSalvo.erros.join("; "));
    expect(doSalvo.tributacao.icms.modBC).toBe("3");
  });
});

// ───────────────────────────── validação: textos e avisos novos ─────────────────────────────

describe("validação — frases por tipo, saldo zerado e outra devolução em envio", () => {
  it("ESCOLHA_PENDENTE na devolução de compra fala do FORNECEDOR, não do cliente", () => {
    const ctx = ctxCompra(bom());
    ctx.cabecalho!.devolvidaAposEntrega = null;
    const [i] = validarDevolucao(ctx);
    expect(i.code).toBe("ESCOLHA_PENDENTE");
    expect(i.mensagem).toContain("fornecedor");
    expect(i.mensagem).not.toContain("cliente");
  });

  it("RECUSA na devolução de compra não manda para nota de crédito: manda para a contadora", () => {
    const ctx = ctxCompra(bom());
    ctx.cabecalho!.devolvidaAposEntrega = false;
    const [i] = validarDevolucao(ctx);
    expect(i.code).toBe("RECUSA_NAO_E_DEVOLUCAO");
    expect(i.mensagem).not.toContain("nota de crédito");
    expect(i.mensagem).not.toContain("finNFe 5");
    expect(i.mensagem).toContain("contadora");
  });

  it("SALDO_EXCEDIDO com nada disponível manda TIRAR o item (e diz onde está o resto)", () => {
    const ctx = ctxCompra(bom());
    ctx.saldos = [{ chaveAcesso: CHAVE_COMPRA, nItem: 5, disponivel: 0, devolvidaAutorizada: 1, emProcessamento: 0 }];
    const i = validarDevolucao(ctx).find((x) => x.code === "SALDO_EXCEDIDO")!;
    expect(i).toMatchObject({ severidade: "ERRO", ordem: 1 });
    expect(i.mensagem).toContain("33603-3 (item 5 da nota original)");
    expect(i.mensagem).toContain("Tire o item desta devolução");
    expect(i.mensagem).toContain("já devolvido em NF-e autorizada");
    expect(i.mensagem).not.toContain("baixe");
    // Com saldo, diz quanto sobrou.
    ctx.saldos = [{ chaveAcesso: CHAVE_COMPRA, nItem: 5, disponivel: 0.5 }];
    expect(validarDevolucao(ctx).find((x) => x.code === "SALDO_EXCEDIDO")!.mensagem).toContain("que é 0,5");
  });

  it("OUTRA devolução do mesmo item em envio → AVISO próprio (não o 'desta devolução')", () => {
    const ctx = ctxCompra(bom());
    ctx.saldos = [{ chaveAcesso: CHAVE_COMPRA, nItem: 5, disponivel: 1, emProcessamento: 2 }];
    const issues = validarDevolucao(ctx);
    expect(codigos(issues)).toEqual(["OUTRA_DEVOLUCAO_EM_ENVIO"]);
    expect(issues[0]).toMatchObject({ severidade: "AVISO", ordem: 1 });
    expect(issues[0].mensagem).toContain("2 em envio");
    // Sem nada em envio (ou sem o campo): nada.
    ctx.saldos = [{ chaveAcesso: CHAVE_COMPRA, nItem: 5, disponivel: 1, emProcessamento: 0 }];
    expect(validarDevolucao(ctx)).toEqual([]);
  });
});

// ───────────────────────────── catálogo de pendências ─────────────────────────────

const texto = (code: string, tipo?: string) => {
  const [p] = pendenciasDeIssues([{ code, severidade: "ERRO", ordem: 2, mensagem: `Item 2: ${code}.` }], tipo);
  return p;
};

describe("catálogo de pendências — o texto manda fazer o que a tela TEM", () => {
  it("as duas opções do passo 1 citadas são, letra por letra, as da tela (rádio)", () => {
    expect(OPCAO_ENTREGUE_VENDA).toBe(perguntaEntrega("VENDA_ENTRADA").sim);
    expect(OPCAO_ENTREGUE_COMPRA).toBe(perguntaEntrega("COMPRA_SAIDA").sim);
  });

  it("ESCOLHA_PENDENTE e RECUSA: por tipo, com a opção exata; ninguém manda 'marcar'; sem nota de crédito", () => {
    for (const code of ["ESCOLHA_PENDENTE", "RECUSA_NAO_E_DEVOLUCAO"]) {
      const venda = texto(code, "VENDA_ENTRADA");
      const compra = texto(code, "COMPRA_SAIDA");
      const neutro = texto(code);
      expect(venda.comoResolver).toContain(`"${OPCAO_ENTREGUE_VENDA}"`);
      expect(compra.comoResolver).toContain(`"${OPCAO_ENTREGUE_COMPRA}"`);
      expect(neutro.comoResolver).toContain('"A mercadoria foi entregue e está sendo devolvida"');
      for (const p of [venda, compra, neutro]) {
        expect(`${p.titulo} ${p.comoResolver}`).not.toMatch(/\bmarque\b/i);
        expect(p.comoResolver).not.toContain("nota de crédito");
        expect(p.comoResolver).toContain("escolha a opção");
      }
      expect(`${compra.titulo} ${compra.comoResolver}`).not.toContain("cliente");
    }
    expect(texto("ESCOLHA_PENDENTE", "COMPRA_SAIDA").titulo).toContain("fornecedor");
    expect(texto("RECUSA_NAO_E_DEVOLUCAO", "COMPRA_SAIDA").comoResolver).toContain("contadora");
  });

  it("o editor usa o tipo do detalhe sem mudar nada nele (viewPendenciasDoDetalhe lê detalhe.tipo)", () => {
    const view = viewPendenciasDoDetalhe({
      tipo: "COMPRA_SAIDA", podeEmitir: false,
      issues: [{ code: "ESCOLHA_PENDENTE", severidade: "ERRO", mensagem: "x" }],
    });
    expect(view.bloqueios[0].comoResolver).toContain(OPCAO_ENTREGUE_COMPRA);
  });

  it("ICMS e PIS/COFINS são seletores: nada de 'digite N dígitos'; os rótulos citados existem", () => {
    const todos = [
      "TRIBUTACAO_NAO_SUPORTADA", "TRIBUTACAO_REGIME_INCOMPATIVEL", "PIS_COFINS_NAO_SUPORTADO",
      "PIS_COFINS_REGIME_INCOMPATIVEL", "PIS_COFINS_ALIQUOTA_SIMPLES", "PIS_CST_ENTRADA_EM_SAIDA",
      "CFOP_ESCOLHA_PENDENTE", "CFOP_NAO_DEVOLUCAO",
    ].map((c) => texto(c));
    for (const p of todos) {
      expect(p.comoResolver, p.codigo!).not.toMatch(/\(\d dígitos\)|4 dígitos|preencha o CFOP/);
    }
    for (const c of ["PIS_COFINS_NAO_SUPORTADO", "PIS_COFINS_REGIME_INCOMPATIVEL", "PIS_CST_ENTRADA_EM_SAIDA"]) {
      expect(texto(c).comoResolver).toContain(`"${rotuloCampoPisCofins("pis")}"`);
      expect(texto(c).comoResolver).toContain(`"${rotuloCampoPisCofins("cofins")}"`);
    }
    expect(texto("TRIBUTACAO_NAO_SUPORTADA").comoResolver).toContain("escolha na lista o código do ICMS");
  });

  it("o crédito aparece na recusa de regime; a de sentido diz que impede e cita o 99", () => {
    expect(texto("PIS_COFINS_REGIME_INCOMPATIVEL").comoResolver).toContain("50 a 56 e 60 a 67");
    const s = texto("PIS_CST_ENTRADA_EM_SAIDA");
    expect(s.comoResolver).not.toContain("não impede");
    expect(s.comoResolver).toContain("o 99 serve");
  });

  it("alíquota no Simples: título e caminho próprios (não o de '01/02 a zero')", () => {
    const p = texto("PIS_COFINS_ALIQUOTA_SIMPLES");
    expect(p.titulo).toBe("O PIS/COFINS está com alíquota no item 2, e no Simples Nacional a alíquota na nota fica 0");
    expect(p.comoResolver).toContain("guia do Simples");
    expect(p.comoResolver).not.toContain("06");
  });

  it("IPI devolvido aponta a QUANTIDADE no passo 3 — não um campo de IPI no passo 8, que não existe", () => {
    const p = texto("IPI_DEVOL_INVALIDO");
    expect(p.comoResolver).toContain('passo 3 ("Produtos")');
    expect(p.comoResolver).not.toContain("passo 8");
  });

  it("ST e saldo zerado citam o botão 'Tirar desta devolução' pelo rótulo exato", () => {
    expect(texto("ICMS_ST_NAO_DEVOLVIDO").comoResolver).toContain(`"${TIRAR_DA_DEVOLUCAO}"`);
    expect(texto("ICMS_ST_NAO_DEVOLVIDO").comoResolver).not.toContain("pondo a quantidade zero");
    expect(texto("SALDO_EXCEDIDO").comoResolver).toContain(`"${TIRAR_DA_DEVOLUCAO}"`);
    expect(texto("SALDO_EXCEDIDO").comoResolver).toContain('"Disponível para devolver"');
  });

  it("outra devolução em envio: cita o item (no singular e no plural) e diz que não impede", () => {
    const [p] = pendenciasDeIssues([{ code: "OUTRA_DEVOLUCAO_EM_ENVIO", severidade: "AVISO", ordem: 3, mensagem: "Item 3: x" }]);
    expect(p.titulo).toBe("Outra devolução, que está sendo enviada à SEFAZ, também inclui o item 3");
    expect(p.comoResolver).toContain("não impede");
    // Plural: "Os itens 3 e 4 também está…" errava a concordância.
    const [dois] = pendenciasDeIssues([
      { code: "OUTRA_DEVOLUCAO_EM_ENVIO", severidade: "AVISO", ordem: 3, mensagem: "Item 3: x" },
      { code: "OUTRA_DEVOLUCAO_EM_ENVIO", severidade: "AVISO", ordem: 4, mensagem: "Item 4: x" },
    ]);
    expect(dois.titulo).toBe("Outra devolução, que está sendo enviada à SEFAZ, também inclui os itens 3 e 4");
  });

  it("os códigos novos falam com a dona do desmanche: nada de jargão de sistema", () => {
    for (const code of ["PIS_COFINS_ALIQUOTA_SIMPLES", "OUTRA_DEVOLUCAO_EM_ENVIO"]) {
      const p = texto(code);
      expect(p.codigo).toBe(code);
      expect(p.titulo).not.toContain(code);
      for (const jargao of ["escopo", "gerenciada", "issue", "payload", "override", "tpnf", "crt"]) {
        expect(`${p.titulo} ${p.comoResolver}`.toLowerCase(), `${code}/${jargao}`).not.toContain(jargao);
      }
    }
  });
});

// ───────────────────────────── contrato e tela do rascunho feito à mão ─────────────────────────────

describe("contrato — frases e códigos novos", () => {
  it("DEVOLUCAO_NAO_GERENCIADA diz o que é, sem jargão", () => {
    expect(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_NAO_GERENCIADA).toBe("Este rascunho não está ligado a nenhuma nota original.");
    expect(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_NAO_GERENCIADA).not.toContain("gerenciada");
  });

  it("ORIGINAL_TEM_XML_NO_DEXO: 409, manda pela própria nota (botões que existem na lista)", () => {
    expect(DEVOLUCAO_ERRO_HTTP.ORIGINAL_TEM_XML_NO_DEXO).toBe(409);
    expect(DEVOLUCAO_ERRO_MENSAGEM.ORIGINAL_TEM_XML_NO_DEXO).toContain('"Notas Emitidas"');
    expect(DEVOLUCAO_ERRO_MENSAGEM.ORIGINAL_TEM_XML_NO_DEXO).toContain('"Devolver total"');
    // Não é "permanente" na tela do cálculo (não é o caso do rascunho feito à mão).
    expect(viewErroCalculo({ code: "ORIGINAL_TEM_XML_NO_DEXO", error: "x" }).permanente).toBe(false);
  });

  it("a resposta da criação lê o escopo quando vem (e só um escopo válido)", () => {
    expect(parseCriarDevolucaoResposta({ draftId: "d1", reutilizado: true, escopo: "PARCIAL" })).toEqual({ ok: true, value: { draftId: "d1", reutilizado: true, escopo: "PARCIAL" } });
    expect(parseCriarDevolucaoResposta({ draftId: "d1", reutilizado: false })).toEqual({ ok: true, value: { draftId: "d1", reutilizado: false } });
    expect(parseCriarDevolucaoResposta({ draftId: "d1", escopo: "TUDO" })).toEqual({ ok: true, value: { draftId: "d1", reutilizado: false } });
  });

  it("rascunho feito à mão: o último passo diz ONDE descartar, com os rótulos da tela", () => {
    const { passos } = viewErroCalculo({ code: "DEVOLUCAO_NAO_GERENCIADA", error: "x" });
    const ultimo = passos[passos.length - 1];
    expect(ultimo).toContain(`"Notas Emitidas" › "${TITULO_DEVOLUCOES_EM_ANDAMENTO}"`);
    expect(ultimo).toContain(`"${ROTULO_DESCARTAR}"`);
  });
});

// ───────────────────────────── CFOP ─────────────────────────────

describe("catálogo de CFOP — todo CFOP de devolução tem nome", () => {
  it("nenhum CFOP que a devolução aceita cai no 'CFOP de devolução' genérico", () => {
    for (const c of [...CFOPS_DEVOLUCAO, ...EXCECAO_1949_2949]) {
      expect(findCfop(c), `CFOP ${c} sem nome no catálogo`).toBeDefined();
      expect(rotuloCfop(c)).not.toBe(`${c} — CFOP de devolução`);
    }
  });

  it("os 20 que faltavam, com o texto da tabela oficial (Ajustes SINIEF 5/2016, 18/2017 e 7/2019)", () => {
    expect(findCfop("5213")?.descricao).toBe("Devolução de entrada de mercadoria com previsão de posterior ajuste ou fixação de preço, em ato cooperativo");
    expect(findCfop("6216")?.descricao).toBe("Devolução de entrada decorrente do fornecimento de produto ou mercadoria de ato cooperativo");
    expect(findCfop("1215")?.descricao).toBe("Devolução de fornecimento de produção do estabelecimento de ato cooperativo");
    expect(findCfop("2212")?.descricao).toContain("(Recof-Sped)");
    expect(findCfop("3212")?.descricao).toContain("mercado externo");
    expect(findCfop("7212")?.descricao).toContain("Devolução de compras para industrialização");
    for (const c of ["1212", "1213", "1214", "1215", "1216", "2212", "2213", "2214", "2215", "2216", "3212"]) expect(findCfop(c)?.tipo).toBe("ENTRADA");
    for (const c of ["5213", "5214", "5215", "5216", "6213", "6214", "6215", "6216", "7212"]) expect(findCfop(c)?.tipo).toBe("SAIDA");
  });
});

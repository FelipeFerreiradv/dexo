/**
 * Ensaio seco da 1ª devolução da DLS, preso em teste (N-xml-emissao-5).
 *
 * O achado montou o XML da devolução de compra à DISAUTO pelo caminho real e
 * conferiu as regras que a SEFAZ aplica (o repo não versiona o XSD). O ensaio
 * foi apagado depois — este teste é o que fica: a devolução de compra do
 * Simples com CSOSN 900 a 12% (o ICMS da compra, Res. CGSN 140/2018 art. 59) e
 * PIS/COFINS 49 sai com a estrutura e os totais que o ensaio conferiu, nos dois
 * modos de referência (NOTA e ITEM). Estrutural, não byte a byte: o que se
 * prende são as regras de rejeição, não a formatação.
 */
import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";

import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";
import { CHAVE_ORIGINAL, CNF_FIXO, DH_EMI_FIXO } from "../golden/__fixtures__/casos-emissao";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { calcularDevolucao, totaisDevolucao, type ContextoEmissaoDevolucao } from "../../../app/fiscal/devolucao/emissao";
import { aplicarOverrideTributacao, normalizarImpostoOriginal, proporcionalizar } from "../../../app/fiscal/devolucao/tributacao";

const ITENS_DISAUTO = [
  {
    nItem: 5, codigo: "33603-3", vUn: 123.56,
    imposto: {
      ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
      PIS: { PISAliq: { CST: "01", vBC: "108.73", pPIS: "1.65", vPIS: "1.79" } },
      COFINS: { COFINSAliq: { CST: "01", vBC: "108.73", pCOFINS: "7.60", vCOFINS: "8.26" } },
    },
  },
  {
    nItem: 6, codigo: "24171-7", vUn: 295.88,
    imposto: {
      ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "295.88", pICMS: "12.00", vICMS: "35.51" } },
      PIS: { PISNT: { CST: "04" } },
      COFINS: { COFINSNT: { CST: "04" } },
    },
  },
];

function tributacoes() {
  return ITENS_DISAUTO.map((i) => {
    const base = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(i.imposto), qOriginal: 1, qDevolvida: 1, vUnCom: i.vUn,
      crtEmitente: "1", crtOriginal: "3", tipoOperacao: "SAIDA",
    });
    const r = aplicarOverrideTributacao({
      base, override: { icms: { csosn: "900", cst: null, pICMS: 12 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } },
      confirmar: true, crtEmitente: "1", baseCalculoItem: i.vUn, tipoOperacao: "SAIDA",
    });
    if (!r.ok) throw new Error(r.erros.join("; "));
    return r.tributacao;
  });
}

function montar(modo: "NOTA" | "ITEM") {
  const ts = tributacoes();
  const ctx: ContextoEmissaoDevolucao = {
    modoReferencia: modo, indFinal: "0",
    refs: ts.map((t, k) => ({ ordem: k + 1, chaveAcessoOriginal: CHAVE_ORIGINAL, nItemOriginal: ITENS_DISAUTO[k].nItem, tributacao: t })),
  };
  const draft = calcularDevolucao(
    makeDraft({
      finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA", naturezaOperacao: "DEVOLUCAO DE COMPRA",
      destinoOperacao: "INTERNA",
      destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: "80689839000975", nome: "DISAUTO", inscricaoEstadual: "258272414", uf: "SP", municipio: "SAO PAULO", codMunicipio: "3550308", logradouro: "RUA A", numero: "1", bairro: "CENTRO", cep: "01000000" },
      itens: ITENS_DISAUTO.map((i, k) => makeItem({ id: `i${k}`, numero: k + 1, codigo: i.codigo, cfop: "5202", valorUnitario: i.vUn, valorTotal: i.vUn, quantidade: 1 })),
    } as never),
    ctx,
  );
  const built = new NfeXmlBuilderSefazService().build({ draft, config: makeConfig(), numero: 716, cNF: CNF_FIXO, dhEmi: DH_EMI_FIXO, devolucao: ctx });
  const nfe = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(built.xml).NFe.infNFe;
  return { nfe, draft, ts };
}

const lista = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

describe.each(["NOTA", "ITEM"] as const)("devolução de compra da DLS (Simples → DISAUTO), referência %s", (modo) => {
  it("identificação: finNFe 4, saída, interna, consumidor não final, sem pagamento (tPag 90)", () => {
    const { nfe } = montar(modo);
    expect(nfe.ide.finNFe).toBe("4");
    expect(nfe.ide.tpNF).toBe("1");
    expect(nfe.ide.idDest).toBe("1");
    expect(nfe.ide.indFinal).toBe("0");
    expect(nfe.emit.CRT).toBe("1");
    expect(nfe.dest.indIEDest).toBe("1");
    expect(nfe.pag.detPag.tPag).toBe("90");
    expect(nfe.pag.detPag.vPag).toBe("0.00");
    expect(nfe.cobr).toBeUndefined();
  });

  it("itens: CFOP 5202, ICMSSN900 com a base e o ICMS da compra, PIS/COFINS 49 zerados", () => {
    const { nfe } = montar(modo);
    const dets = lista(nfe.det);
    expect(dets).toHaveLength(2);
    expect(dets.map((d) => d.prod.CFOP)).toEqual(["5202", "5202"]);
    expect(dets.map((d) => d.imposto.ICMS.ICMSSN900.CSOSN)).toEqual(["900", "900"]);
    expect(dets.map((d) => d.imposto.ICMS.ICMSSN900.vICMS)).toEqual(["14.83", "35.51"]);
    for (const d of dets) {
      expect(d.imposto.ICMS.ICMSSN900.pICMS).toBe("12.00");
      expect(d.imposto.PIS.PISOutr.CST).toBe("49");
      expect(d.imposto.PIS.PISOutr.vPIS).toBe("0.00");
      expect(d.imposto.COFINS.COFINSOutr.CST).toBe("49");
      expect(d.imposto.COFINS.COFINSOutr.vCOFINS).toBe("0.00");
    }
    if (modo === "ITEM") {
      expect(dets.map((d) => d.DFeReferenciado.nItem)).toEqual(["5", "6"]);
      expect(nfe.ide.NFref).toBeUndefined();
    } else {
      expect(nfe.ide.NFref.refNFe).toBe(CHAVE_ORIGINAL);
      expect(dets.every((d) => d.DFeReferenciado === undefined)).toBe(true);
    }
  });

  it("totais fecham (531/532/564/602/603/610) e são os mesmos que a tela mostra antes de emitir", () => {
    const { nfe, draft, ts } = montar(modo);
    const tot = nfe.total.ICMSTot;
    expect(tot.vBC).toBe("419.44");
    expect(tot.vICMS).toBe("50.34");
    expect(tot.vPIS).toBe("0.00");
    expect(tot.vCOFINS).toBe("0.00");
    expect(tot.vST).toBe("0.00");
    expect(tot.vIPIDevol).toBe("0.00");
    expect(tot.vProd).toBe("419.44");
    expect(tot.vNF).toBe("419.44");
    const tela = totaisDevolucao({ itens: draft.itens, refs: ts.map((t, k) => ({ ordem: k + 1, tributacao: t })) });
    expect(tela).toMatchObject({ totalIcms: 50.34, totalBcIcms: 419.44, totalNota: 419.44, completo: true });
    expect(tela.totalNota.toFixed(2)).toBe(tot.vNF);
    expect(tela.totalIcms.toFixed(2)).toBe(tot.vICMS);
  });
});

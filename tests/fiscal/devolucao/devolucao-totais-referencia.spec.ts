/**
 * Os VALORES da devolução, visíveis ANTES de emitir (DLS AUTO PEÇAS, 24/09/2026).
 *
 * O "Revisei a tributação" confirmava números que ela nunca viu: o passo 8
 * mostrava só códigos, e o passo 9 mostrava só o total dos produtos — com IPI
 * devolvido, o valor da nota (vNF) é outro. Dois contratos novos:
 *  - `totaisDevolucao`: a MESMA conta de `calcularDevolucao` (o número da tela
 *    é o do XML), sem lançar com tributação incompleta;
 *  - `referenciaImpostoOriginal`: o imposto da nota original na proporção
 *    devolvida, com a frase pronta ("Na nota do fornecedor: CST 00 · base
 *    R$ 123,56 · 12% · ICMS R$ 14,83").
 * E a defesa em profundidade da emissão: PIS/COFINS sem código e ICMS-ST da
 * original não chegam ao montador nem à Focus.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeConfig, makeDraft } from "../__helpers__/test-draft";
import { NfeXmlBuilderService } from "../../../app/fiscal/generators/nfe-xml-builder.service";
import {
  calcularDevolucao,
  decorarFocusDevolucao,
  totaisDevolucao,
  tributacaoEmitivel,
  type ContextoEmissaoDevolucao,
} from "../../../app/fiscal/devolucao/emissao";
import { normalizarImpostoOriginal, reais, referenciaImpostoOriginal } from "../../../app/fiscal/devolucao/tributacao";
import type { TributacaoDevolucaoItem } from "../../../app/fiscal/devolucao/tipos";

afterEach(() => { vi.unstubAllEnvs(); });

function trib(over: Partial<TributacaoDevolucaoItem> = {}): TributacaoDevolucaoItem {
  return {
    versao: 1, fonte: "USUARIO",
    icms: { tag: "ICMSSN900", cst: null, csosn: "900", orig: 0, modBC: "3", vBC: 100, pICMS: 12, vICMS: 12 },
    pis: { cst: "49", vBC: 0, p: 0, v: 0 },
    cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
    ipiDevol: null, requerRevisao: true, confirmada: true, motivosRevisao: [], avisos: [],
    ...over,
  };
}

const CHAVE = "42260980689839000975550010008528991757991829";
const ctx = (ts: TributacaoDevolucaoItem[]): ContextoEmissaoDevolucao => ({
  modoReferencia: "NOTA", indFinal: "0",
  refs: ts.map((t, i) => ({ ordem: i + 1, chaveAcessoOriginal: CHAVE, nItemOriginal: i + 5, tributacao: t })),
});

describe("totaisDevolucao — o número da tela é o do XML", () => {
  it("bate com o totaisJson de calcularDevolucao (desconto, frete e IPI devolvido)", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
    const ts = [
      trib({ ipiDevol: { pDevol: 50, vIPIDevol: 5.2 } }),
      trib({ icms: { tag: "ICMSSN900", cst: null, csosn: "900", orig: 0, modBC: "3", vBC: 295.88, pICMS: 12, vICMS: 35.51 }, pis: { cst: "49", vBC: 10, p: 1.65, v: 0.17 } }),
    ];
    const draft = makeDraft({
      valorFrete: 12.5,
      itens: [
        { ...makeDraft().itens[0], numero: 1, valorUnitario: 123.56, valorTotal: 123.56, desconto: 0 },
        { ...makeDraft().itens[0], numero: 2, valorUnitario: 295.88, valorTotal: 295.88, desconto: 4 },
      ],
    } as never);
    const emitida = calcularDevolucao(draft, ctx(ts)).totaisJson!;
    const tela = totaisDevolucao({ itens: draft.itens, refs: ctx(ts).refs, valorFrete: draft.valorFrete });
    expect(tela).toEqual({
      totalProdutos: 419.44, totalDesconto: 4, totalFrete: 12.5,
      totalBcIcms: 395.88, totalIcms: 47.51, totalPis: 0.17, totalCofins: 0, totalIpiDevol: 5.2,
      totalNota: 433.14, completo: true, itensPendentes: [],
    });
    for (const k of ["totalProdutos", "totalDesconto", "totalFrete", "totalNota", "totalBcIcms", "totalIcms", "totalPis", "totalCofins"] as const) {
      expect(tela[k], k).toBe((emitida as unknown as Record<string, number>)[k]);
    }
    // O totaisJson da emissão NÃO ganhou chave nova (o DANFE do banco lê o que existe).
    expect(Object.keys(emitida)).toEqual([
      "totalProdutos", "totalDesconto", "totalFrete", "totalNota", "totalBcIcms", "totalIcms",
      "totalBcIpi", "totalIpi", "totalPis", "totalCofins", "totalTributos",
    ]);
  });

  it("com frete desligado, o frete não conta (a mesma regra da emissão)", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "false");
    const t = totaisDevolucao({ itens: [{ valorTotal: 100 }], refs: ctx([trib()]).refs, valorFrete: 40 });
    expect(t.totalFrete).toBe(0);
    expect(t.totalNota).toBe(100);
  });

  it("não lança com tributação incompleta: soma o gravado e marca a prévia", () => {
    const refs = [
      { ordem: 1, tributacao: trib() },
      { ordem: 2, tributacao: trib({ confirmada: false }) },
      { ordem: 3, tributacao: trib({ pis: { cst: null, vBC: 0, p: 0, v: 0 } }) },
      { ordem: 4, tributacao: trib({ motivosRevisao: ["ICMS_ST_NAO_SUPORTADO"] }) },
      { ordem: 5, tributacao: null },
    ];
    const t = totaisDevolucao({ itens: [1, 2, 3, 4, 5].map(() => ({ valorTotal: 100 })), refs });
    expect(t.completo).toBe(false);
    expect(t.itensPendentes).toEqual([2, 3, 4, 5]);
    expect(t.totalIcms).toBe(48);
    expect(t.totalNota).toBe(500);
  });
});

describe("emissão: PIS/COFINS sem código e ICMS-ST não passam do calcularDevolucao", () => {
  it("PIS sem CST (confirmado) lança — o montador trocaria em silêncio pelo padrão do regime", () => {
    const c = ctx([trib({ pis: { cst: null, vBC: 0, p: 0, v: 0 } })]);
    expect(() => calcularDevolucao(makeDraft(), c)).toThrow("incompleta");
    expect(tributacaoEmitivel(c.refs[0].tributacao)).toBe(false);
  });

  it("COFINS 03 lança (cairia em COFINSOutr: Rejeição 225)", () => {
    expect(() => calcularDevolucao(makeDraft(), ctx([trib({ cofins: { cst: "03", vBC: 0, p: 0, v: 0 } })]))).toThrow("incompleta");
  });

  it("ICMS-ST na original (motivo gravado) lança mesmo confirmado", () => {
    expect(() => calcularDevolucao(makeDraft(), ctx([trib({ motivosRevisao: ["ICMS_ST_NAO_SUPORTADO"] })]))).toThrow("incompleta");
  });

  it("a Focus nunca recebe pis_situacao_tributaria null", () => {
    const bom = ctx([trib()]);
    const payload = new NfeXmlBuilderService().build(calcularDevolucao(makeDraft(), bom), makeConfig(), 1);
    expect(() => decorarFocusDevolucao(payload, bom)).not.toThrow();
    const ruim = ctx([trib({ pis: { cst: null, vBC: 0, p: 0, v: 0 } })]);
    expect(() => decorarFocusDevolucao(payload, ruim)).toThrow("incompleta");
  });
});

describe("referenciaImpostoOriginal — o imposto da nota original, visível", () => {
  const ITEM5 = normalizarImpostoOriginal({
    ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
    PIS: { PISAliq: { CST: "01", vBC: "108.73", pPIS: "1.65", vPIS: "1.79" } },
    COFINS: { COFINSAliq: { CST: "01", vBC: "108.73", pCOFINS: "7.60", vCOFINS: "8.26" } },
  });

  it("DLS item 5 (devolução integral): a frase do fornecedor com base, alíquota e valor", () => {
    const r = referenciaImpostoOriginal({ impostoOriginal: ITEM5, quantidadeOriginal: 1, quantidade: 1, tipo: "COMPRA_SAIDA" })!;
    expect(r.deQuem).toBe("FORNECEDOR");
    expect(r.proporcional).toBe(true);
    expect(r.icms).toEqual({ codigo: "00", tipo: "CST", vBC: 123.56, pICMS: 12, vICMS: 14.83, vBCST: 0, vICMSST: 0 });
    expect(r.frases.icms).toBe("Na nota do fornecedor: CST 00 · base R$ 123,56 · 12% · ICMS R$ 14,83.");
    expect(r.frases.pis).toBe("Na nota do fornecedor: PIS CST 01 · base R$ 108,73 · 1,65% · R$ 1,79.");
    expect(r.frases.cofins).toBe("Na nota do fornecedor: COFINS CST 01 · base R$ 108,73 · 7,6% · R$ 8,26.");
    expect(r.frases.ipi).toBe("");
  });

  it("parcial (1 de 3, com ST): na proporção, e diz a proporção", () => {
    const lubrax = normalizarImpostoOriginal({
      ICMS: { ICMS10: { orig: "0", CST: "10", modBC: "3", vBC: "117.45", pICMS: "12.00", vICMS: "14.09", vBCST: "200.87", vICMSST: "20.05" } },
      IPI: { cEnq: "999", IPITrib: { CST: "50", vBC: "117.45", pIPI: "5.00", vIPI: "5.87" } },
    });
    const r = referenciaImpostoOriginal({ impostoOriginal: lubrax, quantidadeOriginal: 3, quantidade: 1, tipo: "COMPRA_SAIDA" })!;
    expect(r.icms?.vICMSST).toBe(6.68);
    expect(r.frases.icms).toBe("Na nota do fornecedor: CST 10 · base R$ 39,15 · 12% · ICMS R$ 4,70 · ICMS-ST R$ 6,68 (na proporção de 1 de 3).");
    expect(r.frases.ipi).toBe("Na nota do fornecedor: IPI 5% · R$ 1,96 (na proporção de 1 de 3).");
    expect(r.pis).toBeNull();
    expect(r.frases.pis).toBe("");
  });

  it("devolução de venda fala da SUA nota; sem XML não há referência; quantidade desconhecida avisa", () => {
    const venda = referenciaImpostoOriginal({ impostoOriginal: ITEM5, quantidadeOriginal: 1, quantidade: 1, tipo: "VENDA_ENTRADA" })!;
    expect(venda.deQuem).toBe("PROPRIA");
    expect(venda.frases.icms.startsWith("Na sua nota de venda:")).toBe(true);
    expect(referenciaImpostoOriginal({ impostoOriginal: null, quantidadeOriginal: null, quantidade: 1, tipo: "COMPRA_SAIDA" })).toBeNull();
    const semQ = referenciaImpostoOriginal({ impostoOriginal: ITEM5, quantidadeOriginal: null, quantidade: 1, tipo: "COMPRA_SAIDA" })!;
    expect(semQ.proporcional).toBe(false);
    expect(semQ.frases.icms).toContain("linha inteira da nota");
  });

  it("reais() formata sem depender do ICU", () => {
    expect(reais(1234.5)).toBe("R$ 1.234,50");
    expect(reais(0)).toBe("R$ 0,00");
    expect(reais(1234567.891)).toBe("R$ 1.234.567,89");
    expect(reais(-2.5)).toBe("-R$ 2,50");
  });
});

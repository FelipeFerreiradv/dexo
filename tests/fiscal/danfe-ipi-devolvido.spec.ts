import { afterEach, describe, expect, it, vi } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  DanfePdfService,
} from "../../app/fiscal/generators/danfe-pdf.service";
import { renderDanfeOficial } from "../../app/fiscal/generators/danfe-oficial-renderer";
import {
  infCplComIpiDevolvido,
  lerTotalIpiDevolDoXml,
  totalIpiDevolDosTotais,
} from "../../app/fiscal/generators/danfe-render-extras";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { calcularDevolucao, type ContextoEmissaoDevolucao } from "../../app/fiscal/devolucao/emissao";
import type { TributacaoDevolucaoItem } from "../../app/fiscal/devolucao/tipos";
import { CHAVE_ORIGINAL, CNF_FIXO, DH_EMI_FIXO } from "./golden/__fixtures__/casos-emissao";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

// Achado N-completude-7 da auditoria da devolucao: o builder grava
// <ICMSTot><vIPIDevol> e o soma ao vNF (regra W16), mas o DANFE nao o lia.
// Resultado: "VALOR TOTAL DO IPI 0,00" e um "VALOR TOTAL DA NOTA" maior que a
// soma das parcelas impressas, sem nada explicando a diferenca.
//
// O leiaute do DANFE nao tem campo para o vIPIDevol; a orientacao do ENCAT
// (NT 2016.002) e cita-lo em INFORMACOES COMPLEMENTARES. Somar ao campo do IPI
// faria o DANFE contradizer o <vIPI> do XML. Estes testes LEEM o texto
// desenhado no PDF e conferem que os totais impressos fecham com o XML.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Leitura do texto desenhado no PDF ──
// pdf-lib desenha com as StandardFonts em WinAnsi e escreve cada drawText como
// `<hex> Tj` no content stream (comprimido). Descomprimir e decodificar o hex
// devolve as strings NA ORDEM em que foram desenhadas: numa linha de campos do
// DANFE, o rotulo vem imediatamente antes do valor.
async function textosDoPdf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams: unknown[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) streams.push(doc.context.lookup(contents.get(i)));
    } else if (contents) {
      streams.push(contents);
    }
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const raw = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
        out.push(Buffer.from(m[1], "hex").toString("latin1"));
      }
    }
  }
  return out;
}

/** Valor desenhado logo depois do rotulo, a partir do quadro indicado. */
function valorApos(textos: string[], rotulo: string, aPartirDe = "CÁLCULO DO IMPOSTO"): string {
  const ini = textos.indexOf(aPartirDe);
  expect(ini, `faixa "${aPartirDe}" nao desenhada`).toBeGreaterThanOrEqual(0);
  const i = textos.indexOf(rotulo, ini);
  expect(i, `rotulo "${rotulo}" nao desenhado`).toBeGreaterThan(ini);
  return textos[i + 1];
}

/** "1.234,56" → 123456 (centavos). */
function centavosBR(s: string): number {
  expect(s).toMatch(/^-?\d{1,3}(\.\d{3})*,\d{2}$/);
  return Math.round(Number(s.replace(/\./g, "").replace(",", ".")) * 100);
}

/** "1234.56" (XML) → 123456 (centavos). */
function centavosXml(s: unknown): number {
  return Math.round(Number(s ?? 0) * 100);
}

const LINHA_IPI_DEVOL = /^Valor do IPI devolvido: R\$ (\d{1,3}(?:\.\d{3})*,\d{2}) \(já somado ao valor total da nota\)$/;

// ── Montagem de uma devolucao REAL pelo builder SEFAZ ──

function tributacao(ipiDevol: TributacaoDevolucaoItem["ipiDevol"]): TributacaoDevolucaoItem {
  return {
    versao: 1,
    fonte: "USUARIO",
    icms: { tag: "ICMSSN900", cst: null, csosn: "900", orig: 0, modBC: "3", vBC: 100, pICMS: 12, vICMS: 12 },
    pis: { cst: "49", vBC: 0, p: 0, v: 0 },
    cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
    ipiDevol,
    requerRevisao: true,
    confirmada: true,
    motivosRevisao: [],
    avisos: [],
  } as TributacaoDevolucaoItem;
}

function contexto(ipis: Array<TributacaoDevolucaoItem["ipiDevol"]>): ContextoEmissaoDevolucao {
  return {
    modoReferencia: "ITEM",
    indFinal: "0",
    refs: ipis.map((ipiDevol, i) => ({
      ordem: i + 1,
      chaveAcessoOriginal: CHAVE_ORIGINAL,
      nItemOriginal: i + 5,
      tributacao: tributacao(ipiDevol),
    })),
  };
}

function wrapInProc(nfeXml: string, chave: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    nfeXml.replace(/^<\?xml[^?]*\?>\s*/, ""),
    '<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS202609</verAplic>',
    `<chNFe>${chave}</chNFe><dhRecbto>2026-09-17T10:31:00-03:00</dhRecbto>`,
    "<nProt>142260000000777</nProt><digVal>YWJjZGU=</digVal><cStat>100</cStat>",
    "<xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>",
  ].join("");
}

/**
 * Devolucao de compra com 2 itens (como a da DLS: itens 5 e 6 da nota de
 * origem), desconto num item e frete — para a conta do total ter todas as
 * parcelas. `ipis` define o IPI devolvido de cada item (null = sem).
 */
function montarDevolucao(ipis: Array<TributacaoDevolucaoItem["ipiDevol"]>) {
  vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
  const ctx = contexto(ipis);
  const draft = calcularDevolucao(
    makeDraft({
      finalidade: "DEVOLUCAO",
      tipoOperacao: "SAIDA",
      naturezaOperacao: "DEVOLUCAO DE COMPRA",
      valorFrete: 12.5,
      modalidadeFrete: "CIF",
      itens: [
        makeItem({ id: "a", numero: 1, cfop: "5202", valorUnitario: 100, valorTotal: 100 }),
        makeItem({ id: "b", numero: 2, cfop: "5202", codigo: "PROD-002", descricao: "OUTRA PECA", valorUnitario: 60, valorTotal: 60, desconto: 4 }),
      ],
    } as any),
    ctx,
  );
  const built = new NfeXmlBuilderSefazService().build({
    draft,
    config: makeConfig(),
    numero: 710,
    cNF: CNF_FIXO,
    dhEmi: DH_EMI_FIXO,
    devolucao: ctx,
  });
  const xml = wrapInProc(built.xml, built.chaveAcesso);
  const tot = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml).nfeProc.NFe
    .infNFe.total.ICMSTot;
  return { xml, draft, tot };
}

const DOIS_IPIS = [
  { pDevol: 100, vIPIDevol: 7.35 },
  { pDevol: 100, vIPIDevol: 3.1 },
];

// ═══════════════════════════════════════════════════════════════════
// Leitura do vIPIDevol no XML
// ═══════════════════════════════════════════════════════════════════

describe("lerTotalIpiDevolDoXml", () => {
  it("le o total do <ICMSTot>, nao o <vIPIDevol> do item 1 que aparece antes", () => {
    const { xml, tot } = montarDevolucao(DOIS_IPIS);
    // Premissa: o primeiro <vIPIDevol> do documento e o do item (7.35).
    expect(/<vIPIDevol>([^<]*)<\/vIPIDevol>/.exec(xml)?.[1]).toBe("7.35");
    expect(tot.vIPIDevol).toBe("10.45");
    expect(lerTotalIpiDevolDoXml(xml)).toBe(10.45);
  });

  it("nota comum (vIPIDevol 0.00) e devolucao sem IPI devolvido dao 0", () => {
    const venda = new NfeXmlBuilderSefazService().build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      cNF: CNF_FIXO,
      dhEmi: DH_EMI_FIXO,
    });
    expect(venda.xml).toContain("<vIPIDevol>0.00</vIPIDevol>");
    expect(lerTotalIpiDevolDoXml(venda.xml)).toBe(0);
    expect(lerTotalIpiDevolDoXml(montarDevolucao([null, null]).xml)).toBe(0);
  });

  it("entrada estranha nunca lanca: vira 0", () => {
    for (const x of [
      undefined,
      null,
      42,
      "",
      "<NFe/>",
      "<ICMSTot><vIPIDevol>5.00</vIPIDevol>",
      "<ICMSTot><vIPIDevol>abc</vIPIDevol></ICMSTot>",
      "<ICMSTot><vIPIDevol>-5.00</vIPIDevol></ICMSTot>",
      "<vIPIDevol>5.00</vIPIDevol><ICMSTot><vNF>1</vNF></ICMSTot>",
    ]) {
      expect(lerTotalIpiDevolDoXml(x)).toBe(0);
    }
    expect(lerTotalIpiDevolDoXml("<ICMSTot><vIPIDevol> 1234.5 </vIPIDevol></ICMSTot>")).toBe(1234.5);
  });
});

describe("totalIpiDevolDosTotais / infCplComIpiDevolvido", () => {
  it("sem IPI devolvido o texto volta INALTERADO (nota comum sai igual a antes)", () => {
    for (const totais of [
      null,
      undefined,
      {},
      { totalIpiDevol: 0 },
      { totalIpiDevol: -3 },
      { totalIpiDevol: "abc" },
      { totalIpiDevol: null },
    ]) {
      expect(totalIpiDevolDosTotais(totais)).toBe(0);
      expect(infCplComIpiDevolvido("", totais)).toBe("");
      expect(infCplComIpiDevolvido("Pedido: 12", totais)).toBe("Pedido: 12");
    }
  });

  it("com IPI devolvido a linha vem primeiro, em paragrafo proprio", () => {
    expect(totalIpiDevolDosTotais({ totalIpiDevol: "1234.567" })).toBe(1234.57);
    expect(infCplComIpiDevolvido("", { totalIpiDevol: 1234.5 })).toBe(
      "Valor do IPI devolvido: R$ 1.234,50 (já somado ao valor total da nota)",
    );
    expect(infCplComIpiDevolvido("Devolucao ref. NF 123", { totalIpiDevol: 5 })).toBe(
      "Valor do IPI devolvido: R$ 5,00 (já somado ao valor total da nota)\nDevolucao ref. NF 123",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// DANFE gerado do XML autorizado (caminho de producao: SEFAZ direto)
// ═══════════════════════════════════════════════════════════════════

describe("DANFE oficial da devolucao com IPI devolvido — totais impressos fecham com o XML", () => {
  it("imprime o IPI devolvido do XML e a conta produtos − desconto + frete + IPI + IPI devolvido = total", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
    const { xml, tot } = montarDevolucao(DOIS_IPIS);

    // Premissa: o proprio XML fecha (W16), com o IPI devolvido dentro do vNF.
    expect(centavosXml(tot.vIPIDevol)).toBe(1045);
    expect(centavosXml(tot.vIPI)).toBe(0);
    expect(centavosXml(tot.vFrete)).toBe(1250);
    expect(centavosXml(tot.vDesc)).toBe(400);
    expect(centavosXml(tot.vNF)).toBe(
      centavosXml(tot.vProd) - centavosXml(tot.vDesc) + centavosXml(tot.vFrete) + centavosXml(tot.vIPI) + centavosXml(tot.vIPIDevol),
    );

    const textos = await textosDoPdf(await new DanfePdfService().generateFromXml(xml));

    // Cada total impresso e o do XML — o IPI continua o <vIPI> (0,00).
    const produtos = centavosBR(valorApos(textos, "VALOR TOTAL DOS PRODUTOS"));
    const desconto = centavosBR(valorApos(textos, "DESCONTO"));
    const frete = centavosBR(valorApos(textos, "VALOR DO FRETE"));
    const ipi = centavosBR(valorApos(textos, "VALOR TOTAL DO IPI"));
    const total = centavosBR(valorApos(textos, "VALOR TOTAL DA NOTA"));
    expect(produtos).toBe(centavosXml(tot.vProd));
    expect(desconto).toBe(centavosXml(tot.vDesc));
    expect(frete).toBe(centavosXml(tot.vFrete));
    expect(ipi).toBe(centavosXml(tot.vIPI));
    expect(total).toBe(centavosXml(tot.vNF));

    // O IPI devolvido sai em DADOS ADICIONAIS, com o valor do <ICMSTot>.
    const linhas = textos.filter((t) => LINHA_IPI_DEVOL.test(t));
    expect(linhas).toHaveLength(1);
    const ipiDevol = centavosBR(LINHA_IPI_DEVOL.exec(linhas[0])![1]);
    expect(ipiDevol).toBe(centavosXml(tot.vIPIDevol));
    expect(textos.indexOf(linhas[0])).toBeGreaterThan(textos.indexOf("INFORMAÇÕES COMPLEMENTARES"));

    // E a soma do que esta IMPRESSO fecha no total impresso.
    expect(produtos - desconto + frete + ipi + ipiDevol).toBe(total);
    // Sem a linha, faltaria exatamente o IPI devolvido para fechar.
    expect(total - (produtos - desconto + frete + ipi)).toBe(1045);
  });

  it("repassa o vIPIDevol ao renderer em totaisJson.totalIpiDevol", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
    const spy = vi.spyOn(DanfePdfService.prototype, "generate");
    await new DanfePdfService().generateFromXml(montarDevolucao(DOIS_IPIS).xml);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0].totaisJson as unknown as Record<string, unknown>).totalIpiDevol).toBe(10.45);
  });

  it("TRAVA: devolucao SEM IPI devolvido (caso da DLS) nao ganha linha e continua fechando", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
    const spy = vi.spyOn(DanfePdfService.prototype, "generate");
    const { xml, tot } = montarDevolucao([null, null]);
    const textos = await textosDoPdf(await new DanfePdfService().generateFromXml(xml));

    expect(textos.some((t) => t.includes("IPI devolvido"))).toBe(false);
    expect("totalIpiDevol" in (spy.mock.calls[0][0].totaisJson as object)).toBe(false);
    const soma =
      centavosBR(valorApos(textos, "VALOR TOTAL DOS PRODUTOS")) -
      centavosBR(valorApos(textos, "DESCONTO")) +
      centavosBR(valorApos(textos, "VALOR DO FRETE")) +
      centavosBR(valorApos(textos, "VALOR TOTAL DO IPI"));
    expect(soma).toBe(centavosXml(tot.vNF));
    expect(centavosBR(valorApos(textos, "VALOR TOTAL DA NOTA"))).toBe(centavosXml(tot.vNF));
  });

  it("TRAVA: nota de venda comum sai sem a linha e com totaisJson sem a chave nova", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
    const spy = vi.spyOn(DanfePdfService.prototype, "generate");
    const venda = new NfeXmlBuilderSefazService().build({
      draft: makeDraft({ informacoesComplementares: "Obrigado pela preferencia" }),
      config: makeConfig(),
      numero: 3,
      cNF: CNF_FIXO,
      dhEmi: DH_EMI_FIXO,
    });
    const textos = await textosDoPdf(
      await new DanfePdfService().generateFromXml(wrapInProc(venda.xml, venda.chaveAcesso)),
    );
    expect(textos.some((t) => t.includes("IPI devolvido"))).toBe(false);
    expect(textos).toContain("Obrigado pela preferencia");
    expect("totalIpiDevol" in (spy.mock.calls[0][0].totaisJson as object)).toBe(false);
  });
});

describe("DANFE da devolucao com IPI devolvido — layouts de reserva (v2 e simplificado)", () => {
  it.each([
    ["v2", { NEXT_PUBLIC_DANFE_OFICIAL_ENABLED: "false", NEXT_PUBLIC_DANFE_V2_ENABLED: "true" }],
    ["simplificado", { NEXT_PUBLIC_DANFE_OFICIAL_ENABLED: "false", NEXT_PUBLIC_DANFE_V2_ENABLED: "false" }],
  ] as const)("layout %s tambem cita o IPI devolvido do XML", async (_nome, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { xml } = montarDevolucao(DOIS_IPIS);
    const textos = await textosDoPdf(await new DanfePdfService().generateFromXml(xml));
    const linhas = textos.filter((t) => LINHA_IPI_DEVOL.test(t));
    expect(linhas).toHaveLength(1);
    expect(LINHA_IPI_DEVOL.exec(linhas[0])![1]).toBe("10,45");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Caminho do banco (sem XML inline): o renderer le totaisJson.totalIpiDevol
// ═══════════════════════════════════════════════════════════════════

describe("renderDanfeOficial — totaisJson.totalIpiDevol (caminho do banco)", () => {
  const render = (totaisOver: Record<string, unknown>) =>
    renderDanfeOficial({
      nfe: makeDraft({
        numero: 710,
        totaisJson: {
          totalProdutos: 100,
          totalDesconto: 0,
          totalBcIcms: 0,
          totalIcms: 0,
          totalBcIpi: 0,
          totalIpi: 0,
          totalPis: 0,
          totalCofins: 0,
          totalFrete: 0,
          totalNota: 105,
          totalTributos: 0,
          ...totaisOver,
        },
      } as any),
      config: makeConfig(),
      chaveAcesso: "42260911222333000181550010000007101876543210",
      protocolo: "142260000000777",
      dataAutorizacao: new Date("2026-09-17T10:31:00-03:00"),
    });

  it("com a chave, cita o valor; sem ela, nada muda", async () => {
    const com = await textosDoPdf(await render({ totalIpiDevol: 5 }));
    expect(com).toContain("Valor do IPI devolvido: R$ 5,00 (já somado ao valor total da nota)");
    const sem = await textosDoPdf(await render({}));
    expect(sem.some((t) => t.includes("IPI devolvido"))).toBe(false);
  });
});

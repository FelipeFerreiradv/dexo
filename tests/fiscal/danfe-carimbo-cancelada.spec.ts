import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";

import {
  TEXTOS_SEM_PROTOCOLO,
  TEXTO_SEM_VALOR_FISCAL,
  carimbarDanfeCancelada,
  dataHoraBrasilia,
  geometriaCarimbo,
  linhasDaFaixa,
  rotuloCancelada,
} from "../../app/fiscal/generators/danfe-carimbo-cancelada";
import { DanfePdfService } from "../../app/fiscal/generators/danfe-pdf.service";
import { DanfeNfcePdfService } from "../../app/fiscal/generators/danfe-nfce-pdf.service";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

// Regressão de suporte (DLS AUTO PEÇAS, 25/09/2026): o DANFE da NF-e 716, cancelada
// às 10:07, saía IDÊNTICO ao de uma nota válida. A cliente mandou esse PDF achando
// que era a devolução refeita (NF-e 717, correta) e quase cancelou a 717.

const CANCELAMENTO_716 = { em: new Date("2026-09-25T13:07:47Z"), protocolo: "242260455490192" };

// ── Leitura do texto desenhado, POR PÁGINA ──
// pdf-lib escreve cada drawText como `<hex> Tj` num content stream; o carimbo entra
// como um stream NOVO depois do original, então os textos dele vêm por último.
async function textosPorPagina(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: unknown[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) streams.push(doc.context.lookup(contents.get(i)));
    } else if (contents) {
      streams.push(contents);
    }
    const out: string[] = [];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const raw = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) out.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
    return out;
  });
}

const builder = new NfeXmlBuilderSefazService();
function xmlAutorizado(itens = [makeItem(), makeItem({ codigo: "P2", descricao: "OUTRO ITEM" })]): string {
  const out = builder.build({
    draft: makeDraft({ itens }),
    config: makeConfig(),
    numero: 716,
    dhEmi: new Date("2026-09-25T09:30:00-03:00"),
    cNF: "87654321",
  });
  const nfe = out.xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    nfe,
    '<protNFe versao="4.00"><infProt>',
    "<tpAmb>2</tpAmb>",
    `<chNFe>${out.chaveAcesso}</chNFe>`,
    "<dhRecbto>2026-09-25T09:32:34-03:00</dhRecbto>",
    "<nProt>242260455399718</nProt>",
    "<cStat>100</cStat>",
    "<xMotivo>Autorizado o uso da NF-e</xMotivo>",
    "</infProt></protNFe></nfeProc>",
  ].join("");
}

async function danfeOficial(itens?: Parameters<typeof xmlAutorizado>[0]): Promise<Uint8Array> {
  vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
  return new DanfePdfService().generateFromXml(xmlAutorizado(itens), null);
}

async function cupomNfce(): Promise<Uint8Array> {
  return new DanfeNfcePdfService().generate({
    draft: makeDraft({
      modelo: "65",
      numero: 123,
      pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
      itens: [
        makeItem({ descricao: "PECA A", valorTotal: 60, valorUnitario: 60 }),
        makeItem({ id: "i2", numero: 2, descricao: "PECA B", valorTotal: 40, valorUnitario: 40 }),
      ],
    }),
    config: makeConfig(),
    chaveAcesso: "4".repeat(44),
    protocolo: "342260000000001",
    dataAutorizacao: new Date("2026-07-17T12:00:00-03:00"),
    qrCode: "https://hom.sat.sef.sc.gov.br/nfce/consulta?p=" + "4".repeat(44) + "|2|2|1|" + "A".repeat(40),
    urlChave: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
  } as any);
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("textos do carimbo", () => {
  it("NF-e e NFC-e têm rótulos próprios; modelo ausente é NF-e", () => {
    expect(rotuloCancelada("55")).toBe("NF-e CANCELADA");
    expect(rotuloCancelada(55)).toBe("NF-e CANCELADA");
    expect(rotuloCancelada(null)).toBe("NF-e CANCELADA");
    expect(rotuloCancelada(undefined)).toBe("NF-e CANCELADA");
    expect(rotuloCancelada("65")).toBe("NFC-e CANCELADA");
    expect(rotuloCancelada(65)).toBe("NFC-e CANCELADA");
  });

  it("a hora sai no horário de Brasília (a coluna do banco guarda UTC)", () => {
    expect(dataHoraBrasilia(new Date("2026-09-25T13:07:47Z"))).toBe("25/09/2026 10:07");
    // Depois das 21h de Brasília o UTC já virou o dia: a data NÃO pode avançar.
    expect(dataHoraBrasilia(new Date("2026-09-26T02:30:00Z"))).toBe("25/09/2026 23:30");
    expect(dataHoraBrasilia(new Date("2026-01-05T03:05:00Z"))).toBe("05/01/2026 00:05");
    expect(dataHoraBrasilia(new Date("invalida"))).toBeNull();
    expect(dataHoraBrasilia(null)).toBeNull();
  });

  it("o fuso do SERVIDOR não interfere (a VPS roda em UTC)", () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      expect(dataHoraBrasilia(new Date("2026-09-25T13:07:47Z"))).toBe("25/09/2026 10:07");
      process.env.TZ = "Asia/Tokyo";
      expect(dataHoraBrasilia(new Date("2026-09-26T02:30:00Z"))).toBe("25/09/2026 23:30");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("com protocolo: data, protocolo e 'sem valor fiscal', uma informação por linha", () => {
    expect(linhasDaFaixa(CANCELAMENTO_716)).toEqual([
      { texto: "Cancelamento registrado em 25/09/2026 10:07", destaque: true },
      { texto: "Protocolo de cancelamento 242260455490192", destaque: true },
      { texto: TEXTO_SEM_VALOR_FISCAL, destaque: false },
    ]);
    expect(linhasDaFaixa({ em: null, protocolo: "242260455490192" }).map((l) => l.texto)).toEqual([
      "Protocolo de cancelamento 242260455490192",
      TEXTO_SEM_VALOR_FISCAL,
    ]);
  });

  it("SEM protocolo não afirma 'sem valor fiscal': o status sozinho não prova o cancelamento na SEFAZ", () => {
    // Focus V1: HTTP 200 com erro_cancelamento (SEFAZ recusou) vira CANCELLED com protocolo null.
    const semProtocolo = [...TEXTOS_SEM_PROTOCOLO];
    expect(linhasDaFaixa({ em: CANCELAMENTO_716.em, protocolo: null }).map((l) => l.texto)).toEqual([
      "Cancelamento registrado em 25/09/2026 10:07",
      ...semProtocolo,
    ]);
    expect(linhasDaFaixa({ em: null, protocolo: "   " }).map((l) => l.texto)).toEqual(semProtocolo);
    expect(linhasDaFaixa(null).map((l) => l.texto)).toEqual(semProtocolo);
    for (const c of [null, { em: CANCELAMENTO_716.em, protocolo: null }]) {
      expect(linhasDaFaixa(c).map((l) => l.texto)).not.toContain(TEXTO_SEM_VALOR_FISCAL);
      expect(linhasDaFaixa(c).filter((l) => !l.texto.startsWith("Cancelamento")).every((l) => !l.destaque)).toBe(true);
    }
  });

  it("protocolo vindo do provedor é saneado para a fonte do PDF e tem tamanho limitado", () => {
    const linha = linhasDaFaixa({ em: null, protocolo: "1234\u0007☃\n5678" + "9".repeat(80) })[0].texto;
    expect(linha.startsWith("Protocolo de cancelamento 1234?")).toBe(true);
    expect(linha).not.toMatch(/[\u0000-\u001f☃]/);
    expect(linha.length).toBeLessThanOrEqual("Protocolo de cancelamento ".length + 60);
  });
});

// ── Geometria ──

type Pt = { x: number; y: number };
const EPS = 1e-6;

/** Cantos de um retângulo de largura `l` e altura `a` com canto em (x,y), girado de `graus`. */
function cantos(x: number, y: number, l: number, a: number, graus: number): Pt[] {
  const t = (graus * Math.PI) / 180;
  const u = { x: Math.cos(t), y: Math.sin(t) };
  const v = { x: -Math.sin(t), y: Math.cos(t) };
  return [
    { x, y },
    { x: x + l * u.x, y: y + l * u.y },
    { x: x + a * v.x, y: y + a * v.y },
    { x: x + l * u.x + a * v.x, y: y + l * u.y + a * v.y },
  ];
}

async function medidas(rotulo: string, linhas: Array<{ texto: string; destaque: boolean }>) {
  const doc = await PDFDocument.create();
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  return {
    rotuloEm1: { texto: rotulo, largura: negrito.widthOfTextAtSize(rotulo, 1) },
    linhasEm1: linhas.map((l) => ({
      texto: l.texto,
      largura: (l.destaque ? negrito : regular).widthOfTextAtSize(l.texto, 1),
    })),
  };
}

const PAGINAS: Array<{ nome: string; w: number; h: number; ox?: number; oy?: number }> = [
  { nome: "A4 retrato (DANFE)", w: 595.28, h: 841.89 },
  { nome: "cupom NFC-e 80 mm", w: 226.77, h: 443.93 },
  { nome: "cupom NFC-e longo", w: 226.77, h: 2400 },
  { nome: "carta paisagem (PDF de terceiros)", w: 792, h: 612 },
  { nome: "página minúscula", w: 90, h: 60 },
  { nome: "caixa com origem deslocada", w: 400, h: 600, ox: 100, oy: 50 },
];

describe("geometriaCarimbo — o carimbo cabe em qualquer página", () => {
  const VARIANTES = [
    { nome: "com protocolo", faixa: linhasDaFaixa(CANCELAMENTO_716) },
    { nome: "sem protocolo", faixa: linhasDaFaixa({ em: CANCELAMENTO_716.em, protocolo: null }) },
  ];
  for (const pg of PAGINAS) for (const variante of VARIANTES) {
    it(`${pg.nome} — ${variante.nome}`, async () => {
      const linhasTexto = variante.faixa.map((l) => l.texto);
      const m = await medidas("NF-e CANCELADA", variante.faixa);
      const ox = pg.ox ?? 0;
      const oy = pg.oy ?? 0;
      const g = geometriaCarimbo({ origemX: ox, origemY: oy, largura: pg.w, altura: pg.h, ...m });

      const dentro = (p: Pt) => {
        expect(p.x).toBeGreaterThanOrEqual(ox - EPS);
        expect(p.x).toBeLessThanOrEqual(ox + pg.w + EPS);
        expect(p.y).toBeGreaterThanOrEqual(oy - EPS);
        expect(p.y).toBeLessThanOrEqual(oy + pg.h + EPS);
      };
      const capR = g.rotulo.tamanho * 0.718;
      const caixaRotulo = cantos(g.rotulo.x, g.rotulo.y, m.rotuloEm1.largura * g.rotulo.tamanho, capR, g.anguloGraus);
      caixaRotulo.forEach(dentro);
      const caixaFaixa = cantos(g.faixa.x, g.faixa.y, g.faixa.largura, g.faixa.altura, g.anguloGraus);
      caixaFaixa.forEach(dentro);

      // Cada linha de detalhe fica DENTRO da faixa (coordenadas locais da faixa).
      const t = (g.anguloGraus * Math.PI) / 180;
      const u = { x: Math.cos(t), y: Math.sin(t) };
      const v = { x: -Math.sin(t), y: Math.cos(t) };
      const local = (p: Pt) => ({
        a: (p.x - g.faixa.x) * u.x + (p.y - g.faixa.y) * u.y,
        b: (p.x - g.faixa.x) * v.x + (p.y - g.faixa.y) * v.y,
      });
      g.linhas.forEach((l, i) => {
        for (const c of cantos(l.x, l.y, m.linhasEm1[i].largura * l.tamanho, l.tamanho * 0.718, g.anguloGraus)) {
          const q = local(c);
          expect(q.a).toBeGreaterThanOrEqual(-EPS);
          expect(q.a).toBeLessThanOrEqual(g.faixa.largura + EPS);
          expect(q.b).toBeGreaterThanOrEqual(-EPS);
          expect(q.b).toBeLessThanOrEqual(g.faixa.altura + EPS);
        }
      });
      // As linhas descem na ordem: data, protocolo, "sem valor fiscal".
      for (let i = 1; i < g.linhas.length; i++) {
        expect(local(g.linhas[i]).b).toBeLessThan(local(g.linhas[i - 1]).b);
      }

      // A faixa fica ABAIXO do rótulo (perpendicular), sem invadi-lo.
      const baseRotulo = local({ x: g.rotulo.x, y: g.rotulo.y }).b;
      expect(g.faixa.altura).toBeLessThanOrEqual(baseRotulo + EPS);

      expect(g.anguloGraus).toBeCloseTo((Math.atan2(pg.h, pg.w) * 180) / Math.PI, 6);
      expect(g.rotulo.tamanho).toBeGreaterThan(0);
      expect(g.linhas.map((l) => l.texto)).toEqual(linhasTexto);
    });
  }

  it("no A4 o rótulo é grande e as linhas de detalhe ficam legíveis", async () => {
    const m = await medidas("NF-e CANCELADA", linhasDaFaixa(CANCELAMENTO_716));
    const g = geometriaCarimbo({ largura: 595.28, altura: 841.89, ...m });
    expect(g.rotulo.tamanho).toBeGreaterThan(60);
    expect(g.linhas[0].tamanho).toBeGreaterThanOrEqual(10);
  });

  it("no cupom de 80 mm as linhas de detalhe não caem abaixo de ~6 pt", async () => {
    const m = await medidas("NFC-e CANCELADA", linhasDaFaixa(CANCELAMENTO_716));
    const g = geometriaCarimbo({ largura: 226.77, altura: 443.93, ...m });
    expect(g.linhas[0].tamanho).toBeGreaterThanOrEqual(6);
  });

  it("sem linhas de detalhe, só o rótulo, centrado", async () => {
    const m = await medidas("NF-e CANCELADA", []);
    const g = geometriaCarimbo({ largura: 595.28, altura: 841.89, ...m });
    expect(g.linhas).toEqual([]);
    expect(g.faixa.largura).toBe(0);
    const t = (g.anguloGraus * Math.PI) / 180;
    const larg = m.rotuloEm1.largura * g.rotulo.tamanho;
    const cap = g.rotulo.tamanho * 0.718;
    const centro = {
      x: g.rotulo.x + (larg / 2) * Math.cos(t) - (cap / 2) * Math.sin(t),
      y: g.rotulo.y + (larg / 2) * Math.sin(t) + (cap / 2) * Math.cos(t),
    };
    expect(centro.x).toBeCloseTo(595.28 / 2, 6);
    expect(centro.y).toBeCloseTo(841.89 / 2, 6);
  });
});

// ── O PDF carimbado ──

describe("carimbarDanfeCancelada", () => {
  it("DANFE oficial: rótulo, data, protocolo e 'sem valor fiscal' desenhados, e o original intacto", async () => {
    const original = await danfeOficial();
    const antes = await textosPorPagina(original);
    const copia = Uint8Array.from(original);

    const carimbado = await carimbarDanfeCancelada(original, { modelo: "55", cancelamento: CANCELAMENTO_716 });
    const depois = await textosPorPagina(carimbado);

    expect(depois).toHaveLength(antes.length);
    // Tudo o que estava desenhado continua, na mesma ordem; o carimbo vem por último.
    expect(depois[0].slice(0, antes[0].length)).toEqual(antes[0]);
    expect(depois[0].slice(antes[0].length)).toEqual([
      "NF-e CANCELADA",
      "Cancelamento registrado em 25/09/2026 10:07",
      "Protocolo de cancelamento 242260455490192",
      "Este documento não tem valor fiscal",
    ]);
    // A entrada não é alterada (o arquivo guardado em disco nunca é reescrito).
    expect(Buffer.from(original).equals(Buffer.from(copia))).toBe(true);
  });

  it("página, tamanho e metadados do documento são preservados", async () => {
    // Relógio congelado em dois instantes: o PDF guarda a data com resolução de
    // SEGUNDOS, e carimbar no mesmo segundo esconderia metadado reescrito.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:32:35Z"));
    const original = await danfeOficial();
    vi.setSystemTime(new Date("2026-09-25T14:00:00Z"));
    const carimbado = await carimbarDanfeCancelada(original, { cancelamento: CANCELAMENTO_716 });
    vi.useRealTimers();
    const a = await PDFDocument.load(original, { updateMetadata: false });
    const b = await PDFDocument.load(carimbado, { updateMetadata: false });
    expect(b.getModificationDate()?.getTime()).toBe(a.getModificationDate()?.getTime());
    expect(b.getPageCount()).toBe(a.getPageCount());
    expect(b.getPage(0).getSize()).toEqual(a.getPage(0).getSize());
    expect(b.getCreationDate()?.getTime()).toBe(a.getCreationDate()?.getTime());
    expect(b.getProducer()).toBe(a.getProducer());
  });

  it("DANFE com várias páginas: TODAS saem carimbadas", async () => {
    const itens = Array.from({ length: 70 }, (_, i) =>
      makeItem({ id: `i${i}`, numero: i + 1, codigo: `P${i}`, descricao: `PECA NUMERO ${i + 1}` }),
    );
    const original = await danfeOficial(itens);
    const paginasAntes = (await PDFDocument.load(original)).getPageCount();
    expect(paginasAntes).toBeGreaterThan(1);
    const depois = await textosPorPagina(await carimbarDanfeCancelada(original, { cancelamento: CANCELAMENTO_716 }));
    expect(depois).toHaveLength(paginasAntes);
    for (const pagina of depois) {
      expect(pagina.filter((t) => t === "NF-e CANCELADA")).toHaveLength(1);
      expect(pagina).toContain("Este documento não tem valor fiscal");
    }
  });

  it("sem data nem protocolo: a marca sai assim mesmo, pedindo para conferir na SEFAZ", async () => {
    const depois = await textosPorPagina(await carimbarDanfeCancelada(await danfeOficial(), { cancelamento: null }));
    expect(depois[0]).toContain("NF-e CANCELADA");
    expect(depois[0]).toContain("Sem protocolo de cancelamento da SEFAZ");
    expect(depois[0]).toContain("Confira a situação pela chave de acesso");
    expect(depois[0]).not.toContain("Este documento não tem valor fiscal");
    expect(depois[0].some((t) => t.startsWith("Cancelamento registrado") || t.startsWith("Protocolo de cancelamento"))).toBe(false);
  });

  it("cupom NFC-e (80 mm): 'NFC-e CANCELADA'", async () => {
    const depois = await textosPorPagina(
      await carimbarDanfeCancelada(await cupomNfce(), { modelo: "65", cancelamento: CANCELAMENTO_716 }),
    );
    expect(depois[0]).toContain("NFC-e CANCELADA");
    expect(depois[0]).not.toContain("NF-e CANCELADA");
    expect(depois[0]).toContain("Cancelamento registrado em 25/09/2026 10:07");
  });

  it("layout legado (PDF guardado de notas antigas) também é carimbado", async () => {
    const legado = await new DanfePdfService().generate(
      makeDraft({ itens: [makeItem()] }),
      makeConfig(),
      "4".repeat(44),
      "242260455399718",
    );
    const depois = await textosPorPagina(await carimbarDanfeCancelada(legado, { cancelamento: CANCELAMENTO_716 }));
    expect(depois[0]).toContain("NF-e CANCELADA");
  });

  it("PDF de terceiros com caixa de página deslocada é carimbado sem erro", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([700, 900]);
    page.setMediaBox(100, 150, 400, 600);
    page.setCropBox(100, 150, 400, 600);
    const depois = await textosPorPagina(await carimbarDanfeCancelada(await doc.save(), {}));
    expect(depois[0]).toEqual(["NF-e CANCELADA", ...TEXTOS_SEM_PROTOCOLO]);
  });

  it("bytes que não são PDF: lança (quem entrega decide; nunca devolve sem a marca)", async () => {
    await expect(carimbarDanfeCancelada(new Uint8Array(Buffer.from("nao sou um pdf")), {})).rejects.toThrow();
  });
});

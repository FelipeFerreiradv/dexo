import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
} from "pdf-lib";

import {
  TEXTOS_SEM_PROTOCOLO,
  TEXTO_SEM_VALOR_FISCAL,
  carimbarDanfeCancelada,
  dataHoraBrasilia,
  geometriaCarimbo,
  geometriaCarimboNaPagina,
  linhasDaFaixa,
  normalizarRotacao,
  rotuloCancelada,
  visualParaUsuario,
} from "../../app/fiscal/generators/danfe-carimbo-cancelada";
import { toWinAnsiSafeLine } from "../../app/fiscal/generators/danfe-helpers";
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

// ── Página com /Rotate (PDF de terceiros) ──
// /Rotate gira a página no sentido HORÁRIO na exibição; o desenho é feito no espaço do
// usuário, que não gira. Sem conversão, em /Rotate 180 o carimbo saía de cabeça para
// baixo na tela e, em 90/270, deitado. `naTela` é o oráculo, escrito direto da
// definição (giro horário do CropBox, encostado na origem) — não reusa a conversão
// do código, que é por casos.

const ROTACOES = [90, 180, 270] as const;
type Caixa = { x: number; y: number; width: number; height: number };

function naTela(p: Pt, caixa: Caixa, rotacao: number): Pt {
  const t = (-rotacao * Math.PI) / 180; // horário = ângulo negativo
  const gira = (q: Pt): Pt => ({
    x: q.x * Math.cos(t) - q.y * Math.sin(t),
    y: q.x * Math.sin(t) + q.y * Math.cos(t),
  });
  const quinas = [
    { x: 0, y: 0 },
    { x: caixa.width, y: 0 },
    { x: 0, y: caixa.height },
    { x: caixa.width, y: caixa.height },
  ].map(gira);
  const r = gira({ x: p.x - caixa.x, y: p.y - caixa.y });
  return { x: r.x - Math.min(...quinas.map((q) => q.x)), y: r.y - Math.min(...quinas.map((q) => q.y)) };
}

/** Uma direção do espaço do usuário, vista na tela. */
function direcaoNaTela(d: Pt, caixa: Caixa, rotacao: number): Pt {
  const a = naTela({ x: caixa.x, y: caixa.y }, caixa, rotacao);
  const b = naTela({ x: caixa.x + d.x, y: caixa.y + d.y }, caixa, rotacao);
  return { x: b.x - a.x, y: b.y - a.y };
}

/** Largura e altura da página COMO APARECE (trocadas em 90/270). */
function tamanhoNaTela(caixa: Caixa, rotacao: number): { wv: number; hv: number } {
  return rotacao % 180 === 0 ? { wv: caixa.width, hv: caixa.height } : { wv: caixa.height, hv: caixa.width };
}

const mod360 = (graus: number) => ((graus % 360) + 360) % 360;

describe("página com /Rotate — conversão da tela para o espaço do usuário", () => {
  it("/Rotate é reduzido a 0/90/180/270; valor que não é múltiplo de 90 vale 0 (como no pdf.js)", () => {
    expect([0, 90, 180, 270, 360, 450, 720, -90, -180, -270, -360].map(normalizarRotacao)).toEqual([
      0, 90, 180, 270, 0, 90, 0, 270, 180, 90, 0,
    ]);
    expect([45, 91, -30, Number.NaN, Number.POSITIVE_INFINITY].map(normalizarRotacao)).toEqual([0, 0, 0, 0, 0]);
    expect(Object.is(normalizarRotacao(-0), 0)).toBe(true);
  });

  it("o ponto convertido, exibido, cai no mesmo lugar da tela (três rotações, caixa deslocada)", () => {
    const caixa = { x: 100, y: 50, width: 400, height: 600 };
    for (const r of ROTACOES) {
      const { wv, hv } = tamanhoNaTela(caixa, r);
      for (const p of [{ x: 0, y: 0 }, { x: wv, y: 0 }, { x: 0, y: hv }, { x: wv, y: hv }, { x: 123.4, y: 56.7 }]) {
        const q = naTela(visualParaUsuario(p, caixa, r), caixa, r);
        expect(q.x).toBeCloseTo(p.x, 9);
        expect(q.y).toBeCloseTo(p.y, 9);
      }
    }
    // Conferido à mão — o canto inferior esquerdo da TELA é, no CropBox: em 90 o
    // inferior direito; em 180 o superior direito; em 270 o superior esquerdo.
    expect(visualParaUsuario({ x: 0, y: 0 }, caixa, 90)).toEqual({ x: 500, y: 50 });
    expect(visualParaUsuario({ x: 0, y: 0 }, caixa, 180)).toEqual({ x: 500, y: 650 });
    expect(visualParaUsuario({ x: 0, y: 0 }, caixa, 270)).toEqual({ x: 100, y: 650 });
    expect(visualParaUsuario({ x: 7, y: 9 }, caixa, 0)).toEqual({ x: 107, y: 59 });
  });

  it("a direção do texto, levada à tela, aponta para cima-direita e as letras ficam de pé", async () => {
    const m = await medidas("NF-e CANCELADA", linhasDaFaixa(CANCELAMENTO_716));
    for (const caixa of [
      { x: 0, y: 0, width: 595.28, height: 841.89 },
      { x: 100, y: 50, width: 400, height: 600 },
    ]) {
      for (const r of ROTACOES) {
        const g = geometriaCarimboNaPagina({ caixa, rotacao: r, ...m });
        const t = (g.anguloGraus * Math.PI) / 180;
        const texto = direcaoNaTela({ x: Math.cos(t), y: Math.sin(t) }, caixa, r);
        const paraCima = direcaoNaTela({ x: -Math.sin(t), y: Math.cos(t) }, caixa, r);
        expect(texto.x).toBeGreaterThan(0);
        expect(texto.y).toBeGreaterThan(0);
        // O "para cima" das letras aponta para cima-esquerda: nem deitado, nem de cabeça para baixo.
        expect(paraCima.y).toBeGreaterThan(0);
        expect(paraCima.x).toBeLessThan(0);
        // E sobe pela diagonal da página COMO APARECE.
        const { wv, hv } = tamanhoNaTela(caixa, r);
        expect(Math.atan2(texto.y, texto.x)).toBeCloseTo(Math.atan2(hv, wv), 9);
      }
    }
  });
});

describe("geometriaCarimboNaPagina — o carimbo cabe e fica legível na página girada", () => {
  const VARIANTES = [
    { nome: "com protocolo", faixa: linhasDaFaixa(CANCELAMENTO_716) },
    { nome: "sem protocolo", faixa: linhasDaFaixa({ em: CANCELAMENTO_716.em, protocolo: null }) },
  ];

  it("sem rotação é exatamente a geometria de antes, sobre o CropBox", async () => {
    const m = await medidas("NF-e CANCELADA", linhasDaFaixa(CANCELAMENTO_716));
    for (const pg of PAGINAS) {
      const caixa = { x: pg.ox ?? 0, y: pg.oy ?? 0, width: pg.w, height: pg.h };
      expect(geometriaCarimboNaPagina({ caixa, rotacao: 0, ...m })).toEqual(
        geometriaCarimbo({ origemX: caixa.x, origemY: caixa.y, largura: pg.w, altura: pg.h, ...m }),
      );
    }
  });

  for (const r of ROTACOES) for (const pg of PAGINAS) for (const variante of VARIANTES) {
    it(`/Rotate ${r} — ${pg.nome} — ${variante.nome}`, async () => {
      const m = await medidas("NF-e CANCELADA", variante.faixa);
      const caixa = { x: pg.ox ?? 0, y: pg.oy ?? 0, width: pg.w, height: pg.h };
      const g = geometriaCarimboNaPagina({ caixa, rotacao: r, ...m });

      // No espaço do usuário: os cantos do rótulo, da faixa e de cada linha ficam dentro do CropBox.
      const dentro = (p: Pt) => {
        expect(p.x).toBeGreaterThanOrEqual(caixa.x - EPS);
        expect(p.x).toBeLessThanOrEqual(caixa.x + pg.w + EPS);
        expect(p.y).toBeGreaterThanOrEqual(caixa.y - EPS);
        expect(p.y).toBeLessThanOrEqual(caixa.y + pg.h + EPS);
      };
      cantos(g.rotulo.x, g.rotulo.y, m.rotuloEm1.largura * g.rotulo.tamanho, g.rotulo.tamanho * 0.718, g.anguloGraus).forEach(dentro);
      cantos(g.faixa.x, g.faixa.y, g.faixa.largura, g.faixa.altura, g.anguloGraus).forEach(dentro);
      g.linhas.forEach((l, i) =>
        cantos(l.x, l.y, m.linhasEm1[i].largura * l.tamanho, l.tamanho * 0.718, g.anguloGraus).forEach(dentro),
      );
      // As meias-extensões são nos eixos do CropBox: cabem nele.
      expect(g.meiaExtensao.x).toBeLessThanOrEqual(pg.w / 2 + EPS);
      expect(g.meiaExtensao.y).toBeLessThanOrEqual(pg.h / 2 + EPS);

      // Na tela: é o MESMO carimbo de uma página sem rotação do tamanho exibido.
      const { wv, hv } = tamanhoNaTela(caixa, r);
      const esperado = geometriaCarimbo({ largura: wv, altura: hv, ...m });
      const perto = (a: Pt, b: Pt) => {
        expect(a.x).toBeCloseTo(b.x, 6);
        expect(a.y).toBeCloseTo(b.y, 6);
      };
      perto(naTela(g.rotulo, caixa, r), esperado.rotulo);
      perto(naTela(g.faixa, caixa, r), esperado.faixa);
      g.linhas.forEach((l, i) => perto(naTela(l, caixa, r), esperado.linhas[i]));
      expect(mod360(g.anguloGraus - r)).toBeCloseTo(esperado.anguloGraus, 9);
      expect(g.rotulo.tamanho).toBe(esperado.rotulo.tamanho);
      expect([g.faixa.largura, g.faixa.altura, g.faixa.borda]).toEqual([
        esperado.faixa.largura,
        esperado.faixa.altura,
        esperado.faixa.borda,
      ]);
      expect(g.linhas.map((l) => [l.texto, l.tamanho])).toEqual(esperado.linhas.map((l) => [l.texto, l.tamanho]));
    });
  }
});

// Matriz de texto de cada Tj: o pdf-lib desenha `a b c d e f Tm <hex> Tj`, com (a,b) a
// direção do texto e (e,f) a origem, no espaço do usuário.
async function textosComMatriz(bytes: Uint8Array): Promise<Array<Array<{ texto: string; m: number[] }>>> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams: unknown[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) streams.push(doc.context.lookup(contents.get(i)));
    } else if (contents) {
      streams.push(contents);
    }
    const out: Array<{ texto: string; m: number[] }> = [];
    const num = "(-?[0-9.]+)";
    const re = new RegExp(`${Array(6).fill(num).join("\\s+")}\\s+Tm\\s*<([0-9A-Fa-f]*)>\\s*Tj`, "g");
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const raw = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const x of raw.matchAll(re)) {
        out.push({ texto: Buffer.from(x[7], "hex").toString("latin1"), m: x.slice(1, 7).map(Number) });
      }
    }
    return out;
  });
}

// Cópia fiel do desenho do PR #376, ANTES do suporte a /Rotate: a referência de que o
// caminho sem rotação (todo PDF que a Dexo gera hoje) continua saindo byte a byte igual.
async function carimboDoPr376(pdf: Uint8Array, opcoes: Parameters<typeof carimbarDanfeCancelada>[1] = {}) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const paginas = doc.getPages();
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const rotulo = toWinAnsiSafeLine(rotuloCancelada(opcoes?.modelo));
  const linhas = linhasDaFaixa(opcoes?.cancelamento).map((l) => ({
    texto: toWinAnsiSafeLine(l.texto),
    fonte: l.destaque ? negrito : regular,
  }));
  const vermelho = rgb(0.78, 0.05, 0.05);
  for (const pagina of paginas) {
    const caixa = pagina.getCropBox();
    const g = geometriaCarimbo({
      origemX: caixa.x,
      origemY: caixa.y,
      largura: caixa.width,
      altura: caixa.height,
      rotuloEm1: { texto: rotulo, largura: negrito.widthOfTextAtSize(rotulo, 1) },
      linhasEm1: linhas.map((l) => ({ texto: l.texto, largura: l.fonte.widthOfTextAtSize(l.texto, 1) })),
    });
    const rotate = degrees(g.anguloGraus);
    pagina.drawText(g.rotulo.texto, {
      x: g.rotulo.x,
      y: g.rotulo.y,
      size: g.rotulo.tamanho,
      font: negrito,
      color: vermelho,
      opacity: 0.3,
      rotate,
    });
    if (!linhas.length) continue;
    pagina.drawRectangle({
      x: g.faixa.x,
      y: g.faixa.y,
      width: g.faixa.largura,
      height: g.faixa.altura,
      rotate,
      color: rgb(1, 1, 1),
      opacity: 0.88,
      borderColor: vermelho,
      borderWidth: g.faixa.borda,
      borderOpacity: 1,
    });
    g.linhas.forEach((l, i) =>
      pagina.drawText(l.texto, { x: l.x, y: l.y, size: l.tamanho, font: linhas[i].fonte, color: vermelho, rotate }),
    );
  }
  return doc.save();
}

async function pdfDeTerceiros(
  paginas: Array<{ rotacao?: number | "nao-numero"; caixa?: Caixa }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const p of paginas) {
    const page = doc.addPage([700, 900]);
    if (p.caixa) {
      page.setMediaBox(p.caixa.x, p.caixa.y, p.caixa.width, p.caixa.height);
      page.setCropBox(p.caixa.x, p.caixa.y, p.caixa.width, p.caixa.height);
    }
    if (p.rotacao === "nao-numero") page.node.set(PDFName.of("Rotate"), PDFName.of("Noventa"));
    else if (p.rotacao !== undefined) page.node.set(PDFName.of("Rotate"), PDFNumber.of(p.rotacao));
    page.drawText("conteudo original", { x: (p.caixa?.x ?? 0) + 20, y: (p.caixa?.y ?? 0) + 20, size: 12 });
  }
  return doc.save();
}

describe("carimbarDanfeCancelada — página com /Rotate", () => {
  const LINHAS_716 = [
    "NF-e CANCELADA",
    "Cancelamento registrado em 25/09/2026 10:07",
    "Protocolo de cancelamento 242260455490192",
    "Este documento não tem valor fiscal",
  ];

  it("90, 180, 270 e -90: carimbo completo em todas as páginas, sem erro, rotação e tamanho preservados", async () => {
    const entrada = await pdfDeTerceiros([{ rotacao: 90 }, { rotacao: 180 }, { rotacao: 270 }, { rotacao: -90 }]);
    const carimbado = await carimbarDanfeCancelada(entrada, { modelo: "55", cancelamento: CANCELAMENTO_716 });
    const textos = await textosPorPagina(carimbado);
    expect(textos).toHaveLength(4);
    for (const t of textos) expect(t).toEqual(["conteudo original", ...LINHAS_716]);
    const doc = await PDFDocument.load(carimbado);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 180, 270, -90]);
    for (const p of doc.getPages()) expect(p.getSize()).toEqual({ width: 700, height: 900 });
  });

  it("na tela, cada texto do carimbo sobe da esquerda-baixo para a direita-cima, no lugar do de uma página sem rotação", async () => {
    const m = await medidas("NF-e CANCELADA", linhasDaFaixa(CANCELAMENTO_716));
    for (const caixa of [
      { x: 0, y: 0, width: 700, height: 900 },
      { x: 100, y: 150, width: 400, height: 600 },
    ]) {
      for (const r of [0, 90, 180, 270, -90]) {
        const entrada = await pdfDeTerceiros([{ rotacao: r, caixa: caixa.x ? caixa : undefined }]);
        const [desenhados] = await textosComMatriz(
          await carimbarDanfeCancelada(entrada, { modelo: "55", cancelamento: CANCELAMENTO_716 }),
        );
        const carimbo = desenhados.filter((d) => d.texto !== "conteudo original");
        expect(carimbo.map((d) => d.texto)).toEqual(LINHAS_716);
        const { wv, hv } = tamanhoNaTela(caixa, mod360(r));
        const esperado = geometriaCarimbo({ largura: wv, altura: hv, ...m });
        const origens = [esperado.rotulo, ...esperado.linhas];
        carimbo.forEach((d, i) => {
          const dir = direcaoNaTela({ x: d.m[0], y: d.m[1] }, caixa, r);
          expect(dir.x, `${d.texto} em /Rotate ${r}`).toBeGreaterThan(0);
          expect(dir.y, `${d.texto} em /Rotate ${r}`).toBeGreaterThan(0);
          expect(Math.atan2(dir.y, dir.x)).toBeCloseTo(Math.atan2(hv, wv), 6);
          const o = naTela({ x: d.m[4], y: d.m[5] }, caixa, r);
          expect(o.x, `${d.texto} em /Rotate ${r}`).toBeCloseTo(origens[i].x, 4);
          expect(o.y, `${d.texto} em /Rotate ${r}`).toBeCloseTo(origens[i].y, 4);
        });
      }
    }
  });

  it("sem rotação a saída é BYTE A BYTE a de antes do suporte a /Rotate", async () => {
    // Relógio congelado: as entradas saem iguais, e nada no carimbo pode depender da hora.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:32:35Z"));
    const entradas: Array<[string, Uint8Array]> = [
      ["DANFE oficial", await danfeOficial()],
      ["cupom NFC-e", await cupomNfce()],
      ["caixa deslocada", await pdfDeTerceiros([{ caixa: { x: 100, y: 150, width: 400, height: 600 } }])],
      ["/Rotate 0, 360 e -360 explícitos", await pdfDeTerceiros([{ rotacao: 0 }, { rotacao: 360 }, { rotacao: -360 }])],
      // Inválidos: continuam tratados como sem rotação, exatamente como antes.
      ["/Rotate 45 (não é múltiplo de 90)", await pdfDeTerceiros([{ rotacao: 45 }])],
      ["/Rotate que não é número", await pdfDeTerceiros([{ rotacao: "nao-numero" }])],
    ];
    vi.setSystemTime(new Date("2026-09-25T14:00:00Z"));
    const opcoes: Array<Parameters<typeof carimbarDanfeCancelada>[1]> = [
      { modelo: "55", cancelamento: CANCELAMENTO_716 },
      { cancelamento: { em: CANCELAMENTO_716.em, protocolo: null } },
      { modelo: "65", cancelamento: CANCELAMENTO_716 },
    ];
    for (const [nome, entrada] of entradas) {
      for (const [i, op] of opcoes.entries()) {
        const novo = Buffer.from(await carimbarDanfeCancelada(entrada, op));
        const referencia = Buffer.from(await carimboDoPr376(entrada, op));
        expect({ nome, i, igual: novo.equals(referencia) }).toEqual({ nome, i, igual: true });
      }
    }
  });
});

// ── /Rotate HERDADO (gravado no nó Pages, não na página) ──
// /Rotate é atributo herdável (ISO 32000-1, 7.7.3.4): um PDF de terceiros pode trazê-lo
// no nó Pages pai e não na página. A tela gira do mesmo jeito; o carimbo tem de sair
// igual ao da página com o /Rotate nela mesma.

async function pdfDeTerceirosRotacaoHerdada(rotacao: number, caixa?: Caixa): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 900]);
  if (caixa) {
    page.setMediaBox(caixa.x, caixa.y, caixa.width, caixa.height);
    page.setCropBox(caixa.x, caixa.y, caixa.width, caixa.height);
  }
  doc.catalog.Pages().set(PDFName.of("Rotate"), PDFNumber.of(rotacao));
  page.drawText("conteudo original", { x: (caixa?.x ?? 0) + 20, y: (caixa?.y ?? 0) + 20, size: 12 });
  return doc.save();
}

describe("carimbarDanfeCancelada — /Rotate herdado do nó Pages", () => {
  const LINHAS_716 = [
    "NF-e CANCELADA",
    "Cancelamento registrado em 25/09/2026 10:07",
    "Protocolo de cancelamento 242260455490192",
    "Este documento não tem valor fiscal",
  ];
  const OPCOES = { modelo: "55", cancelamento: CANCELAMENTO_716 };

  for (const r of [90, 270] as const) {
    it(`/Rotate ${r} no Pages: na tela, a mesma orientação e o mesmo lugar do /Rotate ${r} na própria página`, async () => {
      const m = await medidas("NF-e CANCELADA", linhasDaFaixa(CANCELAMENTO_716));
      for (const caixa of [
        { x: 0, y: 0, width: 700, height: 900 },
        { x: 100, y: 150, width: 400, height: 600 },
      ]) {
        const entrada = await pdfDeTerceirosRotacaoHerdada(r, caixa.x ? caixa : undefined);
        // Premissa: a rotação está SÓ no pai — a página não tem /Rotate próprio.
        const lida = await PDFDocument.load(entrada);
        expect(lida.getPages()[0].node.get(PDFName.of("Rotate"))).toBeUndefined();
        expect(lida.catalog.Pages().lookup(PDFName.of("Rotate"), PDFNumber).asNumber()).toBe(r);
        expect(lida.getPages()[0].getRotation().angle).toBe(r);

        const carimbado = await carimbarDanfeCancelada(entrada, OPCOES);
        expect((await textosPorPagina(carimbado))[0]).toEqual(["conteudo original", ...LINHAS_716]);
        const carimbo = (await textosComMatriz(carimbado))[0].filter((d) => d.texto !== "conteudo original");
        expect(carimbo.map((d) => d.texto)).toEqual(LINHAS_716);

        // Igual, matriz por matriz, ao carimbo da página com o /Rotate nela mesma.
        const naPropria = (
          await textosComMatriz(
            await carimbarDanfeCancelada(await pdfDeTerceiros([{ rotacao: r, caixa: caixa.x ? caixa : undefined }]), OPCOES),
          )
        )[0].filter((d) => d.texto !== "conteudo original");
        expect(carimbo).toEqual(naPropria);

        // E, pelo oráculo independente: na tela sobe da esquerda-baixo para a direita-cima,
        // no lugar do carimbo de uma página sem rotação do tamanho exibido.
        const { wv, hv } = tamanhoNaTela(caixa, r);
        const esperado = geometriaCarimbo({ largura: wv, altura: hv, ...m });
        const origens = [esperado.rotulo, ...esperado.linhas];
        carimbo.forEach((d, i) => {
          const dir = direcaoNaTela({ x: d.m[0], y: d.m[1] }, caixa, r);
          expect(dir.x, `${d.texto} em /Rotate ${r} herdado`).toBeGreaterThan(0);
          expect(dir.y, `${d.texto} em /Rotate ${r} herdado`).toBeGreaterThan(0);
          expect(Math.atan2(dir.y, dir.x)).toBeCloseTo(Math.atan2(hv, wv), 6);
          const o = naTela({ x: d.m[4], y: d.m[5] }, caixa, r);
          expect(o.x, `${d.texto} em /Rotate ${r} herdado`).toBeCloseTo(origens[i].x, 4);
          expect(o.y, `${d.texto} em /Rotate ${r} herdado`).toBeCloseTo(origens[i].y, 4);
        });

        // O carimbo não mexe na rotação: continua só no pai, e a página continua girada.
        const saida = await PDFDocument.load(carimbado);
        expect(saida.getPages()[0].node.get(PDFName.of("Rotate"))).toBeUndefined();
        expect(saida.getPages()[0].getRotation().angle).toBe(r);
        expect(saida.getPages()[0].getSize()).toEqual({ width: caixa.width, height: caixa.height });
      }
    });
  }
});

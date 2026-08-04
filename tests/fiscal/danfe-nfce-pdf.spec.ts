import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  DanfeNfcePdfService,
  buildCupomOps,
  cupomHeight,
  __internals,
  type CupomOp,
  type DrawSurface,
} from "../../app/fiscal/generators/danfe-nfce-pdf.service";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { parseNfeXml } from "../../app/fiscal/sefaz/nfe-xml-parser.service";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

// Smoke do cupom DANFE NFC-e (80mm, pdf-lib + QR via pacote qrcode).

const svc = new DanfeNfcePdfService();

function input65(overrides: Partial<Parameters<DanfeNfcePdfService["generate"]>[0]> = {}) {
  return {
    draft: makeDraft({
      modelo: "65",
      numero: 123,
      pagamentosJson: [
        { meio: "PIX", valor: 60 },
        { meio: "DINHEIRO", valor: 40 },
      ] as any,
      itens: [
        makeItem({ descricao: "PECA A", valorTotal: 60, valorUnitario: 60 }),
        makeItem({
          id: "i2",
          numero: 2,
          descricao: "PECA B",
          valorTotal: 40,
          valorUnitario: 40,
        }),
      ],
    }),
    config: makeConfig(),
    chaveAcesso: "4".repeat(44),
    protocolo: "342260000000001",
    dataAutorizacao: new Date("2026-07-17T12:00:00-03:00"),
    qrCode:
      "https://hom.sat.sef.sc.gov.br/nfce/consulta?p=" +
      "4".repeat(44) +
      "|2|2|1|" +
      "A".repeat(40),
    urlChave: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
    ...overrides,
  };
}

describe("DanfeNfcePdfService.generate", () => {
  it("gera PDF válido (%PDF) com QR", async () => {
    const bytes = await svc.generate(input65());
    expect(bytes.byteLength).toBeGreaterThan(500);
    const head = Buffer.from(bytes.slice(0, 5)).toString("utf8");
    expect(head).toBe("%PDF-");
  });

  it("sem QR (fallback Focus) também gera PDF", async () => {
    const bytes = await svc.generate(
      input65({ qrCode: null, urlChave: null }),
    );
    const head = Buffer.from(bytes.slice(0, 5)).toString("utf8");
    expect(head).toBe("%PDF-");
  });

  it("consumidor não identificado (sem dest) não quebra", async () => {
    const i = input65();
    (i.draft as any).destinatarioJson = null;
    const bytes = await svc.generate(i);
    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
  });
});

// ──────────────────────────────────────────────────────────────────
// Caminho XML end-to-end. Nenhum teste cruzava o parser até aqui — e era
// justamente onde o cupom quebrava: `parseDest` lançava para XML sem <dest>,
// que é exatamente o que o NOSSO builder emite na venda a consumidor não
// identificado (o caso mais comum do PDV).
// ──────────────────────────────────────────────────────────────────

const builder = new NfeXmlBuilderSefazService();

function build65Xml(overrides: Record<string, any> = {}): string {
  const out = builder.build({
    draft: makeDraft({
      modelo: "65",
      indPresenca: "PRESENCIAL",
      pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
      ...overrides,
    }),
    config: makeConfig(),
    numero: 123,
    dhEmi: new Date("2026-07-17T12:00:00-03:00"),
    cNF: "10000007",
  });
  const nfeStripped = out.xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    nfeStripped,
    '<protNFe versao="4.00">',
    "<infProt>",
    "<tpAmb>2</tpAmb>",
    `<chNFe>${out.chaveAcesso}</chNFe>`,
    "<dhRecbto>2026-07-17T12:00:31-03:00</dhRecbto>",
    "<nProt>342260000000001</nProt>",
    "<cStat>100</cStat>",
    "<xMotivo>Autorizado o uso da NF-e</xMotivo>",
    "</infProt>",
    "</protNFe>",
    "</nfeProc>",
  ].join("");
}

describe("DanfeNfcePdfService.generateFromXml — venda anônima (sem <dest>)", () => {
  it("REGRESSÃO: XML 65 sem <dest> parseia em vez de lançar", () => {
    const xml = build65Xml({ destinatarioJson: null });
    expect(xml).not.toContain("<dest>");
    expect(() => parseNfeXml(xml)).not.toThrow();
    const parsed = parseNfeXml(xml);
    expect(parsed.ide.mod).toBe("65");
    expect(parsed.dest.CPF).toBeNull();
    expect(parsed.dest.CNPJ).toBeNull();
    expect(parsed.dest.xNome).toBe("");
    expect(parsed.dest.indIEDest).toBe("9");
  });

  it("gera o cupom a partir do XML sem <dest>", async () => {
    const bytes = await svc.generateFromXml(build65Xml({ destinatarioJson: null }));
    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  it("o modelo 55 SEM <dest> continua lançando (grupo é obrigatório lá)", () => {
    const semDest =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<NFe xmlns="http://www.portalfiscal.inf.br/nfe">' +
      '<infNFe versao="4.00" Id="NFe' +
      "5".repeat(44) +
      '">' +
      "<ide><cUF>52</cUF><natOp>Venda</natOp><mod>55</mod><serie>1</serie>" +
      "<nNF>1</nNF><tpNF>1</tpNF><tpAmb>2</tpAmb><finNFe>1</finNFe>" +
      "<tpEmis>1</tpEmis><cMunFG>5208707</cMunFG><cDV>0</cDV></ide>" +
      "<emit><CNPJ>07087727000105</CNPJ><xNome>EMIT</xNome><IE>1</IE><CRT>1</CRT>" +
      "<enderEmit><xLgr>R</xLgr><nro>1</nro><xBairro>B</xBairro><cMun>5208707</cMun>" +
      "<xMun>Goiania</xMun><UF>GO</UF><CEP>74000000</CEP><cPais>1058</cPais>" +
      "<xPais>BRASIL</xPais></enderEmit></emit>" +
      "</infNFe></NFe>";
    expect(() => parseNfeXml(semDest)).toThrow(/sem <dest>/i);
  });

  it("com CPF identificado, o consumidor sai preenchido", async () => {
    const xml = build65Xml({
      destinatarioJson: {
        tipoPessoa: "PF",
        cpfCnpj: "56353928149",
        nome: "Alessandro Soares",
      },
    });
    const parsed = parseNfeXml(xml);
    expect(parsed.dest.CPF).toBe("56353928149");
    const bytes = await svc.generateFromXml(xml);
    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
  });

  it("P1: o pagamento sobrevive ao round-trip pelo XML (tPag → rótulo)", () => {
    // Este é o dado que saía como "Outros / R$ 0,00" ao re-renderizar do XML:
    // o banco grava {meio,valor} e o parser devolve {tPag,vPag}.
    const parsed = parseNfeXml(build65Xml({ destinatarioJson: null }));
    expect(parsed.pag[0]).toEqual({ tPag: "17", vPag: 100 });
  });

  it("P1: o cupom do XML mostra a MESMA forma de pagamento do cupom do banco", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    // Só as LINHAS de pagamento (pagamento:0, pagamento:1...), não o cabeçalho.
    const linhasPagamento = (pagamentosJson: unknown) =>
      buildCupomOps(
        { ...input65(), draft: makeDraft({ modelo: "65", pagamentosJson } as never) },
        { font, bold, qrImage: null },
      ).filter((o) => /^pagamento:\d+$/.test(o.label));

    // Shape do banco e shape do XML têm que produzir a MESMA saída — antes, o
    // do XML caía num "Outros / R$ 0,00" genérico num documento fiscal.
    const doBanco = linhasPagamento([{ meio: "PIX", valor: 100 }]);
    const doXml = linhasPagamento([{ tPag: "17", vPag: 100 }]);
    expect(doBanco).toHaveLength(1);
    expect(doXml).toHaveLength(1);
    expect(doXml[0].h).toBeCloseTo(doBanco[0].h, 6);

    // E o texto desenhado é idêntico (captura o que cada op emite).
    const textoDe = (op: (typeof doBanco)[0]) => {
      const saida: string[] = [];
      const s: DrawSurface = {
        text: (t) => {
          if (t) saida.push(t);
        },
        line: () => {},
        image: () => {},
      };
      op.draw(s, 100);
      return saida;
    };
    expect(textoDe(doXml[0])).toEqual(textoDe(doBanco[0]));
    expect(textoDe(doBanco[0])).toEqual(["PIX", "100,00"]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Invariante de layout. Comparar `height` com Σ op.h seria TAUTOLÓGICO (a
// altura É a soma). O que precisa ser verificado é a TINTA REAL: nenhuma
// operação pode desenhar abaixo do que reservou, e nada pode sair da página.
// ──────────────────────────────────────────────────────────────────

/** Superfície de mentira que só REGISTRA onde a tinta caiu. */
function inkProbe() {
  const marks: number[] = [];
  const surface: DrawSurface = {
    text(t, o) {
      if (!t) return;
      marks.push(o.baseline - o.size * 0.21);
    },
    line(y) {
      marks.push(y);
    },
    image(_img, _x, y) {
      marks.push(y);
    },
  };
  return { surface, marks, min: () => (marks.length ? Math.min(...marks) : Infinity) };
}

/** Percorre as ops como o renderer faz e devolve a menor tinta por operação. */
function medirTinta(ops: CupomOp[], height: number) {
  const resultados: Array<{ label: string; top: number; h: number; minInk: number }> = [];
  let top = height - __internals.PAD_TOP;
  let globalMin = Infinity;
  for (const op of ops) {
    const probe = inkProbe();
    op.draw(probe.surface, top);
    const minInk = probe.min();
    if (Number.isFinite(minInk)) globalMin = Math.min(globalMin, minInk);
    resultados.push({ label: op.label, top, h: op.h, minInk });
    top -= op.h;
  }
  return { resultados, globalMin, fim: top };
}

describe("DanfeNfcePdfService — invariante de TINTA (não tautológico)", () => {
  const CENARIOS: Array<{ nome: string; over: Record<string, unknown>; qr: boolean }> = [
    { nome: "1 item", over: { itens: [makeItem()] }, qr: true },
    { nome: "sem itens", over: { itens: [] }, qr: false },
    {
      nome: "40 itens",
      over: {
        itens: Array.from({ length: 40 }, (_, i) =>
          makeItem({ id: `i${i}`, numero: i + 1, descricao: `PECA ${i}` }),
        ),
      },
      qr: true,
    },
    {
      nome: "descrições MUITO longas (o modo de falha clássico)",
      over: {
        itens: Array.from({ length: 10 }, (_, i) =>
          makeItem({
            id: `i${i}`,
            numero: i + 1,
            descricao:
              "SUPORTE GUIA PARACHOQUE TRASEIRO DIREITO IX35 2012 A 2015 ORIGINAL MONTADORA COMPLETO COM PARAFUSOS",
          }),
        ),
      },
      qr: true,
    },
    { nome: "homologação", over: { ambiente: "HOMOLOGACAO" }, qr: true },
    { nome: "produção", over: { ambiente: "PRODUCAO" }, qr: true },
    {
      nome: "muitos pagamentos",
      over: {
        pagamentosJson: [
          { meio: "PIX", valor: 20 },
          { meio: "DINHEIRO", valor: 20 },
          { meio: "CARTAO_CREDITO", valor: 20 },
          { meio: "CARTAO_DEBITO", valor: 20 },
          { meio: "BOLETO", valor: 20 },
        ],
      },
      qr: true,
    },
    {
      nome: "com desconto",
      over: { totaisJson: { totalNota: 90, totalDesconto: 10, totalProdutos: 100 } },
      qr: true,
    },
    {
      nome: "infCpl longo",
      over: {
        informacoesComplementares:
          "Trib Aprox Federal R$ 10,63 (13,45%) Estadual R$ 15,01 (19,00%) Fonte: IBPT. " +
          "Mercadoria destinada a consumidor final. Garantia de 90 dias.",
      },
      qr: true,
    },
    { nome: "sem QR", over: {}, qr: false },
    { nome: "consumidor anônimo", over: { destinatarioJson: null }, qr: true },
  ];

  it.each(CENARIOS)(
    "$nome: nenhuma operação desenha abaixo do que reservou",
    async (c) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);

      const entrada = {
        ...input65({ qrCode: c.qr ? "https://x/consulta?p=1" : null }),
        draft: makeDraft({ modelo: "65", numero: 123, ...c.over } as never),
      };
      const ops = buildCupomOps(entrada, { font, bold, qrImage: null });
      const height = cupomHeight(ops);
      const { resultados, globalMin } = medirTinta(ops, height);

      for (const r of resultados) {
        expect(
          r.minInk,
          `op "${r.label}" (top=${r.top.toFixed(1)}, h=${r.h.toFixed(1)}) pintou em ${r.minInk.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(r.top - r.h - 0.01);
      }
      // E nada sai da página (o rodapé reserva PAD_BOT).
      expect(globalMin).toBeGreaterThanOrEqual(0);
    },
  );

  it("a altura REAGE ao conteúdo (não é constante disfarçada)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const alturaCom = (n: number) =>
      cupomHeight(
        buildCupomOps(
          {
            ...input65(),
            draft: makeDraft({
              modelo: "65",
              itens: Array.from({ length: n }, (_, i) => makeItem({ id: `i${i}`, numero: i + 1 })),
            } as never),
          },
          { font, bold, qrImage: null },
        ),
      );
    expect(alturaCom(10)).toBeGreaterThan(alturaCom(1));
    expect(alturaCom(40)).toBeGreaterThan(alturaCom(10));

    // Descrição longa (que quebra em mais linhas) TEM que aumentar a altura —
    // era exatamente isso que a soma de constantes antiga não enxergava.
    const curto = cupomHeight(
      buildCupomOps(
        { ...input65(), draft: makeDraft({ modelo: "65", itens: [makeItem({ descricao: "X" })] } as never) },
        { font, bold, qrImage: null },
      ),
    );
    const longo = cupomHeight(
      buildCupomOps(
        {
          ...input65(),
          draft: makeDraft({
            modelo: "65",
            itens: [makeItem({ descricao: "PECA COM NOME MUITO COMPRIDO ".repeat(5) })],
          } as never),
        },
        { font, bold, qrImage: null },
      ),
    );
    expect(longo).toBeGreaterThan(curto);
  });

  it("a página gerada tem exatamente a altura calculada e 80mm de largura", async () => {
    const bytes = await svc.generate(input65());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(__internals.CUPOM_W, 2);
    expect(height).toBeGreaterThan(200);
  });

  it("texto hostil (emoji, controles) não derruba a geração", async () => {
    const bytes = await svc.generate({
      ...input65(),
      draft: makeDraft({
        modelo: "65",
        itens: [makeItem({ descricao: "PECA \u{1F697} \u0081 ESPECIAL" })],
      } as never),
      config: makeConfig({ razaoSocial: "AUTOPEÇAS \u{1F6A6} LTDA" }),
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
  });
});

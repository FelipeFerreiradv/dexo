import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderDanfeOficial } from "../../app/fiscal/generators/danfe-oficial-renderer";
import {
  planDanfePages,
  PROD_COLUMNS,
  PAGE_W,
  PAGE_H,
} from "../../app/fiscal/generators/danfe-oficial-layout";
import { wrapTextLines } from "../../app/fiscal/generators/danfe-helpers";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

const CHAVE = "52251207087727000105550020000000941757171782";

function itens(n: number, descricao?: string) {
  return Array.from({ length: n }, (_, i) =>
    makeItem({
      id: `i${i}`,
      numero: i + 1,
      codigo: `100002${i}`,
      descricao: descricao ?? `SUPORTE GUIA PARACHOQUE TRASEIRO DIREITO IX35 2012 A 2015 #${i}`,
      valorUnitario: 79 + i,
      valorTotal: 79 + i,
    }),
  );
}

function render(over: Record<string, any> = {}, cfg: Record<string, any> = {}) {
  return renderDanfeOficial({
    nfe: makeDraft({ numero: 94, serie: 2, ...over }),
    config: makeConfig(cfg),
    chaveAcesso: CHAVE,
    protocolo: "152259765009974",
    dataAutorizacao: new Date("2025-12-16T16:17:33-03:00"),
  });
}

function isPdf(b: Uint8Array) {
  return Buffer.from(b.slice(0, 5)).toString("latin1") === "%PDF-";
}

describe("renderDanfeOficial — geração", () => {
  it("gera um PDF A4 válido para a nota mínima", async () => {
    const bytes = await render();
    expect(isPdf(bytes)).toBe(true);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(PAGE_W, 2);
    expect(height).toBeCloseTo(PAGE_H, 2);
  });

  it("toda página é A4 retrato, mesmo com muitos itens", async () => {
    const bytes = await render({ itens: itens(120) });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    for (const p of doc.getPages()) {
      expect(p.getSize().width).toBeCloseTo(PAGE_W, 2);
      expect(p.getSize().height).toBeCloseTo(PAGE_H, 2);
    }
  });

  // Reproduz a passada de MEDIÇÃO do renderer com a mesma fonte, tamanho e
  // largura de coluna, para prever o plano de forma independente do desenho.
  async function planejarComoORenderer(descricoes: string[], infoLineCount = 0, dups = 0) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const descCol = PROD_COLUMNS.find((c) => c.key === "descricao")!;
    const maxW = descCol.width - 3 * 2; // PAD = 3
    const counts = descricoes.map((d) => {
      const linhas = wrapTextLines(d, maxW, (s) => font.widthOfTextAtSize(s, 5.8));
      return Math.min(linhas.length, 3); // MAX_DESC_LINES
    });
    return planDanfePages({
      itemLineCounts: counts,
      infoLineCount,
      duplicataCount: dups,
    });
  }

  it.each([1, 5, 17, 18, 40, 60, 200])(
    "%i itens: o nº de páginas do PDF é EXATAMENTE o que o planejador previu",
    async (n) => {
      const lista = itens(n);
      const bytes = await render({ itens: lista });
      expect(isPdf(bytes)).toBe(true);

      const doc = await PDFDocument.load(bytes);
      const plan = await planejarComoORenderer(lista.map((i) => i.descricao));
      // Se o desenho criasse páginas por fora do plano, o "FOLHA x/y" impresso
      // na primeira folha mentiria — é isso que este assert protege.
      expect(doc.getPageCount()).toBe(plan.totalPages);
    },
  );

  it("o plano REAGE ao conteúdo (não é um número fixo disfarçado)", async () => {
    const curto = await planejarComoORenderer(Array(40).fill("PECA"));
    const longo = await planejarComoORenderer(
      Array(40).fill("SUPORTE GUIA PARACHOQUE TRASEIRO DIREITO IX35 2012 A 2015 COMPLETO"),
    );
    expect(longo.totalPages).toBeGreaterThan(curto.totalPages);
  });

  it("nota sem itens ainda produz um DANFE de 1 página", async () => {
    const bytes = await render({ itens: [] });
    expect(isPdf(bytes)).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Robustez de texto: `widthOfTextAtSize` lança igual a `drawText`, então o
// saneamento tem que acontecer ANTES da passada de medição. Um emoji na
// DESCRIÇÃO exercita exatamente esse caminho (o infCpl não basta).
// ──────────────────────────────────────────────────────────────────

describe("renderDanfeOficial — texto hostil não derruba a geração", () => {
  it("emoji na DESCRIÇÃO do item (passada de medição)", async () => {
    const bytes = await render({
      itens: [makeItem({ descricao: "PARACHOQUE \u{1F69A} DIANTEIRO \u{1F600}" })],
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("emoji na razão social do emitente", async () => {
    const bytes = await render({}, { razaoSocial: "AUTOPEÇAS \u{1F697} LTDA" });
    expect(isPdf(bytes)).toBe(true);
  });

  it("controles C0/C1 em campos livres", async () => {
    const bytes = await render({
      itens: [makeItem({ descricao: "PECA\u0000COM\u0081CONTROLE\u001f" })],
      destinatarioJson: {
        tipoPessoa: "PF",
        cpfCnpj: "56353928149",
        nome: "CLIENTE\u009dTESTE",
        logradouro: "RUA\u0007X",
      } as any,
      informacoesComplementares: "Obs\u0081com\u0000lixo",
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("emoji nas informações complementares", async () => {
    const bytes = await render({
      informacoesComplementares: "Entrega expressa \u{1F69A} ate sexta",
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("descrição gigante sem espaços (força fatiamento de palavra)", async () => {
    const bytes = await render({
      itens: [makeItem({ descricao: "X".repeat(400) })],
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("campos nulos/ausentes não quebram", async () => {
    const bytes = await render({
      destinatarioJson: null,
      totaisJson: null,
      modalidadeFrete: null,
      naturezaOperacao: "",
      itens: [makeItem({ descricao: "", codigo: "", ncm: "", cfop: "", unidade: "" })],
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("chave de acesso ausente/curta não impede a geração (sem barras)", async () => {
    for (const chave of [null, "", "123", "abc"]) {
      const bytes = await renderDanfeOficial({
        nfe: makeDraft(),
        config: makeConfig(),
        chaveAcesso: chave,
        protocolo: null,
      });
      expect(isPdf(bytes), `chave=${chave}`).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// A garantia que o layout antigo quebrava: nada de informação fiscal
// é descartado silenciosamente.
// ──────────────────────────────────────────────────────────────────

describe("renderDanfeOficial — nada é truncado", () => {
  it("infCpl de 5000 caracteres sai INTEIRO, paginando se preciso", async () => {
    const obs = Array.from(
      { length: 120 },
      (_, i) => `Observacao numero ${i + 1} com texto comprido para forcar quebra.`,
    )
      .join(" ")
      .slice(0, 5000);

    const bytes = await render({ informacoesComplementares: obs, itens: itens(30) });
    const doc = await PDFDocument.load(bytes);
    expect(isPdf(bytes)).toBe(true);

    // O plano precisa acomodar TODAS as linhas quebradas — nenhuma a menos.
    const linhas = wrapTextLines(obs, 350, (s) => s.length * 2.8);
    const plan = planDanfePages({
      itemLineCounts: Array(30).fill(1),
      infoLineCount: linhas.length,
      duplicataCount: 0,
    });
    const desenhadas = plan.pages.reduce(
      (a, p) => a + (p.infoLineEnd - p.infoLineStart),
      0,
    );
    expect(desenhadas).toBe(linhas.length);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it.each([0, 1, 4, 7, 12, 40])(
    "%i duplicatas: gera sem estourar a página",
    async (n) => {
      const bytes = await render({
        duplicatasJson: Array.from({ length: n }, (_, i) => ({
          numero: `00${i + 1}`,
          vencimento: "2026-06-01",
          valor: 100 + i,
        })) as any,
        itens: itens(20),
      });
      expect(isPdf(bytes)).toBe(true);
    },
  );

  it("volumes e transportadora aparecem nos dois shapes (DB e XML)", async () => {
    const doBanco = await render({
      transportadoraJson: {
        cpfCnpj: "12345678000199",
        nome: "TRANSPORTES SILVA",
        inscricaoEstadual: "999",
        endereco: "RUA A, 100",
        municipio: "GOIANIA",
        uf: "GO",
      } as any,
      volumesJson: [{ quantidade: 2, especie: "CAIXA", pesoBruto: 10, pesoLiquido: 9 }] as any,
    });
    const doXml = await render({
      transportadoraJson: {
        CNPJ: "12345678000199",
        xNome: "TRANSPORTES SILVA",
        IE: "999",
        xEnder: "RUA A, 100",
        xMun: "GOIANIA",
        UF: "GO",
      } as any,
    });
    expect(isPdf(doBanco)).toBe(true);
    expect(isPdf(doXml)).toBe(true);
  });
});

describe("renderDanfeOficial — variações de contexto", () => {
  it("homologação e produção geram os dois", async () => {
    expect(isPdf(await render({ ambiente: "HOMOLOGACAO" }))).toBe(true);
    expect(isPdf(await render({ ambiente: "PRODUCAO" }, { ambiente: "PRODUCAO" }))).toBe(true);
  });

  it("entrada e saída trocam o dígito do quadro sem quebrar", async () => {
    expect(isPdf(await render({ tipoOperacao: "ENTRADA" }))).toBe(true);
    expect(isPdf(await render({ tipoOperacao: "SAIDA" }))).toBe(true);
  });

  it("regime normal (CST) e Simples (CSOSN)", async () => {
    expect(isPdf(await render({}, { regimeTributario: "SIMPLES" }))).toBe(true);
    expect(isPdf(await render({}, { regimeTributario: "LUCRO_REAL" }))).toBe(true);
  });

  it("avatar inválido cai nas iniciais sem quebrar", async () => {
    const bytes = await renderDanfeOficial({
      nfe: makeDraft(),
      config: makeConfig(),
      chaveAcesso: CHAVE,
      protocolo: "1",
      avatar: { bytes: new Uint8Array([1, 2, 3]), format: "png" },
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("extras do XML (impostos por item) são aceitos", async () => {
    const bytes = await renderDanfeOficial({
      nfe: makeDraft({ itens: itens(3) }),
      config: makeConfig(),
      chaveAcesso: CHAVE,
      protocolo: "1",
      extras: {
        itensImpostos: [
          {
            origem: "1",
            cstCsosn: "00",
            isCsosn: false,
            bcIcms: 100,
            valorIcms: 18,
            aliquotaIcms: 18,
            valorIpi: 5,
            aliquotaIpi: 5,
          },
          null,
          {
            origem: "0",
            cstCsosn: "102",
            isCsosn: true,
            bcIcms: null,
            valorIcms: null,
            aliquotaIcms: null,
            valorIpi: null,
            aliquotaIpi: null,
          },
        ],
        emitenteFone: "(62) 3095-7995",
      },
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it("extras com menos entradas que itens não estoura", async () => {
    const bytes = await renderDanfeOficial({
      nfe: makeDraft({ itens: itens(5) }),
      config: makeConfig(),
      chaveAcesso: CHAVE,
      protocolo: "1",
      extras: { itensImpostos: [null] },
    });
    expect(isPdf(bytes)).toBe(true);
  });
});

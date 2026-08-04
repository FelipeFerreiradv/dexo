import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  W,
  X0,
  X1,
  TOTAL_V,
  GAP,
  GRID_FLOOR,
  Y_TOP,
  H_FOOTER,
  PROD_COLUMNS,
  prodColumnsWidth,
  prodColumnOffsets,
  planDanfePages,
  fixedHeightBeforeRows,
  faturaHeight,
  infoHeight,
  itemRowHeight,
  INFO_LINE_H,
} from "../../app/fiscal/generators/danfe-oficial-layout";

describe("grade do DANFE oficial — largura", () => {
  it("a largura útil é exatamente 561.00", () => {
    expect(W).toBeCloseTo(561, 10);
    expect(X1 - X0).toBeCloseTo(561, 10);
  });

  it("as 14 colunas de produtos somam exatamente a largura útil", () => {
    expect(PROD_COLUMNS).toHaveLength(14);
    expect(prodColumnsWidth()).toBeCloseTo(W, 10);
  });

  it("os offsets acumulados terminam na borda direita da grade", () => {
    const offs = prodColumnOffsets();
    expect(offs[0]).toBeCloseTo(X0, 10);
    const ultima = PROD_COLUMNS[PROD_COLUMNS.length - 1];
    expect(offs[offs.length - 1] + ultima.width).toBeCloseTo(X1, 10);
    // Estritamente crescente — nenhuma coluna de largura zero ou negativa.
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThan(offs[i - 1]);
  });
});

// ──────────────────────────────────────────────────────────────────
// A verificação que realmente importa: o pdf-lib NÃO avisa quando o texto
// transborda — ele desenha por cima da linha divisória. Medimos as 14 colunas
// (não 3) contra o pior valor realista de cada uma.
// ──────────────────────────────────────────────────────────────────

describe("colunas de produtos — o pior valor realista cabe em cada uma", () => {
  const CELL_PAD = 2; // respiro de cada lado dentro da célula
  const SIZE_VALOR = 5.8;
  const SIZE_ROTULO = 4.8;

  // Pior valor REALISTA por coluna. A DESCRIÇÃO fica de fora: ela é a única
  // que passa por `wrapTextLines`, que fatia até palavra sem espaço — logo não
  // pode transbordar por construção (coberto no teste do renderer).
  const PIOR_CASO: Record<string, string> = {
    codigo: "10000277",
    ncm: "00000000",
    cst: "102",
    cfop: "6108",
    unidade: "UN",
    quantidade: "1.234,0000",
    valorUnitario: "1.234.567,89",
    valorTotal: "1.234.567,89",
    bcIcms: "1.234.567,89",
    valorIcms: "1.234.567,89",
    valorIpi: "1.234.567,89",
    aliqIcms: "100,00",
    aliqIpi: "100,00",
  };

  it("os 13 valores de largura fixa cabem na largura útil da sua coluna", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const estouros: string[] = [];
    for (const col of PROD_COLUMNS) {
      const texto = PIOR_CASO[col.key];
      if (texto === undefined) continue; // descricao
      const util = col.width - CELL_PAD * 2;
      const largura = font.widthOfTextAtSize(texto, SIZE_VALOR);
      if (largura > util) {
        estouros.push(
          `${col.key}: "${texto}" mede ${largura.toFixed(2)}pt em ${util.toFixed(2)}pt úteis`,
        );
      }
    }
    expect(estouros).toEqual([]);
    // Cobertura: só a descrição pode ficar de fora do laço acima.
    const semPiorCaso = PROD_COLUMNS.filter((c) => PIOR_CASO[c.key] === undefined);
    expect(semPiorCaso.map((c) => c.key)).toEqual(["descricao"]);
  });

  it("TODAS as linhas de rótulo do cabeçalho cabem na sua coluna", async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const estouros: string[] = [];
    for (const col of PROD_COLUMNS) {
      const util = col.width - CELL_PAD * 2;
      // A coluna do código tributário troca de rótulo em runtime conforme o
      // regime: "CST" (normal) ou "CSOSN" (Simples). Os DOIS têm que caber.
      const linhas = col.key === "cst" ? ["CST", "CSOSN"] : col.label;
      for (const linha of linhas) {
        const largura = bold.widthOfTextAtSize(linha, SIZE_ROTULO);
        // A DESCRIÇÃO é a única cujo rótulo o renderer pode abreviar.
        if (col.key !== "descricao" && largura > util) {
          estouros.push(
            `${col.key}: rótulo "${linha}" mede ${largura.toFixed(2)}pt em ${util.toFixed(2)}pt`,
          );
        }
      }
    }
    expect(estouros).toEqual([]);
  });

  it("nenhum rótulo passa de 2 linhas (o cabeçalho tem altura fixa)", () => {
    for (const col of PROD_COLUMNS) {
      expect(col.label.length, col.key).toBeGreaterThanOrEqual(1);
      expect(col.label.length, col.key).toBeLessThanOrEqual(2);
    }
  });

  it("a coluna de descrição tem largura de wrap utilizável", () => {
    const desc = PROD_COLUMNS.find((c) => c.key === "descricao")!;
    expect(desc.width - CELL_PAD * 2).toBeGreaterThan(100);
  });
});

// ──────────────────────────────────────────────────────────────────
// Alturas variáveis — o defeito da primeira grade era congelar FATURA e
// DADOS ADICIONAIS em constantes e planejar itens abaixo do piso da página.
// ──────────────────────────────────────────────────────────────────

describe("faturaHeight — cresce com as duplicatas", () => {
  it("sem duplicatas o quadro existe, mas é o menor possível", () => {
    expect(faturaHeight(0)).toBe(26);
  });

  it("cresce em degraus de linha e é monotônica", () => {
    let anterior = faturaHeight(0);
    for (let n = 1; n <= 40; n++) {
      const h = faturaHeight(n);
      expect(h, `n=${n}`).toBeGreaterThanOrEqual(anterior);
      anterior = h;
    }
    // 7 duplicatas já ocupam 2 linhas — é o caso que estourava a grade antiga.
    expect(faturaHeight(7)).toBeGreaterThan(faturaHeight(4));
    expect(faturaHeight(12)).toBeGreaterThan(faturaHeight(7));
  });

  it("entrada inválida não vira NaN", () => {
    expect(faturaHeight(-5)).toBe(26);
    expect(faturaHeight(NaN)).toBe(26);
  });
});

describe("infoHeight — cresce com as linhas do infCpl", () => {
  it("tem piso mesmo sem informações", () => {
    expect(infoHeight(0)).toBeGreaterThan(0);
    expect(infoHeight(0)).toBe(infoHeight(1));
  });

  it("é monotônica e cresce de verdade em textos longos", () => {
    expect(infoHeight(100)).toBeGreaterThan(infoHeight(10));
    let anterior = 0;
    for (let n = 0; n <= 200; n += 7) {
      const h = infoHeight(n);
      expect(h).toBeGreaterThanOrEqual(anterior);
      anterior = h;
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// A invariante central: NADA pode ser planejado abaixo de GRID_FLOOR.
// ──────────────────────────────────────────────────────────────────

// Recomputa a altura ocupada por uma folha a partir das FLAGS do plano, sem
// reusar a aritmética interna do planejador — é isso que faz o teste detectar
// erro de distribuição em vez de repeti-lo.
function alturaUsadaNaPagina(
  plan: ReturnType<typeof planDanfePages>,
  pageIndex: number,
  lineCounts: number[],
  dupCount: number,
): number {
  const p = plan.pages[pageIndex];
  const fixo = fixedHeightBeforeRows(pageIndex, dupCount, p.hasItemsTable);
  const itens = lineCounts
    .slice(p.startItem, p.endItem)
    .reduce((acc, n) => acc + itemRowHeight(n), 0);
  const info = p.hasInfo
    ? GAP + infoHeight(p.infoLineEnd - p.infoLineStart)
    : 0;
  return fixo + itens + info + GAP + H_FOOTER;
}

describe("planDanfePages — nada desce abaixo do piso da grade", () => {
  const CENARIOS: Array<{
    nome: string;
    itens: number[];
    infoLines: number;
    dups: number;
  }> = [
    { nome: "nota mínima (1 item)", itens: [1], infoLines: 0, dups: 0 },
    { nome: "nota sem itens", itens: [], infoLines: 0, dups: 0 },
    { nome: "17 itens de 1 linha", itens: Array(17).fill(1), infoLines: 0, dups: 0 },
    { nome: "18 itens de 1 linha", itens: Array(18).fill(1), infoLines: 0, dups: 0 },
    { nome: "60 itens", itens: Array(60).fill(1), infoLines: 4, dups: 0 },
    { nome: "200 itens", itens: Array(200).fill(2), infoLines: 10, dups: 0 },
    { nome: "descrições de 3 linhas", itens: Array(30).fill(3), infoLines: 6, dups: 2 },
    { nome: "7 duplicatas (o caso que estourava)", itens: Array(20).fill(1), infoLines: 3, dups: 7 },
    { nome: "12 duplicatas", itens: Array(20).fill(1), infoLines: 3, dups: 12 },
    { nome: "40 duplicatas", itens: Array(10).fill(1), infoLines: 0, dups: 40 },
    { nome: "infCpl de 5000 chars (~90 linhas)", itens: Array(5).fill(1), infoLines: 90, dups: 0 },
    { nome: "infCpl gigante + muitos itens + muitas dups", itens: Array(120).fill(2), infoLines: 120, dups: 15 },
  ];

  it.each(CENARIOS)("$nome: toda folha fecha dentro de TOTAL_V", (c) => {
    const plan = planDanfePages({
      itemLineCounts: c.itens,
      infoLineCount: c.infoLines,
      duplicataCount: c.dups,
    });

    expect(plan.totalPages).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < plan.pages.length; i++) {
      const usado = alturaUsadaNaPagina(plan, i, c.itens, c.dups);
      expect(
        usado,
        `folha ${i + 1}/${plan.totalPages} de "${c.nome}" usa ${usado.toFixed(2)}pt`,
      ).toBeLessThanOrEqual(TOTAL_V + 1e-9);
      // Traduzido para coordenada: o último traço nunca cruza o piso.
      expect(Y_TOP - usado).toBeGreaterThanOrEqual(GRID_FLOOR - H_FOOTER - GAP - 1e-9);
    }
  });

  it.each(CENARIOS)("$nome: nenhum item é perdido nem duplicado", (c) => {
    const plan = planDanfePages({
      itemLineCounts: c.itens,
      infoLineCount: c.infoLines,
      duplicataCount: c.dups,
    });
    const cobertos: number[] = [];
    for (const p of plan.pages) {
      for (let i = p.startItem; i < p.endItem; i++) cobertos.push(i);
    }
    expect(cobertos).toEqual(c.itens.map((_, i) => i));
  });

  it.each(CENARIOS)("$nome: nenhuma linha de infCpl é truncada", (c) => {
    const plan = planDanfePages({
      itemLineCounts: c.itens,
      infoLineCount: c.infoLines,
      duplicataCount: c.dups,
    });
    const desenhadas = plan.pages.reduce(
      (acc, p) => acc + (p.infoLineEnd - p.infoLineStart),
      0,
    );
    expect(desenhadas).toBe(c.infoLines);

    // E as fatias são contíguas, sem sobreposição.
    let esperado = 0;
    for (const p of plan.pages) {
      if (p.infoLineEnd > p.infoLineStart) {
        expect(p.infoLineStart).toBe(esperado);
        esperado = p.infoLineEnd;
      }
    }
  });

  it("o quadro DADOS ADICIONAIS aparece exatamente uma vez quando não pagina", () => {
    const plan = planDanfePages({
      itemLineCounts: Array(3).fill(1),
      infoLineCount: 5,
      duplicataCount: 0,
    });
    expect(plan.pages.filter((p) => p.hasInfo)).toHaveLength(1);
    expect(plan.totalPages).toBe(1);
  });

  it("infCpl que não cabe ganha folha própria em vez de ser cortado", () => {
    // Muitos itens enchendo a última folha + infCpl longo.
    const plan = planDanfePages({
      itemLineCounts: Array(80).fill(1),
      infoLineCount: 200,
      duplicataCount: 0,
    });
    const desenhadas = plan.pages.reduce(
      (acc, p) => acc + (p.infoLineEnd - p.infoLineStart),
      0,
    );
    expect(desenhadas).toBe(200);
    expect(plan.totalPages).toBeGreaterThan(2);
  });

  it("REGRESSÃO 7+ duplicatas: a folha 1 tem MENOS espaço para itens que com 0", () => {
    const com0 = planDanfePages({ itemLineCounts: Array(50).fill(1), infoLineCount: 0, duplicataCount: 0 });
    const com7 = planDanfePages({ itemLineCounts: Array(50).fill(1), infoLineCount: 0, duplicataCount: 7 });
    // O planejador tem que REAGIR à duplicata; se ele ignorasse (o bug antigo),
    // os dois espaços seriam idênticos.
    expect(com7.pages[0].availableForRows).toBeLessThan(com0.pages[0].availableForRows);
    expect(com7.pages[0].endItem).toBeLessThanOrEqual(com0.pages[0].endItem);
  });

  it("folhas de continuação cabem mais itens (não repetem dest/imposto/transp)", () => {
    const plan = planDanfePages({
      itemLineCounts: Array(120).fill(1),
      infoLineCount: 0,
      duplicataCount: 0,
    });
    const naFolha1 = plan.pages[0].endItem - plan.pages[0].startItem;
    const naFolha2 = plan.pages[1].endItem - plan.pages[1].startItem;
    expect(naFolha2).toBeGreaterThan(naFolha1);
  });

  it("entrada degenerada não trava nem estoura", () => {
    expect(() =>
      planDanfePages({ itemLineCounts: [], infoLineCount: 0, duplicataCount: 0 }),
    ).not.toThrow();
    const plan = planDanfePages({
      itemLineCounts: [999],
      infoLineCount: 0,
      duplicataCount: 0,
    });
    // Item absurdamente alto: ainda assim entra numa folha, sem laço infinito.
    expect(plan.totalPages).toBeGreaterThanOrEqual(1);
    expect(plan.pages[0].endItem).toBe(1);
  });

  it("infoLinesPerFullPage é positivo e coerente com INFO_LINE_H", () => {
    const plan = planDanfePages({
      itemLineCounts: Array(200).fill(1),
      infoLineCount: 500,
      duplicataCount: 0,
    });
    const folhasSoDeInfo = plan.pages.filter((p) => p.startItem === p.endItem && p.hasInfo);
    expect(folhasSoDeInfo.length).toBeGreaterThan(0);
    for (const p of folhasSoDeInfo) {
      const linhas = p.infoLineEnd - p.infoLineStart;
      expect(linhas * INFO_LINE_H).toBeLessThanOrEqual(TOTAL_V);
    }
  });
});

/**
 * Grade e planejador de páginas do DANFE oficial (ATO COTEPE/ICMS 51/15).
 *
 * Módulo PURO: só aritmética de layout, sem pdf-lib e sem I/O. O renderer faz
 * DUAS PASSADAS — mede o texto (única coisa que precisa de fonte), chama
 * `planDanfePages()` para saber quantas folhas existem e o que vai em cada uma,
 * e só então desenha. É isso que permite escrever "FOLHA 1/3" na primeira
 * folha: o total já é conhecido antes do primeiro `drawText`.
 *
 * REGRA DURA: nenhuma altura de bloco pode ser um literal mágico aqui dentro.
 * Blocos que crescem com o conteúdo (FATURA/DUPLICATA com muitas parcelas,
 * DADOS ADICIONAIS com informações complementares longas) têm que ser
 * calculados em runtime — foi exatamente por congelar essas alturas que a
 * primeira versão desta grade desenhava itens abaixo do piso da página.
 */

// ═══════════════════════════════════════════════════════════════════
// Página
// ═══════════════════════════════════════════════════════════════════

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

/** Margem lateral escolhida para a largura útil dar um número redondo. */
export const MARGIN_X = 17.14;
export const X0 = MARGIN_X;
/** Largura útil da grade: 595.28 − 2×17.14 = 561.00 exato. */
export const W = PAGE_W - 2 * MARGIN_X;
export const X1 = X0 + W;

export const MARGIN_TOP = 14;
export const Y_TOP = PAGE_H - MARGIN_TOP;
/** Nenhum traço da grade desce abaixo disto. */
export const GRID_FLOOR = 30;
/** Baseline do rodapé (abaixo do piso da grade). */
export const FOOTER_BASELINE = 18;

/** Espaço vertical total disponível para os blocos da grade. */
export const TOTAL_V = Y_TOP - GRID_FLOOR; // 797.89

/** Respiro entre grupos de bloco. */
export const GAP = 2;

// ═══════════════════════════════════════════════════════════════════
// Alturas de bloco
// ═══════════════════════════════════════════════════════════════════

/** Faixa de título de seção ("DESTINATÁRIO / REMETENTE" etc.). */
export const STRIP_H = 11;
/** Linha de campos rotulados (rótulo em cima, valor embaixo). */
export const FIELD_ROW_H = 24;

/** Canhoto + linha tracejada de corte. Só na primeira folha. */
export const H_CANHOTO_BOX = 38;
export const H_CANHOTO = H_CANHOTO_BOX + 12;

/** Bloco de identificação (emitente | DANFE | fisco + natureza + IE/CNPJ). */
export const H_IDENT_BAND = 100;
export const H_IDENT = H_IDENT_BAND + FIELD_ROW_H + FIELD_ROW_H; // 148

/** DESTINATÁRIO / REMETENTE — 3 linhas de campos. */
export const H_DEST = STRIP_H + 3 * FIELD_ROW_H; // 83

/** CÁLCULO DO IMPOSTO — 2 linhas de campos. */
export const H_IMPOSTO = STRIP_H + 2 * FIELD_ROW_H; // 59

/** TRANSPORTADOR / VOLUMES TRANSPORTADOS — 3 linhas de campos. */
export const H_TRANSP = STRIP_H + 3 * FIELD_ROW_H; // 83

/** Cabeçalho da tabela de produtos (faixa + linha de rótulos de coluna). */
export const PROD_HEADER_H = 16;
export const H_PROD_HEADER = STRIP_H + PROD_HEADER_H; // 27

/** Altura de UMA linha de descrição dentro da linha de item. */
export const ITEM_LINE_H = 7.2;
/** Respiro vertical da linha de item (acima + abaixo do texto). */
export const ITEM_PAD_V = 3.6;

/** Altura da linha de um item com `lines` linhas de descrição. */
export function itemRowHeight(lines: number): number {
  const n = Math.max(1, Math.floor(lines) || 1);
  return ITEM_PAD_V + n * ITEM_LINE_H + ITEM_PAD_V;
}

/** Rodapé (crédito do emissor). */
export const H_FOOTER = 12;

// ── FATURA / DUPLICATA — altura VARIÁVEL ──

/** Quantas duplicatas cabem lado a lado numa linha do quadro. */
export const DUP_PER_ROW = 4;
export const DUP_ROW_H = 17;
/** Altura do corpo quando NÃO há duplicatas (quadro vazio, como no modelo). */
export const DUP_EMPTY_BODY_H = 15;

/**
 * Altura do quadro FATURA / DUPLICATA para `n` duplicatas.
 *
 * Não existe teto de parcelas no formulário (`step-duplicatas.tsx` só faz
 * `fields.length + 1`) nem no builder de XML, então este bloco pode crescer
 * bastante — e é por isso que ele NÃO pode ser constante no planejador.
 */
export function faturaHeight(duplicataCount: number): number {
  const n = Math.max(0, Math.floor(duplicataCount) || 0);
  if (n === 0) return STRIP_H + DUP_EMPTY_BODY_H;
  const rows = Math.ceil(n / DUP_PER_ROW);
  return STRIP_H + rows * DUP_ROW_H + 2;
}

// ── DADOS ADICIONAIS — altura VARIÁVEL ──

export const INFO_LINE_H = 7;
/**
 * Altura mínima do corpo — o quadro "DADOS ADICIONAIS / RESERVADO AO FISCO"
 * existe mesmo numa nota sem informações complementares (é assim no modelo).
 *
 * ⚠️ Este piso é armadilha para o planejador: orçar `linhas × INFO_LINE_H` e
 * desenhar `max(piso, …)` faz o bloco ocupar mais do que foi reservado. Por
 * isso o planejador NUNCA fatia o bloco — ou ele cabe inteiro, ou vai para
 * folha própria (ver `planDanfePages`).
 */
export const INFO_MIN_BODY_H = 30;
export const INFO_PAD_V = 6;

/** Altura do quadro DADOS ADICIONAIS para `lines` linhas de infCpl. */
export function infoHeight(lines: number): number {
  const n = Math.max(0, Math.floor(lines) || 0);
  const body = Math.max(INFO_MIN_BODY_H, n * INFO_LINE_H + INFO_PAD_V);
  return STRIP_H + body;
}

/**
 * Quantas linhas de infCpl cabem numa folha inteiramente dedicada ao bloco
 * (usada quando as informações complementares não cabem junto com os itens).
 * Essa folha não repete o cabeçalho da tabela de produtos.
 */
export function infoLinesPerFullPage(): number {
  const disponivel =
    TOTAL_V - H_IDENT - GAP - STRIP_H - INFO_PAD_V - GAP - H_FOOTER;
  return Math.max(1, Math.floor(disponivel / INFO_LINE_H));
}

// ═══════════════════════════════════════════════════════════════════
// Planejador
// ═══════════════════════════════════════════════════════════════════

export interface DanfePlanInput {
  /** Nº de linhas de descrição de CADA item, na ordem, já medidas com a fonte. */
  itemLineCounts: number[];
  /** Nº de linhas do infCpl, já quebradas com a fonte. 0 = sem informações. */
  infoLineCount: number;
  /** Nº de duplicatas do quadro FATURA / DUPLICATA. */
  duplicataCount: number;
}

export interface DanfePlanPage {
  /** Índice do primeiro item desta folha (igual a `endItem` quando não há itens). */
  startItem: number;
  /** Índice (exclusivo) do último item desta folha. */
  endItem: number;
  /** Fatia das linhas de infCpl desenhada nesta folha (vazio = nenhuma). */
  infoLineStart: number;
  infoLineEnd: number;
  /** `true` quando o quadro DADOS ADICIONAIS aparece nesta folha. */
  hasInfo: boolean;
  /**
   * `true` quando esta folha desenha o quadro DADOS DOS PRODUTOS (faixa +
   * rótulos de coluna). Folhas dedicadas só ao infCpl não o desenham.
   */
  hasItemsTable: boolean;
  /** Espaço vertical que sobrou para a tabela de itens nesta folha. */
  availableForRows: number;
}

export interface DanfePlan {
  pages: DanfePlanPage[];
  totalPages: number;
}

/**
 * Altura fixa consumida ANTES da tabela de itens, por folha.
 *
 * Folha 1 traz a nota inteira (canhoto, identificação, destinatário, fatura,
 * imposto, transportador). Folhas de continuação repetem só a identificação —
 * é o que a norma manda e o que o modelo de referência faz.
 */
export function fixedHeightBeforeRows(
  pageIndex: number,
  duplicataCount: number,
  hasItemsTable = true,
): number {
  const tabela = hasItemsTable ? GAP + H_PROD_HEADER : 0;
  if (pageIndex === 0) {
    return (
      H_CANHOTO +
      GAP +
      H_IDENT +
      GAP +
      H_DEST +
      GAP +
      faturaHeight(duplicataCount) +
      GAP +
      H_IMPOSTO +
      GAP +
      H_TRANSP +
      tabela
    );
  }
  return H_IDENT + tabela;
}

/**
 * Distribui itens e informações complementares em folhas.
 *
 * Garantias:
 *  • nenhum item é descartado;
 *  • nenhuma linha de infCpl é descartada (o bloco pagina e, se preciso, ganha
 *    folha própria) — truncar informação fiscal não é opção;
 *  • nada é planejado abaixo de `GRID_FLOOR`.
 */
export function planDanfePages(input: DanfePlanInput): DanfePlan {
  const itemLineCounts = input.itemLineCounts ?? [];
  const infoLines = Math.max(0, Math.floor(input.infoLineCount) || 0);
  const dupCount = Math.max(0, Math.floor(input.duplicataCount) || 0);

  const rowHeights = itemLineCounts.map((n) => itemRowHeight(n));
  const pages: DanfePlanPage[] = [];

  /**
   * Distribui os itens em folhas, reservando `reserve` pt em CADA folha.
   *
   * Com `reserve > 0` a última folha fica com pelo menos `reserve` pt livres
   * por construção (a capacidade por folha vira `disponivel − reserve`), que é
   * o que garante espaço para o quadro DADOS ADICIONAIS sem precisar adivinhar
   * qual folha será a última.
   */
  const distribuir = (reserve: number): DanfePlanPage[] => {
    const out: DanfePlanPage[] = [];
    let cursor = 0;
    let pageIndex = 0;

    // Roda ao menos uma vez: nota sem itens ainda tem a folha 1.
    do {
      const fixo = fixedHeightBeforeRows(pageIndex, dupCount, true);
      const disponivel = TOTAL_V - fixo - GAP - H_FOOTER;
      const capacidade = disponivel - reserve;

      let usado = 0;
      const start = cursor;
      while (cursor < rowHeights.length && usado + rowHeights[cursor] <= capacidade) {
        usado += rowHeights[cursor];
        cursor++;
      }

      // Item mais alto que a capacidade da folha: força pelo menos um, senão o
      // laço nunca avança. Um planejador que pode travar é pior que um layout
      // apertado — e o desenho continua dentro da página porque `disponivel`
      // ainda comporta a linha.
      if (cursor === start && cursor < rowHeights.length) {
        usado += rowHeights[cursor];
        cursor++;
      }

      out.push({
        startItem: start,
        endItem: cursor,
        infoLineStart: 0,
        infoLineEnd: 0,
        hasInfo: false,
        hasItemsTable: true,
        availableForRows: disponivel,
      });
      pageIndex++;
    } while (cursor < rowHeights.length);

    return out;
  };

  const sobraDaUltima = (lista: DanfePlanPage[]): number => {
    const u = lista[lista.length - 1];
    const alturaItens = rowHeights
      .slice(u.startItem, u.endItem)
      .reduce((a, b) => a + b, 0);
    return u.availableForRows - alturaItens;
  };

  // ── 1ª tentativa: sem reserva (caso comum — o bloco cabe na sobra) ──
  pages.push(...distribuir(0));
  const precisa = infoHeight(infoLines) + GAP;

  if (precisa <= sobraDaUltima(pages)) {
    const u = pages[pages.length - 1];
    u.hasInfo = true;
    u.infoLineStart = 0;
    u.infoLineEnd = infoLines;
    return { pages, totalPages: pages.length };
  }

  // ── 2ª tentativa: reserva em todas as folhas ──
  // Empurra alguns itens para a folha seguinte em vez de gastar uma folha
  // inteira só para duas linhas de observação.
  const comReserva = distribuir(precisa);
  if (precisa <= sobraDaUltima(comReserva)) {
    const u = comReserva[comReserva.length - 1];
    u.hasInfo = true;
    u.infoLineStart = 0;
    u.infoLineEnd = infoLines;
    return { pages: comReserva, totalPages: comReserva.length };
  }

  // ── Fallback: o bloco é mais alto que uma folha de itens ──
  // Folhas dedicadas, sem tabela de produtos. O bloco NUNCA é truncado.
  const porFolha = infoLinesPerFullPage();
  let desenhadas = 0;
  do {
    const fim = Math.min(desenhadas + porFolha, infoLines);
    pages.push({
      startItem: rowHeights.length,
      endItem: rowHeights.length,
      infoLineStart: desenhadas,
      infoLineEnd: fim,
      hasInfo: true,
      hasItemsTable: false,
      availableForRows: 0,
    });
    desenhadas = fim;
  } while (desenhadas < infoLines);

  return { pages, totalPages: pages.length };
}

// ═══════════════════════════════════════════════════════════════════
// Colunas da tabela de produtos
// ═══════════════════════════════════════════════════════════════════

export interface ProdColumn {
  key: string;
  /**
   * Rótulo do cabeçalho, uma entrada por linha. O DANFE oficial empilha os
   * rótulos das colunas estreitas em duas linhas ("VALOR" / "UNIT."), que é
   * como o modelo de referência faz e o que permite colunas de 26pt.
   */
  label: readonly string[];
  width: number;
  align: "left" | "right" | "center";
}

/**
 * As 14 colunas do quadro DADOS DOS PRODUTOS / SERVIÇOS, na ordem do modelo.
 *
 * As larguras somam EXATAMENTE `W` (561.00). Há um teste que refaz a soma e
 * outro que mede, com o próprio pdf-lib, o pior valor realista de CADA coluna
 * monetária e CADA linha de rótulo contra a largura útil — o pdf-lib não avisa
 * quando o texto vaza: ele desenha por cima da linha divisória vizinha.
 */
export const PROD_COLUMNS: readonly ProdColumn[] = [
  { key: "codigo", label: ["CÓDIGO"], width: 44, align: "left" },
  { key: "descricao", label: ["DESCRIÇÃO DO PRODUTO / SERVIÇO"], width: 122, align: "left" },
  { key: "ncm", label: ["NCM/SH"], width: 36, align: "center" },
  // Larga o bastante para "CSOSN" (Simples), não só "CST" — o rótulo é
  // trocado em runtime conforme o regime tributário do emitente.
  { key: "cst", label: ["CST"], width: 26, align: "center" },
  { key: "cfop", label: ["CFOP"], width: 24, align: "center" },
  { key: "unidade", label: ["UNID"], width: 20, align: "center" },
  { key: "quantidade", label: ["QUANT."], width: 36, align: "right" },
  { key: "valorUnitario", label: ["VALOR", "UNIT."], width: 40, align: "right" },
  { key: "valorTotal", label: ["VALOR", "TOTAL"], width: 40, align: "right" },
  { key: "bcIcms", label: ["B.CÁLC", "ICMS"], width: 40, align: "right" },
  { key: "valorIcms", label: ["VALOR", "ICMS"], width: 40, align: "right" },
  { key: "valorIpi", label: ["VALOR", "IPI"], width: 40, align: "right" },
  { key: "aliqIcms", label: ["ALÍQ.", "ICMS %"], width: 26, align: "right" },
  { key: "aliqIpi", label: ["ALÍQ.", "IPI %"], width: 27, align: "right" },
];

/** Soma das larguras das colunas — tem que ser exatamente `W`. */
export function prodColumnsWidth(): number {
  return PROD_COLUMNS.reduce((acc, c) => acc + c.width, 0);
}

/** Posição x inicial de cada coluna, acumulada a partir de `X0`. */
export function prodColumnOffsets(): number[] {
  const out: number[] = [];
  let x = X0;
  for (const c of PROD_COLUMNS) {
    out.push(x);
    x += c.width;
  }
  return out;
}

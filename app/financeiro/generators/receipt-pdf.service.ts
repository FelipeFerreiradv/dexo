import fs from "node:fs";
import path from "node:path";
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";
import type { FinanceEntry } from "../../interfaces/finance.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import { paymentMethodLabel } from "../../lib/payment-methods";
import {
  maskCnpj,
  maskCpf,
  maskCep,
  maskMoneyBRL,
} from "../../lib/masks";

/**
 * Gera um PDF "Cupom sem validade fiscal" (venda balcão) a partir
 * de uma Receivable. Layout A4 alinhado à identidade visual do
 * sistema (paleta primary lime/verde-amarelada, cards lado a lado,
 * tabela zebrada, total destacado).
 */
export class ReceiptPdfService {
  async generate(
    entry: FinanceEntry,
    company: CompanyFiscalConfig | null,
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]); // A4
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const logo = await tryEmbedLogo(doc);

    const ctx: RenderCtx = {
      doc,
      page,
      font,
      fontBold,
      logo,
      palette: PALETTE,
    };

    // ── Header: logo, branding, chip SEM VALIDADE FISCAL ──
    const afterHeaderY = drawHeader(ctx, entry);

    // ── Título principal ──
    const afterTitleY = drawTitle(ctx, afterHeaderY - 16);

    // ── Cards Empresa | Cliente lado a lado ──
    const afterCardsY = drawParties(ctx, afterTitleY - 24, entry, company);

    // ── Itens da venda (tabela, paginada) ── pode adicionar páginas e
    // reatribuir ctx.page para a última página em uso.
    const afterItemsY = drawItems(ctx, afterCardsY - 24, entry);

    // ── Totais (direita) ── quebra de página se faltar espaço.
    const afterTotalsY = drawTotals(ctx, afterItemsY - 12, entry);

    // ── Pagamento ──
    drawPayment(ctx, afterTotalsY - 20, entry);

    // ── Footer (na última página) ──
    drawFooter(ctx, entry);

    // ── Numeração "Página X de Y" em TODAS as páginas (após paginar) ──
    stampPageNumbers(ctx);

    return doc.save();
  }
}

// ═════════════════════════════════════════════════════════════════
// Paleta — derivada do design system (globals.css)
// primary: oklch(0.85052 0.17398 94.84) ≈ #D3DE44 (lime-yellow)
// ═════════════════════════════════════════════════════════════════

const PALETTE = {
  ink: rgb(0.09, 0.09, 0.11),
  muted: rgb(0.46, 0.46, 0.5),
  subtle: rgb(0.62, 0.62, 0.67),
  border: rgb(0.89, 0.89, 0.91),
  softBg: rgb(0.975, 0.975, 0.98),
  cardBg: rgb(0.98, 0.98, 0.985),
  primary: rgb(0.83, 0.87, 0.27),
  primaryInk: rgb(0.11, 0.13, 0.03),
  alert: rgb(0.78, 0.16, 0.12),
  white: rgb(1, 1, 1),
};

const MARGIN = 40;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - MARGIN * 2;
// Espaço reservado na base p/ rodapé legal + numeração de página. Itens e o
// bloco de totais nunca descem abaixo disso (MARGIN + FOOTER_RESERVE).
const FOOTER_RESERVE = 72;
const ROW_H = 22;

type RenderCtx = {
  // doc é necessário para adicionar páginas durante a paginação dos itens.
  doc: PDFDocument;
  // page é MUTÁVEL: aponta sempre para a página em uso (a última, após quebras).
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  logo: PDFImage | null;
  palette: typeof PALETTE;
};

// ═════════════════════════════════════════════════════════════════
// Header
// ═════════════════════════════════════════════════════════════════

function drawHeader(ctx: RenderCtx, entry: FinanceEntry): number {
  const { page, font, fontBold, logo, palette } = ctx;
  const top = PAGE_H - MARGIN;

  // Logo (quadrado arredondado com fundo primary)
  const logoSize = 42;
  const logoX = MARGIN;
  const logoY = top - logoSize;

  page.drawRectangle({
    x: logoX,
    y: logoY,
    width: logoSize,
    height: logoSize,
    color: palette.primary,
    borderColor: palette.border,
    borderWidth: 0.5,
  });
  if (logo) {
    const pad = 4;
    const inner = logoSize - pad * 2;
    const scale = Math.min(
      inner / logo.width,
      inner / logo.height,
    );
    const w = logo.width * scale;
    const h = logo.height * scale;
    page.drawImage(logo, {
      x: logoX + (logoSize - w) / 2,
      y: logoY + (logoSize - h) / 2,
      width: w,
      height: h,
    });
  } else {
    drawTextCentered(
      page,
      fontBold,
      "D",
      logoX + logoSize / 2,
      logoY + logoSize / 2 - 8,
      20,
      palette.primaryInk,
    );
  }

  // Brand text
  const brandX = logoX + logoSize + 12;
  page.drawText("Dexo", {
    x: brandX,
    y: top - 18,
    size: 16,
    font: fontBold,
    color: palette.ink,
  });
  page.drawText("Plataforma de gestão", {
    x: brandX,
    y: top - 32,
    size: 9,
    font,
    color: palette.muted,
  });

  // Chip "SEM VALIDADE FISCAL" + metadados à direita
  const chipText = "SEM VALIDADE FISCAL";
  const chipPaddingX = 10;
  const chipPaddingY = 5;
  const chipTextSize = 8;
  const chipTextW = fontBold.widthOfTextAtSize(chipText, chipTextSize);
  const chipW = chipTextW + chipPaddingX * 2;
  const chipH = 18;
  const chipX = PAGE_W - MARGIN - chipW;
  const chipY = top - chipH;

  page.drawRectangle({
    x: chipX,
    y: chipY,
    width: chipW,
    height: chipH,
    color: palette.alert,
  });
  page.drawText(chipText, {
    x: chipX + chipPaddingX,
    y: chipY + chipPaddingY,
    size: chipTextSize,
    font: fontBold,
    color: palette.white,
  });

  // Número do cupom + data
  const shortId = (entry.id || "").slice(0, 8).toUpperCase();
  const now = new Date();
  const idText = `Cupom #${shortId}`;
  const idTextW = fontBold.widthOfTextAtSize(idText, 9);
  page.drawText(idText, {
    x: PAGE_W - MARGIN - idTextW,
    y: chipY - 14,
    size: 9,
    font: fontBold,
    color: palette.ink,
  });
  const dateText = `Emitido em ${formatDateTime(now)}`;
  const dateTextW = font.widthOfTextAtSize(dateText, 8);
  page.drawText(dateText, {
    x: PAGE_W - MARGIN - dateTextW,
    y: chipY - 26,
    size: 8,
    font,
    color: palette.muted,
  });

  // Linha divisória
  const divY = logoY - 14;
  page.drawLine({
    start: { x: MARGIN, y: divY },
    end: { x: PAGE_W - MARGIN, y: divY },
    thickness: 0.5,
    color: palette.border,
  });

  return divY;
}

// ═════════════════════════════════════════════════════════════════
// Título principal
// ═════════════════════════════════════════════════════════════════

function drawTitle(ctx: RenderCtx, y: number): number {
  const { page, font, fontBold, palette } = ctx;

  page.drawText("CUPOM DE VENDA BALCAO", {
    x: MARGIN,
    y,
    size: 20,
    font: fontBold,
    color: palette.ink,
  });
  page.drawText(
    "Documento nao fiscal - emitido para conferencia do comprador",
    {
      x: MARGIN,
      y: y - 16,
      size: 9.5,
      font,
      color: palette.muted,
    },
  );

  return y - 20;
}

// ═════════════════════════════════════════════════════════════════
// Cards Empresa | Cliente
// ═════════════════════════════════════════════════════════════════

function drawParties(
  ctx: RenderCtx,
  y: number,
  entry: FinanceEntry,
  company: CompanyFiscalConfig | null,
): number {
  const { page, font, fontBold, palette } = ctx;

  const gap = 14;
  const cardW = (CONTENT_W - gap) / 2;
  const cardH = 130;
  const cardPad = 14;

  const leftX = MARGIN;
  const rightX = MARGIN + cardW + gap;
  const cardY = y - cardH;

  // Left card — Emitente
  drawCard(ctx, leftX, cardY, cardW, cardH);
  drawEyebrow(ctx, leftX + cardPad, y - 20, "EMITENTE");

  let ly = y - 34;
  const companyName = company?.razaoSocial || "—";
  ly = drawWrapped(
    page,
    fontBold,
    companyName,
    leftX + cardPad,
    ly,
    cardW - cardPad * 2,
    11,
    14,
    palette.ink,
    2,
  );
  if (company?.nomeFantasia) {
    page.drawText(sanitize(company.nomeFantasia), {
      x: leftX + cardPad,
      y: ly,
      size: 9,
      font,
      color: palette.muted,
    });
    ly -= 14;
  }
  ly -= 2;

  drawKV(ctx, leftX + cardPad, ly, "CNPJ", company?.cnpj ? maskCnpj(company.cnpj) : "—", cardW - cardPad * 2);
  ly -= 13;
  drawKV(ctx, leftX + cardPad, ly, "IE", company?.inscricaoEstadual || "—", cardW - cardPad * 2);
  ly -= 13;
  const addr = buildAddressLine(company);
  if (addr) {
    drawWrapped(
      page,
      font,
      addr,
      leftX + cardPad,
      ly,
      cardW - cardPad * 2,
      8.5,
      11,
      palette.ink,
      3,
    );
  } else {
    drawKV(ctx, leftX + cardPad, ly, "Endereco", "—", cardW - cardPad * 2);
  }

  // Right card — Cliente
  drawCard(ctx, rightX, cardY, cardW, cardH);
  drawEyebrow(ctx, rightX + cardPad, y - 20, "CLIENTE");

  let ry = y - 34;
  const clientName = entry.customer?.name || "—";
  ry = drawWrapped(
    page,
    fontBold,
    clientName,
    rightX + cardPad,
    ry,
    cardW - cardPad * 2,
    11,
    14,
    palette.ink,
    2,
  );
  if (entry.customer?.cpf) {
    drawKV(ctx, rightX + cardPad, ry, "CPF", maskCpf(entry.customer.cpf), cardW - cardPad * 2);
    ry -= 13;
  } else {
    drawKV(ctx, rightX + cardPad, ry, "CPF", "—", cardW - cardPad * 2);
    ry -= 13;
  }
  if (entry.customer?.email) {
    drawKV(ctx, rightX + cardPad, ry, "Email", entry.customer.email, cardW - cardPad * 2);
    ry -= 13;
  }

  return cardY;
}

function drawCard(ctx: RenderCtx, x: number, y: number, w: number, h: number) {
  const { page, palette } = ctx;
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    color: palette.cardBg,
    borderColor: palette.border,
    borderWidth: 0.75,
  });
}

function drawEyebrow(ctx: RenderCtx, x: number, y: number, text: string) {
  const { page, fontBold, palette } = ctx;
  page.drawText(text, {
    x,
    y,
    size: 8,
    font: fontBold,
    color: palette.subtle,
  });
}

function drawKV(
  ctx: RenderCtx,
  x: number,
  y: number,
  key: string,
  value: string,
  maxW: number,
) {
  const { page, font, fontBold, palette } = ctx;
  const labelW = 42;
  page.drawText(key, {
    x,
    y,
    size: 8.5,
    font: fontBold,
    color: palette.muted,
  });
  const clean = sanitize(value);
  const size = 9.5;
  const avail = maxW - labelW;
  const truncated = fitText(font, clean, size, avail);
  page.drawText(truncated, {
    x: x + labelW,
    y,
    size,
    font,
    color: palette.ink,
  });
}

// ═════════════════════════════════════════════════════════════════
// Itens
// ═════════════════════════════════════════════════════════════════

// Offsets (a partir da borda DIREITA da tabela) das colunas numéricas.
// Ordem visual: # | Descrição | Qtd | Preço un. | Subtotal.
const COL_QTY_R = 200;
const COL_PRICE_R = 105;
const COL_SUBTOTAL_R = 12;
// Descrição vai de tableX+36 até antes da coluna Qtd.
const COL_DESC_MAX = CONTENT_W - 286;

// Desenha o cabeçalho da tabela de itens em `y` e retorna o novo `y` (abaixo
// da linha de cabeçalho). Reutilizado em cada página da paginação.
function drawItemsTableHeader(ctx: RenderCtx, y: number): number {
  const { page, fontBold, palette } = ctx;
  const tableX = MARGIN;
  const tableW = CONTENT_W;

  page.drawRectangle({
    x: tableX,
    y: y - ROW_H + 6,
    width: tableW,
    height: ROW_H,
    color: palette.softBg,
    borderColor: palette.border,
    borderWidth: 0.5,
  });
  const hy = y - 10;
  page.drawText("#", { x: tableX + 12, y: hy, size: 8.5, font: fontBold, color: palette.muted });
  page.drawText("Descricao", { x: tableX + 36, y: hy, size: 8.5, font: fontBold, color: palette.muted });
  drawTextRight(page, fontBold, "Qtd", tableX + tableW - COL_QTY_R, hy, 8.5, palette.muted);
  drawTextRight(page, fontBold, "Preco un.", tableX + tableW - COL_PRICE_R, hy, 8.5, palette.muted);
  drawTextRight(page, fontBold, "Subtotal", tableX + tableW - COL_SUBTOTAL_R, hy, 8.5, palette.muted);
  return y - ROW_H;
}

// Adiciona uma página de CONTINUAÇÃO (cabeçalho leve: marca + cupom# + divisória),
// reatribui ctx.page para ela e retorna o `y` útil logo abaixo da divisória.
function startContinuationPage(ctx: RenderCtx, entry: FinanceEntry): number {
  const page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.page = page;
  const top = PAGE_H - MARGIN;
  page.drawText("Dexo", {
    x: MARGIN,
    y: top - 12,
    size: 12,
    font: ctx.fontBold,
    color: ctx.palette.ink,
  });
  const shortId = (entry.id || "").slice(0, 8).toUpperCase();
  drawTextRight(
    page,
    ctx.font,
    `Cupom #${shortId} (continuacao)`,
    PAGE_W - MARGIN,
    top - 12,
    9,
    ctx.palette.muted,
  );
  const divY = top - 22;
  page.drawLine({
    start: { x: MARGIN, y: divY },
    end: { x: PAGE_W - MARGIN, y: divY },
    thickness: 0.5,
    color: ctx.palette.border,
  });
  return divY - 16;
}

type ItemRowData = {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
};

// Monta as linhas a partir dos itens estruturados (Fase 4+: ReceivableItem com
// snapshot de unitPrice/quantity, cadastrado OU manual) ou, na ausência, do
// parser legado de debtDetails (apenas descrição + valor).
function buildItemRows(entry: FinanceEntry): ItemRowData[] {
  if (Array.isArray(entry.items) && entry.items.length > 0) {
    return entry.items.map((it: any) => {
      const qty = Number(it.quantity ?? 0);
      const unit = it.unitPrice != null ? Number(it.unitPrice) : null;
      return {
        description: buildItemDescription(it),
        quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
        unitPrice: unit != null && Number.isFinite(unit) ? unit : null,
        amount: Number((qty * Number(it.unitPrice ?? 0)).toFixed(2)),
      };
    });
  }
  // Legado: linhas de texto (debtDetails) — sem qtd/preço unitário estruturado.
  return parseItemLines(entry).map((line, _, arr) => {
    const p = parseItemLine(line, entry, arr.length);
    return { description: p.description, quantity: null, unitPrice: null, amount: p.amount };
  });
}

function drawItems(ctx: RenderCtx, y: number, entry: FinanceEntry): number {
  const { palette } = ctx;
  const tableX = MARGIN;
  const tableW = CONTENT_W;

  drawEyebrow(ctx, MARGIN, y, "ITENS DA VENDA");
  y -= 14;

  const rows = buildItemRows(entry);
  y = drawItemsTableHeader(ctx, y);

  for (let i = 0; i < rows.length; i++) {
    // Quebra de página: se a próxima linha invadiria a área reservada ao
    // rodapé, fecha a tabela aqui, abre página de continuação e redesenha o
    // cabeçalho da tabela. Sem corte — TODOS os itens saem no cupom.
    if (y - ROW_H < MARGIN + FOOTER_RESERVE) {
      ctx.page.drawLine({
        start: { x: tableX, y: y + 6 },
        end: { x: tableX + tableW, y: y + 6 },
        thickness: 0.5,
        color: palette.border,
      });
      y = startContinuationPage(ctx, entry);
      drawEyebrow(ctx, MARGIN, y, "ITENS DA VENDA (continuacao)");
      y -= 14;
      y = drawItemsTableHeader(ctx, y);
    }

    const r = rows[i];
    const zebra = i % 2 === 1;
    if (zebra) {
      ctx.page.drawRectangle({
        x: tableX,
        y: y - ROW_H + 6,
        width: tableW,
        height: ROW_H,
        color: palette.softBg,
      });
    }
    const textY = y - 10;
    ctx.page.drawText(String(i + 1), {
      x: tableX + 12,
      y: textY,
      size: 9,
      font: ctx.font,
      color: palette.subtle,
    });
    ctx.page.drawText(fitText(ctx.font, sanitize(r.description), 9.5, COL_DESC_MAX), {
      x: tableX + 36,
      y: textY,
      size: 9.5,
      font: ctx.font,
      color: palette.ink,
    });
    if (r.quantity != null) {
      drawTextRight(ctx.page, ctx.font, String(r.quantity), tableX + tableW - COL_QTY_R, textY, 9.5, palette.ink);
    }
    if (r.unitPrice != null) {
      drawTextRight(ctx.page, ctx.font, maskMoneyBRL(r.unitPrice), tableX + tableW - COL_PRICE_R, textY, 9.5, palette.ink);
    }
    if (r.amount != null) {
      drawTextRight(ctx.page, ctx.font, maskMoneyBRL(r.amount), tableX + tableW - COL_SUBTOTAL_R, textY, 9.5, palette.ink);
    }
    y -= ROW_H;
  }

  // Borda inferior da tabela
  ctx.page.drawLine({
    start: { x: tableX, y: y + 6 },
    end: { x: tableX + tableW, y: y + 6 },
    thickness: 0.5,
    color: palette.border,
  });

  return y;
}

// ═════════════════════════════════════════════════════════════════
// Totais
// ═════════════════════════════════════════════════════════════════

function drawTotals(
  ctx: RenderCtx,
  y: number,
  entry: FinanceEntry,
): number {
  // Mantém o bloco de totais + pagamento inteiro acima do rodapé. Se não
  // couber na página atual (itens longos terminaram baixo), abre continuação.
  if (y - 190 < MARGIN + FOOTER_RESERVE) {
    y = startContinuationPage(ctx, entry);
  }
  const { page, font, fontBold, palette } = ctx;

  const rightEdge = PAGE_W - MARGIN;
  const blockW = 240;
  const blockX = rightEdge - blockW;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [];
  rows.push({
    label: "Subtotal",
    value: maskMoneyBRL(entry.totalAmount),
    muted: true,
  });
  if (entry.fineAmount && entry.fineAmount > 0) {
    rows.push({
      label: "Multa",
      value: maskMoneyBRL(entry.fineAmount),
      muted: true,
    });
  }
  if (entry.finePercent && entry.finePercent > 0) {
    rows.push({
      label: "Multa (%)",
      value: `${entry.finePercent.toFixed(2)}%`,
      muted: true,
    });
  }
  if (entry.interestPercent && entry.interestPercent > 0) {
    rows.push({
      label: "Juros a.m.",
      value: `${entry.interestPercent.toFixed(2)}%`,
      muted: true,
    });
  }

  for (const r of rows) {
    page.drawText(r.label, {
      x: blockX,
      y,
      size: 9.5,
      font,
      color: r.muted ? palette.muted : palette.ink,
    });
    drawTextRight(
      page,
      font,
      r.value,
      rightEdge,
      y,
      9.5,
      palette.ink,
    );
    y -= 14;
  }

  // Bloco TOTAL destacado
  y -= 4;
  const totalH = 32;
  page.drawRectangle({
    x: blockX,
    y: y - totalH + 8,
    width: blockW,
    height: totalH,
    color: palette.primary,
  });
  page.drawText("TOTAL", {
    x: blockX + 14,
    y: y - 12,
    size: 11,
    font: fontBold,
    color: palette.primaryInk,
  });
  drawTextRight(
    page,
    fontBold,
    maskMoneyBRL(entry.totalAmount),
    rightEdge - 14,
    y - 13,
    14,
    palette.primaryInk,
  );

  return y - totalH;
}

// ═════════════════════════════════════════════════════════════════
// Pagamento
// ═════════════════════════════════════════════════════════════════

function drawPayment(ctx: RenderCtx, y: number, entry: FinanceEntry) {
  // Backstop: se os totais consumiram quase toda a página, joga o bloco de
  // pagamento para uma continuação (geralmente desnecessário — o guard de
  // drawTotals já reserva espaço para totais + pagamento).
  if (y - 80 < MARGIN + FOOTER_RESERVE) {
    y = startContinuationPage(ctx, entry);
  }
  const { page, font, fontBold, palette } = ctx;

  drawEyebrow(ctx, MARGIN, y, "PAGAMENTO");
  y -= 14;

  const installments = entry.installments ?? 1;
  const periodDays = entry.periodDays ?? 30;
  const perInstallment =
    installments > 0 ? entry.totalAmount / installments : entry.totalAmount;
  const due = toDate(entry.dueDate);

  const bullets: string[] = [];
  bullets.push(
    installments > 1
      ? `${installments}x de ${maskMoneyBRL(perInstallment)} a cada ${periodDays} dia(s)`
      : `A vista: ${maskMoneyBRL(entry.totalAmount)}`,
  );
  if (due) {
    bullets.push(
      `${installments > 1 ? "1o vencimento" : "Vencimento"}: ${formatDate(due)}`,
    );
  }
  const metaParts: string[] = [];
  if (entry.document) metaParts.push(`Documento: ${entry.document}`);
  if (entry.reason) metaParts.push(`Motivo: ${entry.reason}`);
  if (metaParts.length) bullets.push(metaParts.join("  ·  "));

  // Forma de pagamento — só quando houver. Sem método => nenhum bullet extra,
  // cupom byte-idêntico ao atual (zero regressão).
  if (entry.paymentMethod) {
    bullets.push(
      `Forma de pagamento: ${paymentMethodLabel(entry.paymentMethod)}`,
    );
  }

  for (const b of bullets) {
    // bullet em primary
    page.drawCircle({
      x: MARGIN + 3,
      y: y + 3,
      size: 2,
      color: palette.primary,
    });
    page.drawText(sanitize(b), {
      x: MARGIN + 12,
      y,
      size: 9.5,
      font,
      color: palette.ink,
    });
    y -= 14;
  }

  // Se houver detalhes extras em debtDetails não usados como item, ignoramos
  // aqui — já aparecem na tabela.
  void fontBold;
}

// ═════════════════════════════════════════════════════════════════
// Footer
// ═════════════════════════════════════════════════════════════════

function drawFooter(ctx: RenderCtx, entry: FinanceEntry) {
  const { page, font, fontBold, palette } = ctx;

  const footerY = MARGIN + 18;

  // Barra decorativa primary
  page.drawRectangle({
    x: MARGIN,
    y: footerY + 40,
    width: 36,
    height: 3,
    color: palette.primary,
  });

  const shortId = (entry.id || "").slice(0, 8).toUpperCase();
  const now = new Date();
  page.drawText(`Cupom #${shortId}`, {
    x: MARGIN,
    y: footerY + 22,
    size: 8.5,
    font: fontBold,
    color: palette.ink,
  });
  page.drawText(`Emitido em ${formatDateTime(now)}`, {
    x: MARGIN + 110,
    y: footerY + 22,
    size: 8.5,
    font,
    color: palette.muted,
  });
  page.drawText(
    "Este documento nao possui validade fiscal.",
    {
      x: MARGIN,
      y: footerY + 6,
      size: 8.5,
      font: fontBold,
      color: palette.alert,
    },
  );
  // A numeração "Pagina X de Y" é estampada em TODAS as páginas por
  // stampPageNumbers (após a paginação concluir), não aqui.
}

// Estampa "Pagina X de Y" no canto inferior direito de cada página. Chamado
// por último, quando o total de páginas já é conhecido.
function stampPageNumbers(ctx: RenderCtx) {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const p = pages[i];
    const label = `Pagina ${i + 1} de ${total}`;
    const w = ctx.font.widthOfTextAtSize(label, 8);
    p.drawText(label, {
      x: PAGE_W - MARGIN - w,
      y: MARGIN + 6,
      size: 8,
      font: ctx.font,
      color: ctx.palette.subtle,
    });
  }
}

// ═════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════

// Cache dos bytes do logo em memória (o arquivo é imutável em runtime).
// `null` = ainda não tentado; `Buffer` = carregado com sucesso;
// `false` = tentativa falhou — não insistimos.
let logoBytesCache: Buffer | false | null = null;

function loadLogoBytes(): Buffer | null {
  if (logoBytesCache === false) return null;
  if (logoBytesCache) return logoBytesCache;
  try {
    const p = path.resolve(process.cwd(), "public", "logo.jpg");
    logoBytesCache = fs.readFileSync(p);
    return logoBytesCache;
  } catch {
    logoBytesCache = false;
    return null;
  }
}

async function tryEmbedLogo(doc: PDFDocument): Promise<PDFImage | null> {
  const bytes = loadLogoBytes();
  if (!bytes) return null;
  try {
    return await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}

function sanitize(text: string): string {
  return (text ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/–|—/g, "-")
    .replace(/ /g, " ");
}

function fitText(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string {
  const clean = sanitize(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let out = clean;
  while (out.length > 1 && font.widthOfTextAtSize(out + "...", size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + "...";
}

function drawTextRight(
  page: PDFPage,
  font: PDFFont,
  text: string,
  xRight: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const clean = sanitize(text);
  const w = font.widthOfTextAtSize(clean, size);
  page.drawText(clean, { x: xRight - w, y, size, font, color });
}

function drawTextCentered(
  page: PDFPage,
  font: PDFFont,
  text: string,
  xCenter: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const clean = sanitize(text);
  const w = font.widthOfTextAtSize(clean, size);
  page.drawText(clean, { x: xCenter - w / 2, y, size, font, color });
}

function drawWrapped(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  lineHeight: number,
  color: ReturnType<typeof rgb>,
  maxLines: number,
): number {
  const clean = sanitize(text);
  const words = clean.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? current + " " + w : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Se sobrou palavra e atingimos o limite, truncar a última linha
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    const truncated = fitText(font, last, size, maxWidth);
    lines[maxLines - 1] = truncated;
  }

  let yCursor = y;
  for (const l of lines) {
    page.drawText(l, { x, y: yCursor, size, font, color });
    yCursor -= lineHeight;
  }
  return yCursor;
}

function buildAddressLine(c: CompanyFiscalConfig | null): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.logradouro) parts.push(c.logradouro);
  if (c.numero) parts.push(c.numero);
  if (c.complemento) parts.push(c.complemento);
  if (c.bairro) parts.push(c.bairro);
  const cityUf = [c.municipio, c.uf].filter(Boolean).join("/");
  if (cityUf) parts.push(cityUf);
  if (c.cep) parts.push(`CEP ${maskCep(c.cep)}`);
  return parts.join(", ");
}

type ParsedItem = { description: string; amount: number | null };

// Constrói a descrição de uma linha do PDF a partir de um ReceivableItem
// estruturado (Fase 4+ — venda balcão). Formato: "<SKU> <nome>" com prefixo
// "<qty>×" quando qty > 1. Mantemos curto para caber na coluna de descrição.
function buildItemDescription(it: any): string {
  const sku = it?.product?.sku ? `${it.product.sku} ` : "";
  // Item cadastrado: nome do Product. Item manual (sem product): description
  // de texto livre. Sem qtd no prefixo — a quantidade tem coluna própria.
  const name = it?.product?.name ?? it?.description ?? "Item";
  return `${sku}${name}`.trim();
}

function parseItemLines(entry: FinanceEntry): string[] {
  const raw = (entry.debtDetails ?? "").trim();
  if (raw) {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
  const fallback = entry.reason || entry.document || "Venda balcao";
  return [fallback];
}

/**
 * Tenta extrair um valor em reais do fim da linha (ex.: "Capô Strada | 1 un | R$ 600,00").
 * Se não encontrar E a conta tiver um único item, usa totalAmount como valor.
 */
function parseItemLine(
  line: string,
  entry: FinanceEntry,
  lineCount: number,
): ParsedItem {
  const m = line.match(
    /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:[.,]\d{1,2})?)\s*$/,
  );
  if (m) {
    const raw = m[1].replace(/\./g, "").replace(",", ".");
    const amount = parseFloat(raw);
    const description = line.slice(0, line.length - m[0].length).replace(/[\s|\-:·—]+$/u, "").trim();
    if (Number.isFinite(amount)) {
      return { description: description || line, amount };
    }
  }
  if (lineCount === 1) {
    return { description: line, amount: entry.totalAmount };
  }
  return { description: line, amount: null };
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

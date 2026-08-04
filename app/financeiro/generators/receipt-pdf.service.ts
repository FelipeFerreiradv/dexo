import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  degrees,
  rgb,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  appendBezierCurve,
  closePath,
  clip,
  endPath,
} from "pdf-lib";
import type { FinanceEntry } from "../../interfaces/finance.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { DanfeAvatar } from "../../fiscal/generators/danfe-v2-renderer";
import { paymentMethodLabel } from "../../lib/payment-methods";
import { maskCnpj, maskCpf, maskCep, maskMoneyBRL } from "../../lib/masks";

/**
 * Cupom SEM validade fiscal (venda balcão), A4.
 *
 * Layout de fatura profissional: identidade do CLIENTE no topo à esquerda,
 * título e selo à direita, seções separadas por filetes finos, totais alinhados
 * à direita e rodapé fixo em duas colunas. Sem faixas coloridas sólidas — a
 * hierarquia vem de tipografia, espaço em branco e réguas.
 *
 * O aviso "SEM VALIDADE FISCAL" é OBRIGATÓRIO e aparece em três lugares
 * independentes (selo no cabeçalho, marca d'água diagonal e rodapé legal): o
 * documento não pode, em hipótese alguma, ser confundido com um fiscal.
 *
 * Nada aqui calcula nada: os valores chegam prontos da `Receivable`.
 */
export class ReceiptPdfService {
  async generate(
    entry: FinanceEntry,
    company: CompanyFiscalConfig | null,
    avatar?: DanfeAvatar | null,
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    let logo: PDFImage | null = null;
    if (avatar) {
      try {
        logo =
          avatar.format === "png"
            ? await doc.embedPng(avatar.bytes)
            : await doc.embedJpg(avatar.bytes);
      } catch {
        logo = null;
      }
    }

    const ctx: RenderCtx = { doc, page, font, fontBold, logo, palette: PALETTE, company };

    const afterHeaderY = drawHeader(ctx, entry, company);
    const afterPartesY = drawParties(ctx, afterHeaderY - 26, entry);
    const afterItemsY = drawItems(ctx, afterPartesY - 18, entry);
    drawTotals(ctx, afterItemsY - 22, entry);
    drawFooter(ctx, entry);
    stampPageChrome(ctx, company);

    return doc.save();
  }
}

// ═════════════════════════════════════════════════════════════════
// Paleta — sóbria, de documento impresso. Sem blocos de cor grandes.
// ═════════════════════════════════════════════════════════════════

const PALETTE = {
  ink: rgb(0.09, 0.09, 0.11),
  muted: rgb(0.42, 0.42, 0.46),
  subtle: rgb(0.58, 0.58, 0.63),
  rule: rgb(0.72, 0.72, 0.75),
  hairline: rgb(0.9, 0.9, 0.92),
  alert: rgb(0.72, 0.11, 0.11),
  alertWash: rgb(0.988, 0.945, 0.941),
  avatarBg: rgb(0.94, 0.94, 0.95),
  white: rgb(1, 1, 1),
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const XL = MARGIN;
const XR = PAGE_W - MARGIN;
const CONTENT_W = XR - XL;
const TOP = PAGE_H - MARGIN;

/** Piso do conteúdo: nada é desenhado abaixo disto. O rodapé é fixo. */
const CONTENT_BOTTOM_Y = 152;
/** Espaço que o bloco de totais precisa por inteiro. */
const TOTALS_H = 136;

const ROW_PAD_V = 8;
const LINE_H = 11.5;
const DESC_MAX_W = 250;
const MAX_DESC_LINES = 2;

type RenderCtx = {
  doc: PDFDocument;
  /** MUTÁVEL: aponta sempre para a página em uso (a última, após quebras). */
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  logo: PDFImage | null;
  palette: typeof PALETTE;
  company: CompanyFiscalConfig | null;
};

// ═════════════════════════════════════════════════════════════════
// Cabeçalho
// ═════════════════════════════════════════════════════════════════

function drawHeader(
  ctx: RenderCtx,
  entry: FinanceEntry,
  company: CompanyFiscalConfig | null,
): number {
  const { page, font, fontBold, logo, palette } = ctx;

  // ── Identidade do CLIENTE (não do Dexo) ──
  const r = 20;
  const cx = XL + r;
  const cy = TOP - r;
  if (logo) {
    page.drawCircle({ x: cx, y: cy, size: r, color: palette.white });
    drawCircularImage(page, logo, cx, cy, r);
  } else {
    page.drawCircle({ x: cx, y: cy, size: r, color: palette.avatarBg });
    drawCentered(page, fontBold, initialsOf(companyName(company)), cx, cy - 5.4, 15, palette.muted);
  }

  const idX = XL + r * 2 + 14;
  const idMaxW = 220;

  let ly = TOP - 14;
  const nomeLinhas = wrapLines(fontBold, companyName(company), idMaxW, 15).slice(0, 2);
  for (const l of nomeLinhas) {
    page.drawText(fitText(fontBold, l, 15, idMaxW), {
      x: idX,
      y: ly,
      size: 15,
      font: fontBold,
      color: palette.ink,
    });
    ly -= 18;
  }

  const fantasia = sanitize(company?.nomeFantasia ?? "");
  if (fantasia && fantasia !== companyName(company)) {
    page.drawText(fitText(font, fantasia, 9, idMaxW), {
      x: idX,
      y: ly,
      size: 9,
      font,
      color: palette.muted,
    });
    ly -= 12;
  }

  const docLinha = [
    company?.cnpj ? `CNPJ ${maskCnpj(company.cnpj)}` : "",
    company?.inscricaoEstadual ? `IE ${company.inscricaoEstadual}` : "",
  ]
    .filter(Boolean)
    .join("   ·   ");
  if (docLinha) {
    page.drawText(fitText(font, docLinha, 8.5, idMaxW), {
      x: idX,
      y: ly,
      size: 8.5,
      font,
      color: palette.ink,
    });
    ly -= 11;
  }

  const addr = buildAddressLine(company);
  if (addr) {
    for (const l of wrapLines(font, addr, idMaxW, 8).slice(0, 2)) {
      page.drawText(fitText(font, l, 8, idMaxW), {
        x: idX,
        y: ly,
        size: 8,
        font,
        color: palette.muted,
      });
      ly -= 10;
    }
  }

  // ── Título, selo e metadados (direita) ──
  drawRight(page, fontBold, "CUPOM DE VENDA", XR, TOP - 16, 20, palette.ink);
  drawRight(page, fontBold, "BALCÃO", XR, TOP - 38, 20, palette.ink);

  // O selo ocupa [TOP-66, TOP-83]; os metadados começam abaixo dele.
  drawSelo(ctx, XR, TOP - 66);

  const shortId = (entry.id || "").slice(0, 8).toUpperCase();
  drawRight(page, fontBold, `Cupom Nº ${shortId}`, XR, TOP - 95, 9, palette.ink);
  drawRight(
    page,
    font,
    `Emitido em ${formatDateTime(new Date())}`,
    XR,
    TOP - 106,
    8,
    palette.muted,
  );

  const divY = TOP - 116;
  rule(page, divY, palette.rule, 0.75);
  return divY;
}

/**
 * Selo "SEM VALIDADE FISCAL": pílula com contorno em vez do retângulo vermelho
 * sólido de antes. Continua inequívoco — vermelho, caixa alta e emoldurado —
 * mas não domina o documento.
 */
function drawSelo(ctx: RenderCtx, xRight: number, yTop: number) {
  const { page, fontBold, palette } = ctx;
  const texto = "SEM VALIDADE FISCAL";
  const size = 8;
  const w = fontBold.widthOfTextAtSize(texto, size) + 20;
  const h = 17;
  const x = xRight - w;
  roundRect(page, x, yTop, w, h, 8.5, {
    color: palette.alertWash,
    borderColor: palette.alert,
    borderWidth: 0.75,
  });
  page.drawText(texto, {
    x: x + 10,
    y: yTop - h + 5.6,
    size,
    font: fontBold,
    color: palette.alert,
  });
}

// ═════════════════════════════════════════════════════════════════
// Cliente | Dados da venda
// ═════════════════════════════════════════════════════════════════

function drawParties(ctx: RenderCtx, y: number, entry: FinanceEntry): number {
  const { page, font, fontBold, palette } = ctx;

  const colW = 230;
  const rightX = XL + 259;
  const rightW = XR - rightX;

  eyebrow(ctx, XL, y, "CLIENTE");
  eyebrow(ctx, rightX, y, "DADOS DA VENDA");

  let ly = y - 17;
  page.drawText(fitText(fontBold, sanitize(entry.customer?.name || "—"), 11.5, colW), {
    x: XL,
    y: ly,
    size: 11.5,
    font: fontBold,
    color: palette.ink,
  });
  ly -= 14;
  if (entry.customer?.cpf) {
    labelValue(ctx, XL, ly, "CPF", maskCpf(entry.customer.cpf), colW);
    ly -= 12;
  }
  if (entry.customer?.email) {
    labelValue(ctx, XL, ly, "E-mail", entry.customer.email, colW);
    ly -= 12;
  }

  let ry = y - 17;
  const linhas: Array<[string, string]> = [];
  if (entry.document) linhas.push(["Documento", entry.document]);
  if (entry.reason) linhas.push(["Motivo", entry.reason]);
  if (entry.unidade?.name) linhas.push(["Unidade", entry.unidade.name]);
  for (const [k, v] of linhas.slice(0, 3)) {
    labelValue(ctx, rightX, ry, k, v, rightW);
    ry -= 12;
  }

  void font;
  return Math.min(ly, ry);
}

// ═════════════════════════════════════════════════════════════════
// Itens
// ═════════════════════════════════════════════════════════════════

const COL_QTY_R = 190;
const COL_PRICE_R = 100;
const COL_TOTAL_R = 0;

type ItemRow = {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
};

/**
 * Monta as linhas a partir dos itens estruturados (venda balcão) ou, na
 * ausência, do parser legado de `debtDetails` (só descrição + valor).
 */
function buildItemRows(entry: FinanceEntry): ItemRow[] {
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
  return parseItemLines(entry).map((line, _, arr) => {
    const p = parseItemLine(line, entry, arr.length);
    return { description: p.description, quantity: null, unitPrice: null, amount: p.amount };
  });
}

/** Cabeçalho da seção de itens. Devolve o `y` da primeira linha de dados. */
function drawItemsHeader(ctx: RenderCtx, y: number, continuacao = false): number {
  const { page, fontBold, palette } = ctx;
  eyebrow(ctx, XL, y, continuacao ? "ITENS (continuação)" : "ITENS");
  const ruleY = y - 8;
  rule(page, ruleY, palette.rule, 0.75);

  const hy = ruleY - 14;
  drawTracked(page, fontBold, "#", XL, hy, 7.5, palette.subtle);
  drawTracked(page, fontBold, "DESCRIÇÃO", XL + 22, hy, 7.5, palette.subtle);
  drawRightTracked(page, fontBold, "QTD", XR - COL_QTY_R, hy, 7.5, palette.subtle);
  drawRightTracked(page, fontBold, "PREÇO UN.", XR - COL_PRICE_R, hy, 7.5, palette.subtle);
  drawRightTracked(page, fontBold, "TOTAL", XR - COL_TOTAL_R, hy, 7.5, palette.subtle);

  const tableTop = hy - 7;
  rule(page, tableTop, palette.hairline, 0.5);
  return tableTop;
}

function rowHeight(lines: number): number {
  return ROW_PAD_V + Math.max(1, lines) * LINE_H + ROW_PAD_V;
}

/**
 * Página de continuação: SÓ o chrome (identidade + nº do cupom + régua).
 * Deliberadamente separada do cabeçalho da tabela — o guard de totais também
 * chama esta função, e desenhar rótulos de coluna ali produziria uma tabela
 * fantasma sem linhas.
 */
function startContinuationPage(ctx: RenderCtx, entry: FinanceEntry): number {
  const page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.page = page;
  page.drawText(fitText(ctx.fontBold, companyName(ctx.company), 9, 300), {
    x: XL,
    y: TOP - 10,
    size: 9,
    font: ctx.fontBold,
    color: ctx.palette.ink,
  });
  const shortId = (entry.id || "").slice(0, 8).toUpperCase();
  drawRight(
    page,
    ctx.font,
    `Cupom Nº ${shortId} · continuação`,
    XR,
    TOP - 10,
    8,
    ctx.palette.muted,
  );
  rule(page, TOP - 22, ctx.palette.rule, 0.75);
  return TOP - 46;
}

function drawItems(ctx: RenderCtx, y: number, entry: FinanceEntry): number {
  const { palette } = ctx;
  const rows = buildItemRows(entry);

  let cur = drawItemsHeader(ctx, y);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const linhas = wrapLines(ctx.font, r.description, DESC_MAX_W, 9.5).slice(0, MAX_DESC_LINES);
    if (linhas.length === 0) linhas.push("");
    const h = rowHeight(linhas.length);

    // A altura é conhecida ANTES do teste, então a linha nunca é cortada ao meio.
    if (cur - h < CONTENT_BOTTOM_Y) {
      rule(ctx.page, cur, palette.rule, 0.75);
      cur = startContinuationPage(ctx, entry);
      cur = drawItemsHeader(ctx, cur, true);
    }

    const baseline = cur - ROW_PAD_V - 9;
    drawTracked(ctx.page, ctx.font, String(i + 1), XL, baseline, 9, palette.subtle);
    linhas.forEach((l, li) => {
      ctx.page.drawText(fitText(ctx.font, l, 9.5, DESC_MAX_W), {
        x: XL + 22,
        y: baseline - li * LINE_H,
        size: 9.5,
        font: ctx.font,
        color: palette.ink,
      });
    });
    if (r.quantity != null) {
      drawRight(ctx.page, ctx.font, formatQty(r.quantity), XR - COL_QTY_R, baseline, 9.5, palette.ink);
    }
    if (r.unitPrice != null) {
      drawRight(ctx.page, ctx.font, maskMoneyBRL(r.unitPrice), XR - COL_PRICE_R, baseline, 9.5, palette.ink);
    }
    if (r.amount != null) {
      drawRight(ctx.page, ctx.fontBold, maskMoneyBRL(r.amount), XR - COL_TOTAL_R, baseline, 9.5, palette.ink);
    }

    cur -= h;
    if (i < rows.length - 1) rule(ctx.page, cur, palette.hairline, 0.5);
  }

  rule(ctx.page, cur, palette.rule, 0.75);
  return cur;
}

// ═════════════════════════════════════════════════════════════════
// Totais
// ═════════════════════════════════════════════════════════════════

function drawTotals(ctx: RenderCtx, y: number, entry: FinanceEntry): number {
  // Mantém o bloco inteiro acima do rodapé — se não couber, abre continuação.
  if (y - TOTALS_H < CONTENT_BOTTOM_Y) {
    y = startContinuationPage(ctx, entry);
  }
  const { page, font, fontBold, palette } = ctx;

  const blockX = XR - 240;

  // Subtotal é INCONDICIONAL (comportamento preservado); os demais só quando > 0.
  const linhas: Array<{ label: string; value: string }> = [
    { label: "Subtotal", value: maskMoneyBRL(entry.totalAmount) },
  ];
  if (entry.fineAmount && entry.fineAmount > 0) {
    linhas.push({ label: "Multa", value: maskMoneyBRL(entry.fineAmount) });
  }
  if (entry.finePercent && entry.finePercent > 0) {
    linhas.push({ label: "Multa (%)", value: formatPercent(entry.finePercent) });
  }
  if (entry.interestPercent && entry.interestPercent > 0) {
    linhas.push({ label: "Juros a.m.", value: formatPercent(entry.interestPercent) });
  }

  let cur = y;
  for (const l of linhas) {
    page.drawText(l.label, { x: blockX, y: cur, size: 9, font, color: palette.muted });
    drawRight(page, font, l.value, XR, cur, 9, palette.ink);
    cur -= 15;
  }

  cur += 4;
  rule(page, cur, palette.hairline, 0.5, blockX);
  cur -= 20;
  page.drawText("TOTAL", { x: blockX, y: cur, size: 11, font: fontBold, color: palette.ink });
  drawRight(page, fontBold, maskMoneyBRL(entry.totalAmount), XR, cur - 2, 16, palette.ink);

  cur -= 11;
  rule(page, cur, palette.rule, 0.75, blockX);
  cur -= 13;
  const due = toDate(entry.dueDate);
  if (due) {
    page.drawText("Vencimento", { x: blockX, y: cur, size: 9, font: fontBold, color: palette.ink });
    drawRight(page, fontBold, formatDate(due), XR, cur, 9, palette.ink);
    cur -= 12;
  }
  return cur;
}

// ═════════════════════════════════════════════════════════════════
// Rodapé (posição FIXA na última página)
// ═════════════════════════════════════════════════════════════════

function drawFooter(ctx: RenderCtx, entry: FinanceEntry) {
  const { page, font, fontBold, palette } = ctx;

  rule(page, 136, palette.rule, 0.75);
  const colRightX = XL + 259;
  eyebrow(ctx, XL, 130, "PAGAMENTO");
  eyebrow(ctx, colRightX, 130, "AVISO");

  const installments = entry.installments ?? 1;
  const periodDays = entry.periodDays ?? 30;
  const perInstallment =
    installments > 0 ? entry.totalAmount / installments : entry.totalAmount;

  const pagamento: string[] = [
    installments > 1
      ? `${installments}x de ${maskMoneyBRL(perInstallment)} a cada ${periodDays} dia(s)`
      : `À vista: ${maskMoneyBRL(entry.totalAmount)}`,
  ];
  const due = toDate(entry.dueDate);
  if (installments > 1 && due) pagamento.push(`1º vencimento: ${formatDate(due)}`);
  if (entry.paymentMethod) {
    pagamento.push(`Forma de pagamento: ${paymentMethodLabel(entry.paymentMethod)}`);
  }

  const aviso = [
    "Este documento não possui validade fiscal.",
    "Não substitui a Nota Fiscal de venda.",
    "Emitido apenas para conferência do comprador.",
  ];

  const baselines = [107, 95, 83];
  pagamento.slice(0, 3).forEach((t, i) => {
    page.drawText(fitText(font, sanitize(t), 8.5, 230), {
      x: XL,
      y: baselines[i],
      size: 8.5,
      font,
      color: palette.ink,
    });
  });
  aviso.forEach((t, i) => {
    page.drawText(fitText(i === 0 ? fontBold : font, t, 8.5, XR - colRightX), {
      x: colRightX,
      y: baselines[i],
      size: 8.5,
      font: i === 0 ? fontBold : font,
      color: i === 0 ? palette.alert : palette.muted,
    });
  });
}

/**
 * Chrome de página + marca d'água, em TODAS as páginas. Roda por último,
 * quando o total de páginas já é conhecido.
 */
function stampPageChrome(ctx: RenderCtx, company: CompanyFiscalConfig | null) {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const p = pages[i];

    // Marca d'água diagonal — reforço do aviso, discreta o bastante para não
    // atrapalhar a leitura nem o toner da impressora.
    p.drawText("SEM VALIDADE FISCAL", {
      x: 74,
      y: 292,
      size: 46,
      font: ctx.fontBold,
      color: ctx.palette.alert,
      opacity: 0.05,
      rotate: degrees(30),
    });

    rule(p, 66, ctx.palette.hairline, 0.5);
    p.drawText(sanitize(`Gerado por Dexo · ${companyName(company)}`), {
      x: XL,
      y: 52,
      size: 7.5,
      font: ctx.font,
      color: ctx.palette.subtle,
    });
    drawRight(p, ctx.font, `Página ${i + 1} de ${total}`, XR, 52, 7.5, ctx.palette.subtle);
  }
}

// ═════════════════════════════════════════════════════════════════
// Primitivas
// ═════════════════════════════════════════════════════════════════

function rule(
  page: PDFPage,
  y: number,
  color: ReturnType<typeof rgb>,
  thickness: number,
  x1 = XL,
  x2 = XR,
) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}

function eyebrow(ctx: RenderCtx, x: number, y: number, text: string) {
  drawTracked(ctx.page, ctx.fontBold, text, x, y, 7.5, ctx.palette.subtle);
}

/** Texto com leve espaçamento entre letras — usado nos rótulos de seção. */
function drawTracked(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
  tracking = 0.7,
) {
  const clean = sanitize(text);
  let cursor = x;
  for (const ch of clean) {
    page.drawText(ch, { x: cursor, y, size, font, color });
    cursor += font.widthOfTextAtSize(ch, size) + tracking;
  }
}

function trackedWidth(font: PDFFont, text: string, size: number, tracking = 0.7): number {
  const clean = sanitize(text);
  if (clean.length === 0) return 0;
  return font.widthOfTextAtSize(clean, size) + tracking * (clean.length - 1);
}

function drawRightTracked(
  page: PDFPage,
  font: PDFFont,
  text: string,
  xRight: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  drawTracked(page, font, text, xRight - trackedWidth(font, text, size), y, size, color);
}

function labelValue(
  ctx: RenderCtx,
  x: number,
  y: number,
  key: string,
  value: string,
  maxW: number,
) {
  const { page, font, fontBold, palette } = ctx;
  page.drawText(key, { x, y, size: 8.5, font: fontBold, color: palette.muted });
  const kx = x + fontBold.widthOfTextAtSize(key, 8.5) + 6;
  page.drawText(fitText(font, sanitize(value), 9, maxW - (kx - x)), {
    x: kx,
    y,
    size: 9,
    font,
    color: palette.ink,
  });
}

function roundRect(
  page: PDFPage,
  x: number,
  top: number,
  w: number,
  h: number,
  r: number,
  opts: Record<string, unknown>,
) {
  const rr = Math.min(r, w / 2, h / 2);
  // `drawSvgPath` usa y crescendo para BAIXO a partir de `top`.
  const path = `M ${rr} 0 H ${w - rr} A ${rr} ${rr} 0 0 1 ${w} ${rr} V ${h - rr} A ${rr} ${rr} 0 0 1 ${w - rr} ${h} H ${rr} A ${rr} ${rr} 0 0 1 0 ${h - rr} V ${rr} A ${rr} ${rr} 0 0 1 ${rr} 0 Z`;
  page.drawSvgPath(path, { x, y: top, ...opts });
}

function drawCircularImage(page: PDFPage, img: PDFImage, cx: number, cy: number, r: number) {
  const k = 0.5523 * r;
  page.pushOperators(
    pushGraphicsState(),
    moveTo(cx + r, cy),
    appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
    appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
    appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
    appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    closePath(),
    clip(),
    endPath(),
  );
  page.drawImage(img, { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r });
  page.pushOperators(popGraphicsState());
}

function drawRight(
  page: PDFPage,
  font: PDFFont,
  text: string,
  xRight: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const clean = sanitize(text);
  page.drawText(clean, {
    x: xRight - font.widthOfTextAtSize(clean, size),
    y,
    size,
    font,
    color,
  });
}

function drawCentered(
  page: PDFPage,
  font: PDFFont,
  text: string,
  xCenter: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const clean = sanitize(text);
  page.drawText(clean, {
    x: xCenter - font.widthOfTextAtSize(clean, size) / 2,
    y,
    size,
    font,
    color,
  });
}

// ═════════════════════════════════════════════════════════════════
// Helpers de texto
// ═════════════════════════════════════════════════════════════════

/**
 * Normaliza pontuação tipográfica que o WinAnsi não desenha bem e remove
 * caracteres de controle.
 *
 * ⚠️ NÃO remove acentos: as StandardFonts do pdf-lib usam WinAnsiEncoding, que
 * cobre todo o latim-1 (ç, ã, õ, é, ê...). Escrever "BALCAO" sem til aqui seria
 * uma degradação gratuita.
 */
function sanitize(text: string): string {
  const base = String(text ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ");
  let out = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += code === 0x09 || code === 0x0a ? " " : "";
      continue;
    }
    // Fora do WinAnsi (emoji etc.) → "?" em vez de derrubar a geração.
    out += code <= 0xff || "€‚ƒ„…†‡ˆ‰Š‹ŒŽ''“”•–—˜™š›œžŸ".includes(ch) ? ch : "?";
  }
  return out;
}

function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  const clean = sanitize(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let out = clean;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

/** Quebra em linhas que caibam em `maxWidth`, fatiando palavras longas. */
function wrapLines(font: PDFFont, text: string, maxWidth: number, size: number): string[] {
  const clean = sanitize(text).trim();
  if (!clean) return [];
  const linhas: string[] = [];
  let atual = "";
  for (const palavra of clean.split(/\s+/)) {
    const cand = atual ? `${atual} ${palavra}` : palavra;
    if (font.widthOfTextAtSize(cand, size) <= maxWidth) {
      atual = cand;
      continue;
    }
    if (atual) linhas.push(atual);
    let resto = palavra;
    while (font.widthOfTextAtSize(resto, size) > maxWidth && resto.length > 1) {
      let i = 1;
      while (i < resto.length && font.widthOfTextAtSize(resto.slice(0, i + 1), size) <= maxWidth) {
        i++;
      }
      linhas.push(resto.slice(0, i));
      resto = resto.slice(i);
    }
    atual = resto;
  }
  if (atual) linhas.push(atual);
  return linhas;
}

function initialsOf(name: string): string {
  const parts = sanitize(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function companyName(company: CompanyFiscalConfig | null): string {
  return sanitize(company?.razaoSocial || company?.nomeFantasia || "Dexo");
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

/** Quantidade sem casas quando inteira; até 3 casas quando fracionária. */
function formatQty(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "").replace(".", ",");
}

/** Percentual no padrão brasileiro (vírgula decimal). */
function formatPercent(n: number): string {
  return `${n.toFixed(2).replace(".", ",")}%`;
}

type ParsedItem = { description: string; amount: number | null };

/** Descrição a partir de um ReceivableItem: "<SKU> <nome>" ou texto livre. */
function buildItemDescription(it: any): string {
  const sku = it?.product?.sku ? `${it.product.sku} ` : "";
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
  return [entry.reason || entry.document || "Venda balcão"];
}

/**
 * Tenta extrair um valor em reais do fim da linha (ex.: "Capô Strada | 1 un | R$ 600,00").
 * Se não encontrar E a conta tiver um único item, usa `totalAmount` como valor.
 */
function parseItemLine(line: string, entry: FinanceEntry, lineCount: number): ParsedItem {
  const m = line.match(
    /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:[.,]\d{1,2})?)\s*$/,
  );
  if (m) {
    const raw = m[1].replace(/\./g, "").replace(",", ".");
    const amount = parseFloat(raw);
    const description = line
      .slice(0, line.length - m[0].length)
      .replace(/[\s|\-:·—]+$/u, "")
      .trim();
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

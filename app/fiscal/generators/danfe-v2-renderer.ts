import {
  PDFDocument,
  PDFImage,
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
import type { NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeTotais } from "../domain/nfe.types";
import {
  resolveCstCsosn,
  toWinAnsiSafe,
  wrapTextLines,
  formatBRLNumber,
} from "./danfe-helpers";
import { composeInfCpl } from "../domain/inf-cpl";

/** Avatar do usuário já carregado em bytes (PNG ou JPG) para embutir no PDF. */
export interface DanfeAvatar {
  bytes: Uint8Array;
  format: "png" | "jpg";
}

export interface DanfeRenderInput {
  nfe: NfeDraftResponse;
  config: CompanyFiscalConfig;
  chaveAcesso: string | null;
  protocolo: string | null;
  avatar?: DanfeAvatar | null;
}

// Paleta derivada do design system do app (globals.css, oklch → sRGB):
// primary dourado, fundo creme, texto quase-preto, bordas cinza-claro.
const GOLD = rgb(0.949, 0.8, 0.122);
const GOLD_SOFT = rgb(0.985, 0.945, 0.78);
const INK = rgb(0.105, 0.105, 0.115);
const MUTED = rgb(0.46, 0.46, 0.48);
const WHITE = rgb(1, 1, 1);
const BORDER = rgb(0.88, 0.88, 0.87);
const RED = rgb(0.78, 0.12, 0.12);

function initialsOf(name: string | null | undefined): string {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "NF";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatCnpjLocal(cnpj: string | null | undefined): string {
  const d = String(cnpj ?? "").replace(/\D/g, "");
  if (d.length !== 14) return String(cnpj ?? "");
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function groupChave(chave: string | null | undefined): string {
  const d = String(chave ?? "").replace(/\D/g, "");
  return d.length === 44
    ? d.replace(/(.{4})/g, "$1 ").trim()
    : String(chave ?? "");
}

export async function renderDanfeV2(
  input: DanfeRenderInput,
): Promise<Uint8Array> {
  const { nfe, config, chaveAcesso, protocolo, avatar } = input;
  const doc = await PDFDocument.create();
  const pageSize: [number, number] = [595.28, 841.89];
  let page = doc.addPage(pageSize);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();
  const margin = 30;
  const W = width - 2 * margin;
  let y = height - margin;

  let avatarImg: PDFImage | null = null;
  if (avatar) {
    try {
      avatarImg =
        avatar.format === "png"
          ? await doc.embedPng(avatar.bytes)
          : await doc.embedJpg(avatar.bytes);
    } catch {
      avatarImg = null;
    }
  }

  // ── helpers (cientes da `page` corrente, que muda na paginação) ──
  const text = (
    t: unknown,
    x: number,
    yy: number,
    size = 8,
    f = font,
    color = INK,
  ) => page.drawText(String(t ?? ""), { x, y: yy, size, font: f, color });
  const widthOf = (t: unknown, size: number, f = font) =>
    f.widthOfTextAtSize(String(t ?? ""), size);
  const right = (
    t: unknown,
    xr: number,
    yy: number,
    size = 8,
    f = font,
    color = INK,
  ) => text(t, xr - widthOf(t, size, f), yy, size, f, color);
  const fit = (t: unknown, maxW: number, size: number, f = font) => {
    let s = String(t ?? "");
    if (widthOf(s, size, f) <= maxW) return s;
    while (s.length > 1 && widthOf(s + "…", size, f) > maxW) s = s.slice(0, -1);
    return s + "…";
  };
  const hline = (x1: number, x2: number, yy: number, color = BORDER) =>
    page.drawLine({
      start: { x: x1, y: yy },
      end: { x: x2, y: yy },
      thickness: 0.5,
      color,
    });
  const vline = (x: number, y1: number, y2: number, color = BORDER) =>
    page.drawLine({
      start: { x, y: y1 },
      end: { x, y: y2 },
      thickness: 0.5,
      color,
    });

  // Retângulo arredondado via SVG path (drawSvgPath usa y para baixo a partir do topo).
  const roundRect = (
    x: number,
    top: number,
    w: number,
    h: number,
    r: number,
    opts: Record<string, unknown>,
  ) => {
    const rr = Math.min(r, w / 2, h / 2);
    const path = `M ${rr} 0 H ${w - rr} A ${rr} ${rr} 0 0 1 ${w} ${rr} V ${h - rr} A ${rr} ${rr} 0 0 1 ${w - rr} ${h} H ${rr} A ${rr} ${rr} 0 0 1 0 ${h - rr} V ${rr} A ${rr} ${rr} 0 0 1 ${rr} 0 Z`;
    page.drawSvgPath(path, { x, y: top, ...opts });
  };

  const circularImage = (img: PDFImage, cx: number, cy: number, r: number) => {
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
  };

  // ── Cabeçalho (faixa dourada com avatar + identidade da nota) ──
  const bandH = 70;
  const bandTop = y;
  roundRect(margin, bandTop, W, bandH, 12, { color: GOLD });
  const cx = margin + 16 + 24;
  const cy = bandTop - bandH / 2;
  const r = 24;
  page.drawCircle({ x: cx, y: cy, size: r + 2, color: WHITE });
  if (avatarImg) {
    circularImage(avatarImg, cx, cy, r);
  } else {
    page.drawCircle({ x: cx, y: cy, size: r, color: WHITE });
    const ini = initialsOf(config.razaoSocial);
    text(ini, cx - widthOf(ini, 16, bold) / 2, cy - 6, 16, bold, INK);
  }
  page.drawCircle({
    x: cx,
    y: cy,
    size: r,
    borderColor: WHITE,
    borderWidth: 2,
  });

  const infoX = cx + r + 16;
  text(
    fit(config.razaoSocial ?? "Emitente", W - (infoX - margin) - 150, 13, bold),
    infoX,
    bandTop - 24,
    13,
    bold,
    INK,
  );
  const subEmit = config.nomeFantasia
    ? String(config.nomeFantasia)
    : "Nota Fiscal Eletrônica";
  text(fit(subEmit, 240, 8.5), infoX, bandTop - 38, 8.5, font, INK);
  text(
    `CNPJ ${formatCnpjLocal(config.cnpj)}   •   IE ${config.inscricaoEstadual ?? "-"}`,
    infoX,
    bandTop - 52,
    8,
    font,
    INK,
  );

  right("NOTA FISCAL ELETRÔNICA", margin + W - 14, bandTop - 22, 8, bold, INK);
  right(
    `Nº ${nfe.numero}   •   Série ${nfe.serie}`,
    margin + W - 14,
    bandTop - 38,
    13,
    bold,
    INK,
  );
  if (nfe.ambiente === "HOMOLOGACAO") {
    const chip = "HOMOLOGAÇÃO · SEM VALOR FISCAL";
    const cw = widthOf(chip, 6.5, bold) + 14;
    roundRect(margin + W - 14 - cw, bandTop - 48, cw, 14, 7, { color: INK });
    text(chip, margin + W - 14 - cw + 7, bandTop - 57.5, 6.5, bold, GOLD);
  } else {
    right("Modelo 55 · 4.00", margin + W - 14, bandTop - 53, 7.5, font, INK);
  }
  y = bandTop - bandH - 12;

  // ── Card genérico de bloco com rótulo ──
  const block = (
    label: string,
    contentH: number,
    render: (innerTop: number) => void,
  ) => {
    const headerH = 17;
    const totalH = headerH + contentH;
    const top = y;
    roundRect(margin, top, W, totalH, 8, {
      color: WHITE,
      borderColor: BORDER,
      borderWidth: 0.8,
    });
    roundRect(margin + 10, top - 6, 4, 11, 2, { color: GOLD });
    text(label, margin + 20, top - 12, 7, bold, MUTED);
    render(top - headerH);
    y = top - totalH - 9;
  };

  // ── Chave de acesso ──
  block("CHAVE DE ACESSO", 30, (top) => {
    text(
      groupChave(chaveAcesso) || "Pendente de autorização",
      margin + 16,
      top - 12,
      9.5,
      bold,
      INK,
    );
    text(
      protocolo ? `Protocolo de autorização: ${protocolo}` : "Protocolo: —",
      margin + 16,
      top - 25,
      7.5,
      font,
      MUTED,
    );
  });

  // ── Destinatário ──
  const dest = nfe.destinatarioJson;
  const endDest = dest
    ? [
        dest.logradouro,
        dest.numero,
        dest.bairro,
        dest.municipio,
        dest.uf,
        dest.cep,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  block("DESTINATÁRIO", 44, (top) => {
    text(
      fit(dest?.nome ?? "-", W - 32, 10.5, bold),
      margin + 16,
      top - 13,
      10.5,
      bold,
      INK,
    );
    text(
      `CPF/CNPJ: ${dest?.cpfCnpj ?? "-"}    •    IE: ${dest?.inscricaoEstadual ?? "-"}`,
      margin + 16,
      top - 27,
      8,
      font,
      MUTED,
    );
    text(fit(endDest || "-", W - 32, 8), margin + 16, top - 39, 8, font, MUTED);
  });

  // ── Cálculo do imposto (grid de valores) ──
  const totais = (nfe.totaisJson ?? {}) as NfeTotais;
  const money = (n: unknown) => `R$ ${formatBRLNumber(Number(n) || 0)}`;
  const taxCells = [
    { l: "BASE ICMS", v: money(totais.totalBcIcms) },
    { l: "VALOR ICMS", v: money(totais.totalIcms) },
    { l: "VALOR IPI", v: money(totais.totalIpi) },
    { l: "VALOR PIS", v: money(totais.totalPis) },
    { l: "VALOR COFINS", v: money(totais.totalCofins) },
    { l: "PRODUTOS", v: money(totais.totalProdutos) },
    // FRETE compoe o TOTAL DA NOTA (regra W16). Sem esta celula o total
    // impresso nao fecha com as parcelas ao lado. Nota sem frete: R$ 0,00,
    // como as demais celulas zeradas ja fazem.
    { l: "FRETE", v: money(totais.totalFrete) },
    { l: "DESCONTO", v: money(totais.totalDesconto) },
    { l: "TRIBUTOS", v: money(totais.totalTributos) },
  ];
  block("CÁLCULO DO IMPOSTO", 46, (top) => {
    const cols = 4;
    const colW = (W - 24) / cols;
    taxCells.forEach((cell, i) => {
      const rrow = Math.floor(i / cols);
      const ccol = i % cols;
      const x = margin + 12 + ccol * colW;
      const cyTop = top - rrow * 24;
      text(cell.l, x, cyTop - 9, 5.5, font, MUTED);
      text(cell.v, x, cyTop - 19, 9, bold, INK);
      if (ccol > 0) vline(x - 6, cyTop - 3, cyTop - 21);
    });
    hline(margin + 12, margin + W - 12, top - 23);
  });

  // ── Produtos / Serviços (tabela paginada) ──
  const cstLabel = resolveCstCsosn(config.regimeTributario).label;
  const wCod = 48,
    wNcm = 52,
    wCst = 44,
    wCfop = 32,
    wUn = 22,
    wQtd = 42,
    wUnit = 52,
    wTot = 56;
  const xCod = margin + 8;
  const wDesc =
    W - 16 - (wCod + wNcm + wCst + wCfop + wUn + wQtd + wUnit + wTot);
  const xDesc = xCod + wCod;
  const xNcm = xDesc + wDesc;
  const xCst = xNcm + wNcm;
  const xCfop = xCst + wCst;
  const xUn = xCfop + wCfop;
  const xQtd = xUn + wUn;
  const xUnit = xQtd + wQtd;
  const xTot = xUnit + wUnit;
  const xEnd = xTot + wTot;
  const rowH = 13;

  const tableHeader = (cont = false) => {
    const top = y;
    roundRect(margin, top, W, 18, 6, { color: GOLD_SOFT });
    roundRect(margin + 10, top - 6, 4, 11, 2, { color: GOLD });
    text(
      cont ? "PRODUTOS / SERVIÇOS (continuação)" : "PRODUTOS / SERVIÇOS",
      margin + 20,
      top - 12,
      7,
      bold,
      rgb(0.4, 0.33, 0.05),
    );
    y -= 18;
    const hy = y;
    text("CÓD", xCod + 2, hy - 9, 5.5, bold, MUTED);
    text("DESCRIÇÃO", xDesc + 2, hy - 9, 5.5, bold, MUTED);
    text("NCM", xNcm + 2, hy - 9, 5.5, bold, MUTED);
    text(cstLabel, xCst + 2, hy - 9, 5.5, bold, MUTED);
    text("CFOP", xCfop + 2, hy - 9, 5.5, bold, MUTED);
    text("UN", xUn + 2, hy - 9, 5.5, bold, MUTED);
    right("QTD", xUnit - 4, hy - 9, 5.5, bold, MUTED);
    right("VL UNIT", xTot - 4, hy - 9, 5.5, bold, MUTED);
    right("VL TOTAL", margin + W - 6, hy - 9, 5.5, bold, MUTED);
    hline(margin + 4, margin + W - 4, hy - rowH);
    y -= rowH;
  };

  tableHeader(false);
  let zebra = false;
  for (const item of nfe.itens) {
    if (y < margin + 60) {
      page = doc.addPage(pageSize);
      y = height - margin;
      tableHeader(true);
    }
    const ry = y;
    if (zebra) {
      page.drawRectangle({
        x: margin + 4,
        y: ry - rowH,
        width: W - 8,
        height: rowH,
        color: rgb(0.975, 0.973, 0.965),
      });
    }
    zebra = !zebra;
    const cst = resolveCstCsosn(
      config.regimeTributario,
      (item as { cstIcms?: string | null }).cstIcms,
    ).value;
    text(fit(item.codigo, wCod - 4, 6.5), xCod + 2, ry - 9, 6.5);
    text(fit(item.descricao, wDesc - 6, 6.5), xDesc + 2, ry - 9, 6.5);
    text(fit(item.ncm, wNcm - 4, 6.5), xNcm + 2, ry - 9, 6.5);
    text(cst, xCst + 2, ry - 9, 6.5);
    text(item.cfop, xCfop + 2, ry - 9, 6.5);
    text(fit(item.unidade, wUn - 4, 6.5), xUn + 2, ry - 9, 6.5);
    right(formatBRLNumber(Number(item.quantidade)), xUnit - 4, ry - 9, 6.5);
    right(formatBRLNumber(Number(item.valorUnitario)), xTot - 4, ry - 9, 6.5);
    right(
      formatBRLNumber(Number(item.valorTotal)),
      margin + W - 6,
      ry - 9,
      6.5,
      bold,
    );
    hline(margin + 4, margin + W - 4, ry - rowH);
    y -= rowH;
  }

  // ── Total da nota (chip dourado) ──
  y -= 10;
  if (y < margin + 30) {
    page = doc.addPage(pageSize);
    y = height - margin;
  }
  const totalH = 26;
  roundRect(margin, y, W, totalH, 8, { color: GOLD });
  text("TOTAL DA NOTA", margin + 16, y - 16, 9, bold, INK);
  right(money(totais.totalNota), margin + W - 16, y - 17, 14, bold, INK);
  y -= totalH + 14;

  // ── Informações complementares (mesmo conteúdo do <infCpl> do XML) ──
  const infCpl = toWinAnsiSafe(composeInfCpl(nfe));
  if (infCpl) {
    const infSize = 7.5;
    const infLineH = 10;
    const infLines = wrapTextLines(infCpl, W - 32, (s) => widthOf(s, infSize));
    // O card é desenhado inteiro de uma vez (block não pagina): limita as
    // linhas ao que cabe numa página cheia e quebra de página antes, se preciso.
    const maxLines = Math.floor((height - 2 * margin - 40) / infLineH);
    if (infLines.length > maxLines) {
      infLines.length = maxLines;
      infLines[maxLines - 1] += " …";
    }
    const contentH = infLines.length * infLineH + 6;
    if (y < margin + 17 + contentH + 16) {
      page = doc.addPage(pageSize);
      y = height - margin;
    }
    block("INFORMAÇÕES COMPLEMENTARES", contentH, (top) => {
      let ly = top - 10;
      for (const line of infLines) {
        text(line, margin + 16, ly, infSize, font, INK);
        ly -= infLineH;
      }
    });
  }

  // ── Rodapé ──
  if (y < margin + 16) {
    page = doc.addPage(pageSize);
    y = height - margin;
  }
  text(
    `${nfe.itens.length} ${nfe.itens.length === 1 ? "item" : "itens"} · Documento auxiliar gerado pelo Dexo`,
    margin,
    margin - 6,
    6.5,
    font,
    MUTED,
  );
  if (nfe.ambiente === "HOMOLOGACAO") {
    right(
      "Sem valor fiscal — ambiente de homologação",
      margin + W,
      margin - 6,
      6.5,
      font,
      RED,
    );
  }

  return doc.save();
}

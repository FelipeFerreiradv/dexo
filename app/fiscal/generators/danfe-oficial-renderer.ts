/**
 * DANFE oficial — Documento Auxiliar da Nota Fiscal Eletrônica (modelo 55).
 *
 * Reproduz a grade normatizada do ATO COTEPE/ICMS 51/15: canhoto de
 * recebimento, quadro de identificação com código de barras Code-128C da
 * chave, destinatário, fatura/duplicata, cálculo do imposto, transportador /
 * volumes, dados dos produtos em 14 colunas, dados adicionais e reservado ao
 * fisco. É o layout que faz o documento ser reconhecido como nota fiscal de
 * verdade por quem recebe.
 *
 * ARQUITETURA EM DUAS PASSADAS
 *   1. sanear → medir (quebra de descrições e do infCpl) → `planDanfePages()`
 *   2. desenhar seguindo o plano
 * É o que permite escrever "FOLHA 1/3" já na primeira folha e garante que
 * nenhum item ou linha de informação complementar seja descartado.
 *
 * SANEAMENTO NA FRONTEIRA (não negociável): `PDFFont.widthOfTextAtSize()`
 * LANÇA em caractere não-encodável, exatamente como `drawText`. Medir texto
 * cru derrubaria a geração inteira antes de desenhar qualquer coisa. Por isso
 * TODO texto externo passa por `toWinAnsiSafe*` no início, e só o resultado
 * saneado circula daqui para baixo.
 *
 * Este módulo apenas DESENHA. Não calcula tributo, não monta XML, não
 * persiste nada — os valores fiscais vêm prontos do draft, do XML autorizado
 * ou das projeções de leitura em `danfe-render-extras.ts`.
 */

import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
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
import { composeInfCpl } from "../domain/inf-cpl";
import {
  resolveCstCsosn,
  toWinAnsiSafe,
  toWinAnsiSafeLine,
  wrapTextLines,
  formatBRLNumber,
} from "./danfe-helpers";
import { drawCode128C } from "./code128";
import {
  normalizeTransportadora,
  normalizeVolumes,
  normalizeDuplicatas,
  type ItemImpostoView,
} from "./danfe-render-extras";
import {
  PAGE_W,
  PAGE_H,
  X0,
  X1,
  W,
  Y_TOP,
  GAP,
  STRIP_H,
  FIELD_ROW_H,
  H_CANHOTO,
  H_CANHOTO_BOX,
  H_IDENT,
  H_IDENT_BAND,
  H_DEST,
  H_IMPOSTO,
  H_TRANSP,
  H_PROD_HEADER,
  PROD_HEADER_H,
  FOOTER_BASELINE,
  ITEM_LINE_H,
  ITEM_PAD_V,
  INFO_LINE_H,
  INFO_PAD_V,
  DUP_PER_ROW,
  DUP_ROW_H,
  PROD_COLUMNS,
  prodColumnOffsets,
  faturaHeight,
  infoHeight,
  itemRowHeight,
  planDanfePages,
} from "./danfe-oficial-layout";

// ═══════════════════════════════════════════════════════════════════
// Paleta e tipografia
// ═══════════════════════════════════════════════════════════════════

const INK = rgb(0.08, 0.08, 0.09);
const LABEL = rgb(0.34, 0.34, 0.36);
const GRID = rgb(0.55, 0.55, 0.57);
const FRAME = rgb(0.22, 0.22, 0.24);
const STRIP_BG = rgb(0.93, 0.93, 0.92);
const ZEBRA = rgb(0.969, 0.969, 0.963);
const WHITE = rgb(1, 1, 1);
const RED = rgb(0.78, 0.12, 0.12);

const SIZE_LABEL = 4.8;
const SIZE_VALUE = 7;
const SIZE_VALUE_LG = 8.5;
const SIZE_STRIP = 6.2;
const SIZE_ITEM = 5.8;
const SIZE_COLHEAD = 4.8;

const PAD = 3;
/** Baseline do rótulo, medida a partir do topo da célula. */
const LABEL_BASE = 6.4;
/** Baseline do valor numa célula de `FIELD_ROW_H`. */
const VALUE_BASE = 17;

/** Máximo de linhas da descrição de um item (o DANFE não é um catálogo). */
const MAX_DESC_LINES = 3;

export interface DanfeOficialAvatar {
  bytes: Uint8Array;
  format: "png" | "jpg";
}

export interface DanfeOficialExtras {
  /** Impostos por item lidos do XML autorizado, na ordem dos itens. */
  itensImpostos?: Array<ItemImpostoView | null> | null;
  /** Telefone do emitente (só existe no caminho XML: `<enderEmit><fone>`). */
  emitenteFone?: string | null;
  /**
   * Data/hora da autorização. Vive aqui para que `DanfePdfService.generate()`
   * possa repassá-la sem ganhar mais um parâmetro posicional.
   */
  dataAutorizacao?: string | Date | null;
}

export interface DanfeOficialInput {
  nfe: NfeDraftResponse;
  config: CompanyFiscalConfig;
  chaveAcesso: string | null;
  protocolo: string | null;
  dataAutorizacao?: string | Date | null;
  avatar?: DanfeOficialAvatar | null;
  extras?: DanfeOficialExtras | null;
}

// ═══════════════════════════════════════════════════════════════════
// Formatação
// ═══════════════════════════════════════════════════════════════════

function onlyDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function formatCpfCnpj(v: unknown): string {
  const d = onlyDigits(v);
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return String(v ?? "");
}

function formatCep(v: unknown): string {
  const d = onlyDigits(v);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : String(v ?? "");
}

/** Nº da nota no formato do DANFE: 000.000.094. */
function formatNumeroNfe(n: unknown): string {
  const d = onlyDigits(n).padStart(9, "0");
  return `${d.slice(-9, -6)}.${d.slice(-6, -3)}.${d.slice(-3)}`;
}

/** Chave de 44 dígitos em blocos de 4, como manda a norma. */
function groupChave(chave: unknown): string {
  const d = onlyDigits(chave);
  return d.length === 44 ? d.replace(/(.{4})/g, "$1 ").trim() : String(chave ?? "");
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(v: unknown): string {
  const d = toDate(v);
  if (!d) return "";
  return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatTime(v: unknown): string {
  const d = toDate(v);
  if (!d) return "";
  return d.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function money(n: unknown): string {
  return formatBRLNumber(Number(n) || 0);
}

/** Quantidade com até 4 casas (a SEFAZ permite 4 em `qCom`). */
function formatQty(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0,0000";
  const [i, d] = Math.abs(v).toFixed(4).split(".");
  const milhar = i.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${v < 0 ? "-" : ""}${milhar},${d}`;
}

function initialsOf(name: unknown): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "NF";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MODALIDADE_FRETE_LABEL: Record<string, string> = {
  CIF: "0 - Por conta do emitente",
  FOB: "1 - Por conta do destinatário",
  TERCEIROS: "2 - Por conta de terceiros",
  PROPRIO_REMETENTE: "3 - Próprio por conta do remetente",
  PROPRIO_DESTINATARIO: "4 - Próprio por conta do destinatário",
  SEM_FRETE: "9 - Sem frete",
};

// ═══════════════════════════════════════════════════════════════════
// Renderer
// ═══════════════════════════════════════════════════════════════════

export async function renderDanfeOficial(
  input: DanfeOficialInput,
): Promise<Uint8Array> {
  const { nfe, config, chaveAcesso, protocolo, avatar, extras } = input;
  const dataAutorizacao = input.dataAutorizacao ?? extras?.dataAutorizacao ?? null;

  // ── PASSADA 0: sanear TUDO que vem de fora, uma única vez ──
  // Daqui para baixo nenhuma string crua é medida nem desenhada.
  const S = toWinAnsiSafeLine;
  const dest = nfe.destinatarioJson;
  const transp = normalizeTransportadora(nfe.transportadoraJson);
  const volumes = normalizeVolumes(nfe.volumesJson);
  const duplicatas = normalizeDuplicatas(nfe.duplicatasJson);
  const totais = (nfe.totaisJson ?? {}) as NfeTotais;
  const impostos = extras?.itensImpostos ?? null;

  const view = {
    emit: {
      razaoSocial: S(config.razaoSocial ?? "Emitente"),
      endereco: S(
        [config.logradouro, config.numero, config.complemento].filter(Boolean).join(", "),
      ),
      bairro: S(config.bairro ?? ""),
      cidadeUf: S([config.municipio, config.uf].filter(Boolean).join(" - ")),
      cep: S(formatCep(config.cep)),
      fone: S(extras?.emitenteFone ?? ""),
      cnpj: S(formatCpfCnpj(config.cnpj)),
      ie: S(config.inscricaoEstadual ?? ""),
    },
    dest: {
      nome: S(dest?.nome ?? ""),
      cpfCnpj: S(formatCpfCnpj(dest?.cpfCnpj)),
      endereco: S([dest?.logradouro, dest?.numero, dest?.complemento].filter(Boolean).join(", ")),
      bairro: S(dest?.bairro ?? ""),
      cep: S(formatCep(dest?.cep)),
      municipio: S(dest?.municipio ?? ""),
      uf: S(dest?.uf ?? ""),
      fone: S(dest?.telefone ?? ""),
      ie: S(dest?.inscricaoEstadual ?? ""),
    },
    natureza: S(nfe.naturezaOperacao ?? ""),
    transp: transp
      ? {
          nome: S(transp.nome ?? ""),
          cpfCnpj: S(formatCpfCnpj(transp.cpfCnpj)),
          ie: S(transp.inscricaoEstadual ?? ""),
          endereco: S(transp.endereco ?? ""),
          municipio: S(transp.municipio ?? ""),
          uf: S(transp.uf ?? ""),
        }
      : null,
    itens: (nfe.itens ?? []).map((it, i) => ({
      codigo: S(it.codigo ?? ""),
      descricao: S(it.descricao ?? ""),
      ncm: S(it.ncm ?? ""),
      cfop: S(it.cfop ?? ""),
      unidade: S(it.unidade ?? ""),
      quantidade: it.quantidade,
      valorUnitario: it.valorUnitario,
      valorTotal: it.valorTotal,
      imposto: impostos?.[i] ?? null,
      cstIcmsDb: (it as { cstIcms?: string | null }).cstIcms ?? null,
      origemDb: (it as { origem?: number | null }).origem ?? null,
      tributos: (it as { tributosJson?: Record<string, unknown> | null }).tributosJson ?? null,
    })),
  };

  // `toWinAnsiSafe` (não `...Line`) preserva os `\n` do usuário — é o que faz o
  // bloco de informações complementares respeitar os parágrafos digitados.
  const infCpl = toWinAnsiSafe(composeInfCpl(nfe));

  // ── Documento e fontes ──
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

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

  const widthOf = (t: string, size: number, f: PDFFont = font) =>
    f.widthOfTextAtSize(t, size);

  // ── PASSADA 1: medir ──
  const colOffsets = prodColumnOffsets();
  const descCol = PROD_COLUMNS.find((c) => c.key === "descricao")!;
  const descMaxW = descCol.width - PAD * 2;

  const descLines: string[][] = view.itens.map((it) => {
    const linhas = wrapTextLines(it.descricao, descMaxW, (s) => widthOf(s, SIZE_ITEM));
    if (linhas.length <= MAX_DESC_LINES) return linhas;
    const cortadas = linhas.slice(0, MAX_DESC_LINES);
    cortadas[MAX_DESC_LINES - 1] = fitText(
      `${cortadas[MAX_DESC_LINES - 1]}…`,
      descMaxW,
      SIZE_ITEM,
      font,
    );
    return cortadas;
  });

  const infoW = W * 0.66 - PAD * 2;
  const infoLines = infCpl
    ? wrapTextLines(infCpl, infoW, (s) => widthOf(s, 5.6))
    : [];

  const plan = planDanfePages({
    itemLineCounts: descLines.map((l) => l.length),
    infoLineCount: infoLines.length,
    duplicataCount: duplicatas.length,
  });

  // ── Estado de desenho ──
  let page!: PDFPage;
  let y = 0;

  function fitText(t: string, maxW: number, size: number, f: PDFFont): string {
    let s = t;
    if (widthOf(s, size, f) <= maxW) return s;
    while (s.length > 1 && widthOf(`${s}…`, size, f) > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }

  const text = (
    t: string,
    x: number,
    baseline: number,
    size = SIZE_VALUE,
    f: PDFFont = font,
    color = INK,
  ) => {
    if (!t) return;
    page.drawText(t, { x, y: baseline, size, font: f, color });
  };
  const right = (
    t: string,
    xr: number,
    baseline: number,
    size = SIZE_VALUE,
    f: PDFFont = font,
    color = INK,
  ) => text(t, xr - widthOf(t, size, f), baseline, size, f, color);
  const center = (
    t: string,
    xc: number,
    baseline: number,
    size = SIZE_VALUE,
    f: PDFFont = font,
    color = INK,
  ) => text(t, xc - widthOf(t, size, f) / 2, baseline, size, f, color);

  const hline = (x1: number, x2: number, yy: number, color = GRID, thickness = 0.5) =>
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });
  const vline = (x: number, y1: number, y2: number, color = GRID, thickness = 0.5) =>
    page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness, color });

  /** Moldura de um grupo de blocos. `top` é a borda superior. */
  const frame = (x: number, top: number, w: number, h: number) =>
    page.drawRectangle({
      x,
      y: top - h,
      width: w,
      height: h,
      borderColor: FRAME,
      borderWidth: 0.8,
    });

  /** Faixa de título de seção. Devolve o topo do corpo. */
  const strip = (top: number, label: string): number => {
    page.drawRectangle({ x: X0, y: top - STRIP_H, width: W, height: STRIP_H, color: STRIP_BG });
    hline(X0, X1, top - STRIP_H, GRID);
    text(label, X0 + PAD + 2, top - 7.8, SIZE_STRIP, bold, INK);
    return top - STRIP_H;
  };

  interface Cell {
    w: number;
    label: string;
    value?: string;
    align?: "left" | "right" | "center";
    size?: number;
    boldValue?: boolean;
  }

  /**
   * Linha de células rotuladas. Desenha rótulo + valor de cada célula, as
   * divisórias verticais internas e a divisória horizontal inferior.
   */
  const fieldRow = (top: number, h: number, cells: Cell[]): number => {
    let x = X0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const util = c.w - PAD * 2;
      text(c.label, x + PAD, top - LABEL_BASE, SIZE_LABEL, bold, LABEL);
      const size = c.size ?? SIZE_VALUE;
      const f = c.boldValue ? bold : font;
      const v = c.value ? fitText(c.value, util, size, f) : "";
      if (v) {
        const baseline = top - VALUE_BASE;
        if (c.align === "right") right(v, x + c.w - PAD, baseline, size, f);
        else if (c.align === "center") center(v, x + c.w / 2, baseline, size, f);
        else text(v, x + PAD, baseline, size, f);
      }
      x += c.w;
      if (i < cells.length - 1) vline(x, top, top - h);
    }
    hline(X0, X1, top - h);
    return top - h;
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

  // ═══════════════════════════════════════════════════════════════
  // Blocos
  // ═══════════════════════════════════════════════════════════════

  const numeroFmt = formatNumeroNfe(nfe.numero);
  const serieFmt = String(nfe.serie ?? "");
  const isHomolog = nfe.ambiente === "HOMOLOGACAO";
  const chaveDigits = onlyDigits(chaveAcesso);

  /** Canhoto de recebimento + linha tracejada de corte (só na folha 1). */
  const drawCanhoto = (top: number): number => {
    const h = H_CANHOTO_BOX;
    frame(X0, top, W, h);
    const wDir = 110;
    const xDir = X1 - wDir;
    vline(xDir, top, top - h, FRAME, 0.8);

    // Coluna direita: identificação da nota
    center("NF-e", xDir + wDir / 2, top - 12, 8, bold);
    center(`Nº ${numeroFmt}`, xDir + wDir / 2, top - 23, 7.5, bold);
    center(`SÉRIE: ${serieFmt}`, xDir + wDir / 2, top - 32, 6.5, font);

    // Coluna esquerda: recibo
    const wEsq = W - wDir;
    text(
      fitText(
        `RECEBEMOS DE ${view.emit.razaoSocial} OS PRODUTOS CONSTANTES NA NOTA FISCAL INDICADA AO LADO`,
        wEsq - PAD * 2,
        5.6,
        font,
      ),
      X0 + PAD,
      top - 9.5,
      5.6,
      font,
      INK,
    );
    hline(X0, xDir, top - 14);
    const wData = 90;
    vline(X0 + wData, top - 14, top - h);
    text("DATA DE RECEBIMENTO", X0 + PAD, top - 20.4, SIZE_LABEL, bold, LABEL);
    text(
      "IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR",
      X0 + wData + PAD,
      top - 20.4,
      SIZE_LABEL,
      bold,
      LABEL,
    );

    // Linha tracejada de corte
    const yCorte = top - h - 6;
    page.drawLine({
      start: { x: X0, y: yCorte },
      end: { x: X1, y: yCorte },
      thickness: 0.5,
      color: GRID,
      dashArray: [3, 2],
    });
    return top - H_CANHOTO;
  };

  /** Quadro de identificação — repetido em TODA folha. */
  const drawIdentificacao = (top: number, pageNo: number, totalPages: number): number => {
    frame(X0, top, W, H_IDENT);

    const wA = 230;
    const wB = 96;
    const wC = W - wA - wB; // 235
    const xB = X0 + wA;
    const xC = xB + wB;
    const bandBottom = top - H_IDENT_BAND;

    vline(xB, top, bandBottom);
    vline(xC, top, bandBottom);
    hline(X0, X1, bandBottom);

    // ── Coluna A: emitente ──
    const r = 18;
    const cx = X0 + 8 + r;
    const cy = top - 8 - r;
    if (avatarImg) {
      page.drawCircle({ x: cx, y: cy, size: r + 1, color: WHITE });
      circularImage(avatarImg, cx, cy, r);
      page.drawCircle({ x: cx, y: cy, size: r, borderColor: GRID, borderWidth: 0.6 });
    } else {
      page.drawCircle({ x: cx, y: cy, size: r, borderColor: GRID, borderWidth: 0.6 });
      const ini = initialsOf(view.emit.razaoSocial);
      center(ini, cx, cy - 4.5, 13, bold, LABEL);
    }

    const xNome = X0 + 8 + r * 2 + 8;
    const wNome = wA - (xNome - X0) - 8;
    const nomeLinhas = wrapTextLines(view.emit.razaoSocial, wNome, (s) => widthOf(s, 8, bold)).slice(0, 2);
    let ly = top - 16;
    for (const l of nomeLinhas) {
      text(fitText(l, wNome, 8, bold), xNome, ly, 8, bold);
      ly -= 9;
    }

    // O endereço começa ABAIXO do círculo do avatar (que vai de `top-8` a
    // `top-8-2r`), senão a primeira linha corta o logo ao meio.
    const enderLinhas = [
      view.emit.endereco,
      view.emit.bairro,
      [view.emit.cep ? `CEP ${view.emit.cep}` : "", view.emit.cidadeUf].filter(Boolean).join(" - "),
      view.emit.fone ? `FONE: ${view.emit.fone}` : "",
    ].filter(Boolean);
    let ey = top - 8 - r * 2 - 10;
    for (const l of enderLinhas) {
      text(fitText(l, wA - 16, 6.2, font), X0 + 8, ey, 6.2, font, INK);
      ey -= 8;
    }

    // ── Coluna B: DANFE ──
    const cxB = xB + wB / 2;
    center("DANFE", cxB, top - 14, 12, bold);
    const subLinhas = wrapTextLines(
      "DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA",
      wB - 8,
      (s) => widthOf(s, 4.6),
    );
    let sy = top - 21;
    for (const l of subLinhas.slice(0, 3)) {
      center(l, cxB, sy, 4.6, font, LABEL);
      sy -= 5.6;
    }
    text("0 - ENTRADA", xB + 6, top - 47, 5, font, INK);
    text("1 - SAÍDA", xB + 6, top - 55, 5, font, INK);
    const boxW = 14;
    const boxX = xB + wB - 6 - boxW;
    page.drawRectangle({
      x: boxX,
      y: top - 58,
      width: boxW,
      height: 14,
      borderColor: FRAME,
      borderWidth: 0.7,
    });
    center(nfe.tipoOperacao === "ENTRADA" ? "0" : "1", boxX + boxW / 2, top - 54.5, 9, bold);
    hline(xB, xC, top - 62);
    center(`Nº ${numeroFmt}`, cxB, top - 73, 8.5, bold);
    center(`SÉRIE: ${serieFmt}`, cxB, top - 83, 7, bold);
    center(`FOLHA ${pageNo} / ${totalPages}`, cxB, top - 93, 6.5, font, LABEL);

    // ── Coluna C: controle do fisco + chave + consulta ──
    text("CONTROLE DO FISCO", xC + PAD, top - LABEL_BASE, SIZE_LABEL, bold, LABEL);
    const desenhou = drawCode128C(page, INK, chaveDigits, {
      x: xC + 4,
      y: top - 48,
      width: wC - 8,
      height: 34,
      quietModules: 10,
    });
    if (!desenhou) {
      center("CHAVE DE ACESSO PENDENTE", xC + wC / 2, top - 32, 6, font, LABEL);
    }
    hline(xC, X1, top - 52);

    text("CHAVE DE ACESSO", xC + PAD, top - 58.4, SIZE_LABEL, bold, LABEL);
    const chaveTxt = groupChave(chaveAcesso) || "Pendente de autorização";
    let chaveSize = 7.2;
    while (chaveSize > 5.2 && widthOf(chaveTxt, chaveSize, bold) > wC - PAD * 2) {
      chaveSize -= 0.1;
    }
    center(chaveTxt, xC + wC / 2, top - 70, chaveSize, bold);
    hline(xC, X1, top - 78);

    center(
      "Consulta de autenticidade no portal nacional da NF-e",
      xC + wC / 2,
      top - 86,
      4.8,
      font,
      LABEL,
    );
    center(
      "www.nfe.fazenda.gov.br/portal ou no site da Sefaz autorizadora",
      xC + wC / 2,
      top - 93,
      4.8,
      font,
      LABEL,
    );

    // ── Natureza da operação | Protocolo ──
    let cur = bandBottom;
    const protoTxt = protocolo
      ? [protocolo, [formatDate(dataAutorizacao), formatTime(dataAutorizacao)].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(" - ")
      : "";
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 330, label: "NATUREZA DA OPERAÇÃO", value: view.natureza, size: SIZE_VALUE_LG },
      { w: W - 330, label: "PROTOCOLO DE AUTORIZAÇÃO DE USO", value: S(protoTxt) },
    ]);

    // ── IE | IE subst. | CNPJ ──
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 187, label: "INSCRIÇÃO ESTADUAL", value: view.emit.ie },
      { w: 187, label: "INSCRIÇÃO ESTADUAL DO SUBST. TRIBUTÁRIO", value: "" },
      { w: 187, label: "CNPJ / CPF", value: view.emit.cnpj },
    ]);

    if (isHomolog) {
      const aviso = "AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL";
      center(aviso, X0 + W / 2, top - H_IDENT + 5, 6, bold, RED);
    }
    return top - H_IDENT;
  };

  const drawDestinatario = (top: number): number => {
    frame(X0, top, W, H_DEST);
    let cur = strip(top, "DESTINATÁRIO / REMETENTE");
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 313, label: "NOME / RAZÃO SOCIAL", value: view.dest.nome, size: SIZE_VALUE_LG },
      { w: 144, label: "CNPJ / CPF", value: view.dest.cpfCnpj },
      { w: 104, label: "DATA DE EMISSÃO", value: formatDate(nfe.dataEmissao), align: "center" },
    ]);
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 233, label: "ENDEREÇO", value: view.dest.endereco },
      { w: 144, label: "BAIRRO / DISTRITO", value: view.dest.bairro },
      { w: 80, label: "CEP", value: view.dest.cep, align: "center" },
      { w: 104, label: "DATA ENTRADA / SAÍDA", value: formatDate(nfe.dataSaida), align: "center" },
    ]);
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 203, label: "MUNICÍPIO", value: view.dest.municipio },
      { w: 90, label: "FONE / FAX", value: view.dest.fone },
      { w: 30, label: "UF", value: view.dest.uf, align: "center" },
      { w: 134, label: "INSCRIÇÃO ESTADUAL", value: view.dest.ie },
      { w: 104, label: "HORA ENTRADA / SAÍDA", value: formatTime(nfe.dataSaida), align: "center" },
    ]);
    return cur;
  };

  const drawFatura = (top: number): number => {
    const h = faturaHeight(duplicatas.length);
    frame(X0, top, W, h);
    const cur = strip(top, "FATURA / DUPLICATA");
    if (duplicatas.length === 0) return top - h;

    const cellW = W / DUP_PER_ROW;
    duplicatas.forEach((d, i) => {
      const row = Math.floor(i / DUP_PER_ROW);
      const col = i % DUP_PER_ROW;
      const x = X0 + col * cellW;
      const rTop = cur - row * DUP_ROW_H;
      text(
        fitText(
          `Nº ${d.numero ?? "-"}  ·  Venc. ${formatDate(d.vencimento) || (d.vencimento ?? "-")}`,
          cellW - PAD * 2,
          5.4,
          font,
        ),
        x + PAD,
        rTop - 7,
        5.4,
        font,
        LABEL,
      );
      right(
        money(d.valor),
        x + cellW - PAD,
        rTop - 14.5,
        6.4,
        bold,
      );
      if (col > 0) vline(x, rTop, rTop - DUP_ROW_H);
    });
    return top - h;
  };

  const drawImposto = (top: number): number => {
    frame(X0, top, W, H_IMPOSTO);
    let cur = strip(top, "CÁLCULO DO IMPOSTO");
    // ICMS-ST, frete, seguro e outras despesas não são calculados pela
    // plataforma nem lidos do <ICMSTot> pelo parser — saem 0,00, que é o valor
    // verdadeiro dessas notas (e é o que o modelo de referência mostra).
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 112, label: "BASE DE CÁLCULO DO ICMS", value: money(totais.totalBcIcms), align: "right" },
      { w: 112, label: "VALOR DO ICMS", value: money(totais.totalIcms), align: "right" },
      { w: 112, label: "BASE DE CÁLC. ICMS SUBST.", value: money(0), align: "right" },
      { w: 112, label: "VALOR DO ICMS SUBST.", value: money(0), align: "right" },
      { w: 113, label: "VALOR TOTAL DOS PRODUTOS", value: money(totais.totalProdutos), align: "right" },
    ]);
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 93, label: "VALOR DO FRETE", value: money(0), align: "right" },
      { w: 93, label: "VALOR DO SEGURO", value: money(0), align: "right" },
      { w: 93, label: "DESCONTO", value: money(totais.totalDesconto), align: "right" },
      { w: 93, label: "OUTRAS DESPESAS", value: money(0), align: "right" },
      { w: 93, label: "VALOR TOTAL DO IPI", value: money(totais.totalIpi), align: "right" },
      {
        w: 96,
        label: "VALOR TOTAL DA NOTA",
        value: money(totais.totalNota),
        align: "right",
        size: SIZE_VALUE_LG,
        boldValue: true,
      },
    ]);
    return cur;
  };

  const drawTransportador = (top: number): number => {
    frame(X0, top, W, H_TRANSP);
    let cur = strip(top, "TRANSPORTADOR / VOLUMES TRANSPORTADOS");
    const frete = MODALIDADE_FRETE_LABEL[String(nfe.modalidadeFrete ?? "")] ?? "";
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 198, label: "NOME / RAZÃO SOCIAL", value: view.transp?.nome ?? "" },
      { w: 78, label: "FRETE POR CONTA", value: S(frete), size: 5.6 },
      { w: 72, label: "CÓDIGO ANTT", value: "" },
      { w: 66, label: "PLACA DO VEÍCULO", value: "" },
      { w: 26, label: "UF", value: "", align: "center" },
      { w: 121, label: "CNPJ / CPF", value: view.transp?.cpfCnpj ?? "" },
    ]);
    cur = fieldRow(cur, FIELD_ROW_H, [
      { w: 263, label: "ENDEREÇO", value: view.transp?.endereco ?? "" },
      { w: 171, label: "MUNICÍPIO", value: view.transp?.municipio ?? "" },
      { w: 26, label: "UF", value: view.transp?.uf ?? "", align: "center" },
      { w: 101, label: "INSCRIÇÃO ESTADUAL", value: view.transp?.ie ?? "" },
    ]);
    cur = fieldRow(cur, FIELD_ROW_H, [
      {
        w: 72,
        label: "QUANTIDADE",
        value: volumes?.quantidade != null ? String(volumes.quantidade) : "",
        align: "right",
      },
      { w: 100, label: "ESPÉCIE", value: S(volumes?.especie ?? "") },
      { w: 100, label: "MARCA", value: S(volumes?.marca ?? "") },
      { w: 89, label: "NUMERAÇÃO", value: S(volumes?.numeracao ?? "") },
      {
        w: 100,
        label: "PESO BRUTO",
        value: volumes?.pesoBruto != null ? money(volumes.pesoBruto) : "",
        align: "right",
      },
      {
        w: 100,
        label: "PESO LÍQUIDO",
        value: volumes?.pesoLiquido != null ? money(volumes.pesoLiquido) : "",
        align: "right",
      },
    ]);
    return cur;
  };

  // No Simples a coluna de código tributário se chama CSOSN, não CST.
  const cstColLabel = resolveCstCsosn(config.regimeTributario).label;

  const drawProdHeader = (top: number): number => {
    const cur = strip(top, "DADOS DOS PRODUTOS / SERVIÇOS");
    page.drawRectangle({ x: X0, y: cur - PROD_HEADER_H, width: W, height: PROD_HEADER_H, color: WHITE });
    PROD_COLUMNS.forEach((col, i) => {
      const x = colOffsets[i];
      const util = col.width - PAD * 2;
      const labels = col.key === "cst" ? [cstColLabel] : col.label;
      labels.forEach((linha, li) => {
        const t = fitText(linha, util, SIZE_COLHEAD, bold);
        const baseline = cur - 6.5 - li * 5.4;
        if (col.align === "right") right(t, x + col.width - PAD, baseline, SIZE_COLHEAD, bold, LABEL);
        else if (col.align === "center") center(t, x + col.width / 2, baseline, SIZE_COLHEAD, bold, LABEL);
        else text(t, x + PAD, baseline, SIZE_COLHEAD, bold, LABEL);
      });
      if (i > 0) vline(x, cur, cur - PROD_HEADER_H);
    });
    hline(X0, X1, cur - PROD_HEADER_H, FRAME, 0.8);
    return cur - PROD_HEADER_H;
  };

  const drawItemRow = (top: number, index: number, zebra: boolean): number => {
    const it = view.itens[index];
    const linhas = descLines[index];
    const h = itemRowHeight(linhas.length);

    if (zebra) {
      page.drawRectangle({ x: X0, y: top - h, width: W, height: h, color: ZEBRA });
    }

    const imp = it.imposto;
    const cst = resolveCstCsosn(config.regimeTributario, imp?.cstCsosn ?? it.cstIcmsDb);
    const origem = imp?.origem ?? (it.origemDb != null ? String(it.origemDb) : "0");
    // No Simples a coluna traz o CSOSN puro (3 dígitos: "102"); no regime
    // normal traz origem + CST (também 3 dígitos: "0" + "00" = "000"), que é a
    // convenção do DANFE e o que o modelo de referência imprime.
    const cstCol = cst.label === "CSOSN" ? cst.value : `${origem}${cst.value}`;
    const trib = (it.tributos ?? {}) as Record<string, unknown>;
    const val = (fromXml: number | null | undefined, fromDb: unknown): string =>
      fromXml != null ? money(fromXml) : fromDb != null ? money(fromDb) : money(0);

    const values: Record<string, string> = {
      codigo: it.codigo,
      descricao: "",
      ncm: it.ncm,
      cst: cstCol,
      cfop: it.cfop,
      unidade: it.unidade,
      quantidade: formatQty(it.quantidade),
      valorUnitario: money(it.valorUnitario),
      valorTotal: money(it.valorTotal),
      bcIcms: val(imp?.bcIcms, trib.bcIcms),
      valorIcms: val(imp?.valorIcms, trib.valorIcms),
      valorIpi: val(imp?.valorIpi, trib.valorIpi),
      aliqIcms: val(imp?.aliquotaIcms, trib.aliquotaIcms),
      aliqIpi: val(imp?.aliquotaIpi, trib.aliquotaIpi),
    };

    const baseline0 = top - ITEM_PAD_V - ITEM_LINE_H + 2;
    PROD_COLUMNS.forEach((col, i) => {
      const x = colOffsets[i];
      const util = col.width - PAD * 2;
      if (col.key === "descricao") {
        linhas.forEach((l, li) => {
          text(l, x + PAD, baseline0 - li * ITEM_LINE_H, SIZE_ITEM, font, INK);
        });
      } else {
        const t = fitText(values[col.key] ?? "", util, SIZE_ITEM, font);
        if (col.align === "right") right(t, x + col.width - PAD, baseline0, SIZE_ITEM, font, INK);
        else if (col.align === "center") center(t, x + col.width / 2, baseline0, SIZE_ITEM, font, INK);
        else text(t, x + PAD, baseline0, SIZE_ITEM, font, INK);
      }
      if (i > 0) vline(x, top, top - h);
    });
    hline(X0, X1, top - h);
    return top - h;
  };

  const drawInfo = (top: number, linhas: string[]): number => {
    const h = infoHeight(linhas.length);
    frame(X0, top, W, h);
    const cur = strip(top, "DADOS ADICIONAIS");
    const wEsq = W * 0.66;
    vline(X0 + wEsq, cur, top - h);
    text("INFORMAÇÕES COMPLEMENTARES", X0 + PAD, cur - 6.4, SIZE_LABEL, bold, LABEL);
    text("RESERVADO AO FISCO", X0 + wEsq + PAD, cur - 6.4, SIZE_LABEL, bold, LABEL);
    let ly = cur - 14;
    for (const l of linhas) {
      text(l, X0 + PAD, ly, 5.6, font, INK);
      ly -= INFO_LINE_H;
    }
    return top - h;
  };

  const drawFooter = () => {
    text(
      "Documento auxiliar gerado pelo Dexo",
      X0,
      FOOTER_BASELINE,
      5.6,
      font,
      LABEL,
    );
    if (isHomolog) {
      right(
        "SEM VALOR FISCAL — AMBIENTE DE HOMOLOGAÇÃO",
        X1,
        FOOTER_BASELINE,
        5.6,
        bold,
        RED,
      );
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // PASSADA 2: desenhar seguindo o plano
  // ═══════════════════════════════════════════════════════════════

  for (let p = 0; p < plan.pages.length; p++) {
    const spec = plan.pages[p];
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = Y_TOP;

    if (p === 0) y = drawCanhoto(y);
    y = drawIdentificacao(y, p + 1, plan.totalPages);
    y -= GAP;

    if (p === 0) {
      y = drawDestinatario(y);
      y -= GAP;
      y = drawFatura(y);
      y -= GAP;
      y = drawImposto(y);
      y -= GAP;
      y = drawTransportador(y);
      y -= GAP;
    }

    if (spec.hasItemsTable) {
      const topTabela = y;
      y = drawProdHeader(y);
      let zebra = false;
      for (let i = spec.startItem; i < spec.endItem; i++) {
        y = drawItemRow(y, i, zebra);
        zebra = !zebra;
      }
      // Moldura da tabela fechando faixa + cabeçalho + linhas.
      frame(X0, topTabela, W, topTabela - y);
      y -= GAP;
    }

    if (spec.hasInfo) {
      y = drawInfo(y, infoLines.slice(spec.infoLineStart, spec.infoLineEnd));
    }

    drawFooter();
  }

  return doc.save();
}

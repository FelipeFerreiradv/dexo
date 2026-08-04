/**
 * DANFE NFC-e (cupom fiscal), modelo 65 — bobina de 80mm.
 *
 * Segue o Manual de Padrões Técnicos do DANFE NFC-e: cabeçalho do emitente,
 * faixa legal, tabela de itens, totais, forma de pagamento, consulta pela chave
 * de acesso, identificação do consumidor, protocolo de autorização e QR Code.
 *
 * MOTOR DE DUAS FASES (medir → desenhar). A altura da bobina é calculada a
 * partir de uma lista de operações cujo `h` sai das MESMAS fontes e do MESMO
 * wrap usados no desenho. Antes disto a altura era uma soma de constantes
 * chutadas que já subestimava alguns blocos e só não vazava porque outros
 * sobravam — um item com descrição longa bastava para o conteúdo sair da
 * página. Agora subestimar é estruturalmente impossível, e há um invariante
 * de TINTA REAL (não uma tautologia aritmética) verificado nos testes.
 */

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";

import type { NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import { parseNfeXml } from "../sefaz/nfe-xml-parser.service";
import { extractQrCodeFromXml } from "../nfce/qr-code";
import { projectParsedNfeToDraft } from "./danfe-pdf.service";
import { formatBRLNumber, toWinAnsiSafeLine, wrapTextLines } from "./danfe-helpers";
import { normalizePagamentos, type PagamentoView } from "./danfe-render-extras";
import { composeInfCpl } from "../domain/inf-cpl";

// 80mm em pontos (1pt = 1/72"; 80mm ≈ 226.77pt)
const CUPOM_W = 226.77;
const MARGIN = 9;
const INNER_W = CUPOM_W - MARGIN * 2;
const PAD_TOP = 10;
const PAD_BOT = 12;

const INK = rgb(0, 0, 0);
const GRAY = rgb(0.35, 0.35, 0.35);

export interface DanfeNfceInput {
  draft: NfeDraftResponse;
  config: CompanyFiscalConfig;
  chaveAcesso: string | null;
  protocolo: string | null;
  dataAutorizacao?: string | Date | null;
  /** URL completa do QR (conteúdo do `<qrCode>`). null ⇒ cupom sem imagem QR. */
  qrCode: string | null;
  /** URL de consulta por chave (conteúdo do `<urlChave>`). */
  urlChave: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// Motor de operações
// ═══════════════════════════════════════════════════════════════════

/**
 * Superfície de desenho que REGISTRA a extensão vertical da tinta emitida.
 *
 * É o que permite ao teste afirmar "nenhuma operação desenhou abaixo do que
 * reservou" — comparar `height` com a soma dos `h` seria tautológico, já que
 * a altura É a soma.
 */
export interface DrawSurface {
  text(
    t: string,
    opts: {
      x?: number;
      baseline: number;
      size: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      align?: "left" | "center" | "right";
    },
  ): void;
  line(y: number): void;
  image(img: PDFImage, x: number, y: number, size: number): void;
}

export interface CupomOp {
  /** Rótulo de diagnóstico — aparece nas mensagens de falha dos testes. */
  label: string;
  h: number;
  draw: (s: DrawSurface, top: number) => void;
}

/** Cria uma superfície ligada a uma página real, reportando a menor tinta. */
function pageSurface(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  onInk: (y: number) => void,
): DrawSurface {
  return {
    text(t, o) {
      if (!t) return;
      const f = o.bold ? bold : font;
      const w = f.widthOfTextAtSize(t, o.size);
      const x =
        o.align === "center"
          ? (CUPOM_W - w) / 2
          : o.align === "right"
            ? CUPOM_W - MARGIN - w
            : (o.x ?? MARGIN);
      page.drawText(t, { x, y: o.baseline, size: o.size, font: f, color: o.color ?? INK });
      // Descendente aproximado das Helvetica (~21% do corpo).
      onInk(o.baseline - o.size * 0.21);
    },
    line(y) {
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: CUPOM_W - MARGIN, y },
        thickness: 0.5,
        color: GRAY,
      });
      onInk(y);
    },
    image(img, x, y, size) {
      page.drawImage(img, { x, y, width: size, height: size });
      onInk(y);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Construção das operações (fase de medição)
// ═══════════════════════════════════════════════════════════════════

const LINE_GAP = 2;
const RULE_H = 6;

/**
 * Descendente aproximado das Helvetica, em fração do corpo.
 *
 * A altura de um bloco de texto NÃO é só a soma dos corpos + gaps: a última
 * linha ainda pinta abaixo da sua baseline (perna do "p", "g", "ç"). Ignorar
 * isso faz cada bloco vazar ~1-2pt para dentro do bloco seguinte — invisível
 * bloco a bloco, cumulativo ao longo da bobina.
 */
const DESCENDER = 0.21;

interface BuildDeps {
  font: PDFFont;
  bold: PDFFont;
  qrImage: PDFImage | null;
}

/** Bloco de linhas de texto (já quebradas), com altura = Σ (size + gap). */
function textBlock(
  label: string,
  linhas: Array<{
    t: string;
    size: number;
    bold?: boolean;
    align?: "left" | "center" | "right";
    color?: ReturnType<typeof rgb>;
  }>,
): CupomOp {
  const ultima = linhas[linhas.length - 1];
  const h =
    linhas.reduce((a, l) => a + l.size + LINE_GAP, 0) +
    (ultima ? ultima.size * DESCENDER : 0);
  return {
    label,
    h,
    draw(s, top) {
      let y = top;
      for (const l of linhas) {
        y -= l.size + LINE_GAP;
        s.text(l.t, {
          baseline: y,
          size: l.size,
          bold: l.bold,
          align: l.align ?? "left",
          color: l.color,
        });
      }
    },
  };
}

/** Linha rótulo-à-esquerda / valor-à-direita. */
function kvRow(
  label: string,
  esquerda: string,
  direita: string,
  size: number,
  isBold = false,
): CupomOp {
  const h = size + LINE_GAP + size * DESCENDER;
  return {
    label,
    h,
    draw(s, top) {
      const baseline = top - size - LINE_GAP;
      s.text(esquerda, { baseline, size, bold: isBold });
      s.text(direita, { baseline, size, bold: isBold, align: "right" });
    },
  };
}

function ruleOp(label = "rule"): CupomOp {
  return {
    label,
    h: RULE_H,
    draw(s, top) {
      s.line(top - RULE_H / 2);
    },
  };
}

function spacerOp(h: number, label = "spacer"): CupomOp {
  return { label, h: Math.max(0, h), draw: () => {} };
}

/** Quantidade com até 4 casas — a SEFAZ permite 4 em `qCom`. */
function formatQty(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  const s = v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(".", ",");
}

function formatCnpj(cnpj: unknown): string {
  const d = String(cnpj ?? "").replace(/\D/g, "");
  if (d.length !== 14) return String(cnpj ?? "");
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function formatChave(chave: string): string {
  return chave.replace(/(\d{4})(?=\d)/g, "$1 ");
}

/**
 * Monta a lista de operações do cupom. Exportada para que o teste possa medir
 * o layout sem gerar PDF e verificar o invariante de fechamento.
 */
export function buildCupomOps(input: DanfeNfceInput, deps: BuildDeps): CupomOp[] {
  const { draft, config } = input;
  const { font, bold, qrImage } = deps;
  const S = toWinAnsiSafeLine;

  const itens = draft.itens ?? [];
  const pagamentos = normalizePagamentos(draft.pagamentosJson);
  const isHomolog = draft.ambiente !== "PRODUCAO";
  const dest = draft.destinatarioJson as { cpfCnpj?: string | null } | null;
  const totais = (draft.totaisJson ?? null) as { totalNota?: number; totalDesconto?: number } | null;
  const totalNota =
    Number(totais?.totalNota) ||
    itens.reduce((acc, it) => acc + (Number(it.valorTotal) || 0), 0);
  const totalDesconto = Number(totais?.totalDesconto) || 0;

  const wrap = (t: string, size: number, f: PDFFont = font, largura = INNER_W) =>
    wrapTextLines(t, largura, (s) => f.widthOfTextAtSize(s, size));

  const ops: CupomOp[] = [];

  // ── Emitente ──
  const emitLinhas: Array<{ t: string; size: number; bold?: boolean; align: "center" }> = [];
  for (const l of wrap(S(config.razaoSocial ?? ""), 8.5, bold)) {
    emitLinhas.push({ t: l, size: 8.5, bold: true, align: "center" });
  }
  emitLinhas.push({ t: `CNPJ ${formatCnpj(config.cnpj)}`, size: 6.5, align: "center" });
  const endereco = S(
    [config.logradouro, config.numero, config.bairro].filter(Boolean).join(", "),
  );
  for (const l of wrap(endereco, 6.5)) emitLinhas.push({ t: l, size: 6.5, align: "center" });
  const cidade = S([config.municipio, config.uf].filter(Boolean).join(" - "));
  if (cidade) emitLinhas.push({ t: cidade, size: 6.5, align: "center" });
  ops.push(textBlock("emitente", emitLinhas));
  ops.push(ruleOp("rule:emitente"));

  // ── Faixa legal ──
  const legal: Array<{ t: string; size: number; bold?: boolean; align: "center"; color?: ReturnType<typeof rgb> }> = [];
  for (const l of wrap("DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica", 6.5, bold)) {
    legal.push({ t: l, size: 6.5, bold: true, align: "center" });
  }
  for (const l of wrap("Não permite aproveitamento de crédito de ICMS", 6)) {
    legal.push({ t: l, size: 6, align: "center", color: GRAY });
  }
  ops.push(textBlock("faixa-legal", legal));

  if (isHomolog) {
    ops.push(ruleOp("rule:homolog"));
    ops.push(
      textBlock("homologacao", [
        { t: "EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO", size: 7, bold: true, align: "center" },
        { t: "SEM VALOR FISCAL", size: 7.5, bold: true, align: "center" },
      ]),
    );
  }
  ops.push(ruleOp("rule:pre-itens"));

  // ── Itens ──
  ops.push(
    textBlock("itens:cabecalho", [
      { t: "CÓD  DESCRIÇÃO", size: 6, bold: true, align: "left" },
      { t: "QTD  UN   VL UNIT        VL TOTAL", size: 6, bold: true, align: "right" },
    ]),
  );

  itens.forEach((it, idx) => {
    const numero = String(idx + 1).padStart(3, "0");
    const codigo = S(String(it.codigo ?? ""));
    const descricao = S(String(it.descricao ?? ""));
    const prefixo = `${numero} ${codigo} `;
    const larguraDesc = INNER_W - font.widthOfTextAtSize(prefixo, 6.5);
    const linhasDesc = wrap(descricao, 6.5, font, Math.max(40, larguraDesc));

    const qtd = formatQty(it.quantidade);
    const un = S(String(it.unidade ?? "UN"));
    const vu = formatBRLNumber(Number(it.valorUnitario) || 0);
    const vt = formatBRLNumber(Number(it.valorTotal) || 0);

    // (n linhas de descrição + 1 linha de qtd/valores) × passo + descendente.
    const nLinhas = Math.max(1, linhasDesc.length);
    const h = (nLinhas + 1) * (6.5 + LINE_GAP) + 6.5 * DESCENDER;
    ops.push({
      label: `item:${idx + 1}`,
      h,
      draw(s, top) {
        let y = top - 6.5 - LINE_GAP;
        s.text(`${prefixo}${linhasDesc[0] ?? ""}`, { baseline: y, size: 6.5 });
        for (let i = 1; i < linhasDesc.length; i++) {
          y -= 6.5 + LINE_GAP;
          s.text(linhasDesc[i], { x: MARGIN + 12, baseline: y, size: 6.5 });
        }
        y -= 6.5 + LINE_GAP;
        s.text(`${qtd} ${un} x ${vu}`, { x: MARGIN + 12, baseline: y, size: 6.5, color: GRAY });
        s.text(vt, { baseline: y, size: 6.5, bold: true, align: "right" });
      },
    });
  });
  ops.push(ruleOp("rule:pos-itens"));

  // ── Totais ──
  ops.push(kvRow("total:qtd", "QTD. TOTAL DE ITENS", String(itens.length), 6.5));
  ops.push(kvRow("total:produtos", "VALOR TOTAL R$", formatBRLNumber(totalNota + totalDesconto), 6.5));
  if (totalDesconto > 0) {
    ops.push(kvRow("total:desconto", "DESCONTO R$", formatBRLNumber(totalDesconto), 6.5));
  }
  ops.push(kvRow("total:pagar", "VALOR A PAGAR R$", formatBRLNumber(totalNota), 9, true));
  ops.push(spacerOp(3, "gap:pagamento"));

  // ── Formas de pagamento ──
  ops.push(
    textBlock("pagamento:cabecalho", [
      { t: "FORMA DE PAGAMENTO", size: 6, bold: true, align: "left" },
    ]),
  );
  const pagRows: PagamentoView[] =
    pagamentos.length > 0 ? pagamentos : [{ label: "Sem pagamento", valor: 0 }];
  pagRows.forEach((p, i) => {
    ops.push(
      kvRow(`pagamento:${i}`, S(p.label), formatBRLNumber(p.valor ?? 0), 6.5),
    );
  });
  ops.push(ruleOp("rule:pos-pagamento"));

  // ── Consulta pela chave ──
  const chave = String(input.chaveAcesso ?? "").replace(/\D/g, "");
  const consulta: Array<{ t: string; size: number; bold?: boolean; align: "center"; color?: ReturnType<typeof rgb> }> = [];
  consulta.push({ t: "Consulte pela Chave de Acesso em:", size: 6, align: "center", color: GRAY });
  if (input.urlChave) {
    for (const l of wrap(S(input.urlChave), 6)) consulta.push({ t: l, size: 6, align: "center" });
  }
  if (chave) {
    for (const l of wrap(formatChave(chave), 6.5, bold)) {
      consulta.push({ t: l, size: 6.5, bold: true, align: "center" });
    }
  }
  ops.push(textBlock("consulta-chave", consulta));
  ops.push(ruleOp("rule:pos-chave"));

  // ── Consumidor ──
  const docDest = String(dest?.cpfCnpj ?? "").replace(/\D/g, "");
  ops.push(
    textBlock("consumidor", [
      { t: "CONSUMIDOR", size: 6, bold: true, align: "center" },
      {
        t: docDest
          ? `${docDest.length <= 11 ? "CPF" : "CNPJ"} ${docDest}`
          : "CONSUMIDOR NÃO IDENTIFICADO",
        size: 6.5,
        align: "center",
      },
    ]),
  );
  ops.push(ruleOp("rule:pos-consumidor"));

  // ── Identificação / autorização ──
  const ident: Array<{ t: string; size: number; bold?: boolean; align: "center"; color?: ReturnType<typeof rgb> }> = [];
  ident.push({
    t: `NFC-e nº ${draft.numero ?? ""}  Série ${draft.serie ?? ""}`,
    size: 6.5,
    bold: true,
    align: "center",
  });
  const dtEmi = toDate(draft.dataEmissao);
  if (dtEmi) {
    ident.push({ t: `Emissão: ${formatDateTime(dtEmi)}`, size: 6, align: "center", color: GRAY });
  }
  if (input.protocolo) {
    const dt = toDate(input.dataAutorizacao);
    ident.push({
      t: `Protocolo de Autorização: ${input.protocolo}`,
      size: 6,
      align: "center",
      color: GRAY,
    });
    if (dt) ident.push({ t: formatDateTime(dt), size: 6, align: "center", color: GRAY });
  }
  ops.push(textBlock("identificacao", ident));

  // ── QR Code ──
  if (qrImage) {
    const size = 108;
    ops.push({
      label: "qrcode",
      h: size + 10,
      draw(s, top) {
        s.image(qrImage, (CUPOM_W - size) / 2, top - size - 5, size);
      },
    });
  } else if (input.qrCode) {
    ops.push(
      textBlock("qrcode:indisponivel", [
        { t: "[QR Code indisponível]", size: 6.5, align: "center", color: GRAY },
      ]),
    );
  }

  // ── Informações complementares (tributos aproximados) ──
  const infCpl = toWinAnsiSafeLine(composeInfCpl(draft));
  if (infCpl) {
    ops.push(ruleOp("rule:pre-infcpl"));
    ops.push(
      textBlock(
        "infcpl",
        wrap(infCpl, 5.6).map((t) => ({ t, size: 5.6, align: "center" as const, color: GRAY })),
      ),
    );
  }

  return ops;
}

/** Altura total da bobina = padding + Σ das operações. */
export function cupomHeight(ops: CupomOp[]): number {
  return PAD_TOP + ops.reduce((a, o) => a + o.h, 0) + PAD_BOT;
}

/**
 * Invariante de layout, verificado só sob teste.
 *
 * NUNCA lança em runtime de servidor: a produção do Dexo não define
 * `NODE_ENV` e a emissão engole exceções num `catch` mudo — lançar aqui
 * produziria "venda autorizada, cupom inexistente, sem log". Fora dos testes,
 * no máximo avisa.
 */
function assertLayoutClosed(ops: CupomOp[], minInk: number): void {
  if (minInk >= -0.01) return;
  const msg = `[NFC-e] layout vazou ${(-minInk).toFixed(2)}pt abaixo da página (ops=${ops.length})`;
  if (process.env.VITEST) throw new Error(msg);
  console.warn(msg);
}

// ═══════════════════════════════════════════════════════════════════
// Serviço
// ═══════════════════════════════════════════════════════════════════

export class DanfeNfcePdfService {
  async generate(input: DanfeNfceInput): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    // O QR entra na MEDIÇÃO, então é resolvido antes de montar as operações.
    // Best-effort: falha ⇒ cupom sem imagem (o dado fiscal está no XML).
    let qrImage: PDFImage | null = null;
    if (input.qrCode) {
      try {
        const QRCode = (await import("qrcode")).default;
        const dataUrl: string = await QRCode.toDataURL(input.qrCode, { margin: 0, width: 220 });
        qrImage = await doc.embedPng(dataUrl);
      } catch {
        qrImage = null;
      }
    }

    const ops = buildCupomOps(input, { font, bold, qrImage });
    const height = cupomHeight(ops);
    const page = doc.addPage([CUPOM_W, height]);

    let minInk = Number.POSITIVE_INFINITY;
    const surface = pageSurface(page, font, bold, (y) => {
      if (y < minInk) minInk = y;
    });

    let top = height - PAD_TOP;
    for (const op of ops) {
      op.draw(surface, top);
      top -= op.h;
    }

    assertLayoutClosed(ops, Number.isFinite(minInk) ? minInk : 0);
    return doc.save();
  }

  /**
   * Gera o cupom a partir do XML AUTORIZADO (nfeProc). Mesmos guards do DANFE
   * 55: exige protNFe com cStat 100/150. QR/urlChave extraídos do infNFeSupl.
   */
  async generateFromXml(xml: string): Promise<Uint8Array> {
    const parsed = parseNfeXml(xml);
    const cStat = parsed.protNFe?.cStat ?? null;
    if (cStat === null) {
      throw new Error(
        "DANFE NFC-e exige XML autorizado (nfeProc com protNFe) — XML sem protocolo",
      );
    }
    if (cStat !== 100 && cStat !== 150) {
      throw new Error(
        `DANFE NFC-e so pode ser gerado para nota autorizada (cStat 100/150). Recebido cStat=${cStat}`,
      );
    }
    const projected = projectParsedNfeToDraft(parsed);
    const { qrCode, urlChave } = extractQrCodeFromXml(xml);
    return this.generate({
      draft: projected.draft,
      config: projected.config,
      chaveAcesso: parsed.chaveAcesso || projected.draft.chaveAcesso || null,
      protocolo: parsed.protNFe?.nProt ?? null,
      dataAutorizacao: parsed.protNFe?.dhRecbto ?? null,
      qrCode,
      urlChave,
    });
  }
}

// ── Helpers puros ──

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(d: Date): string {
  return `${d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} ${d.toLocaleTimeString(
    "pt-BR",
    { timeZone: "America/Sao_Paulo" },
  )}`;
}

export const __internals = { CUPOM_W, MARGIN, INNER_W, PAD_TOP, PAD_BOT };

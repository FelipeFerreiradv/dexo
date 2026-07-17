/**
 * DANFE NFC-e (cupom) — Documento Auxiliar da NFC-e, modelo 65.
 *
 * NOVO serviço (Fase 2 do PDV), 100% aditivo: o DANFE A4 da NF-e 55
 * (danfe-pdf.service.ts) segue intocado. Layout cupom 80mm (226.77pt de
 * largura, altura calculada pelo conteúdo), com QR Code obrigatório.
 *
 * QR: pacote `qrcode` (já é dependência; mesmo padrão de uso de
 * app/localizacoes/lib/location-labels-pdf.ts) — toDataURL → embedPng.
 * Roda server-side (Fastify), sem guard de window.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type { NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import { parseNfeXml } from "../sefaz/nfe-xml-parser.service";
import { extractQrCodeFromXml } from "../nfce/qr-code";
import { projectParsedNfeToDraft } from "./danfe-pdf.service";
import { formatBRLNumber } from "./danfe-helpers";

// Rótulos de meio de pagamento locais ao motor fiscal (evita acoplar o
// backend à lib de formulário do front). Chaves = MeioPagamento (nfe.types).
const MEIO_LABELS: Record<string, string> = {
  DINHEIRO: "Dinheiro",
  CHEQUE: "Cheque",
  CARTAO_CREDITO: "Cartao de credito",
  CARTAO_DEBITO: "Cartao de debito",
  CREDITO_LOJA: "Credito loja",
  VALE_ALIMENTACAO: "Vale alimentacao",
  VALE_REFEICAO: "Vale refeicao",
  VALE_PRESENTE: "Vale presente",
  VALE_COMBUSTIVEL: "Vale combustivel",
  BOLETO: "Boleto bancario",
  DEPOSITO: "Deposito bancario",
  PIX: "PIX",
  TRANSFERENCIA: "Transferencia bancaria",
  PROGRAMA_FIDELIDADE: "Programa de fidelidade",
  SEM_PAGAMENTO: "Sem pagamento",
  OUTROS: "Outros",
};

// 80mm em pontos (1pt = 1/72"; 80mm ≈ 226.77pt)
const CUPOM_W = 226.77;
const MARGIN = 10;
const INNER_W = CUPOM_W - MARGIN * 2;

export interface DanfeNfceInput {
  draft: NfeDraftResponse;
  config: CompanyFiscalConfig;
  chaveAcesso: string | null;
  protocolo: string | null;
  dataAutorizacao?: string | Date | null;
  /** URL completa do QR (conteúdo do <qrCode>). null ⇒ cupom sem imagem QR. */
  qrCode: string | null;
  /** URL de consulta por chave (conteúdo do <urlChave>). */
  urlChave: string | null;
}

export class DanfeNfcePdfService {
  async generate(input: DanfeNfceInput): Promise<Uint8Array> {
    const { draft, config } = input;
    const itens = draft.itens ?? [];
    const pagamentos = ((draft.pagamentosJson as any[]) ?? []).filter(Boolean);
    const isHomolog = draft.ambiente !== "PRODUCAO";
    const dest = draft.destinatarioJson as any;
    const totais = (draft.totaisJson as any) ?? null;
    const totalNota =
      Number(totais?.totalNota) ||
      itens.reduce((acc, it) => acc + (Number(it.valorTotal) || 0), 0);
    const totalDesconto = Number(totais?.totalDesconto) || 0;

    // ── Altura calculada pelo conteúdo (cupom térmico: sem página fixa) ──
    const qrSize = input.qrCode ? 110 : 0;
    const height =
      MARGIN * 2 +
      64 + // cabeçalho emitente
      (isHomolog ? 22 : 0) +
      16 + // título documento
      12 + // header tabela itens
      itens.length * 18 +
      8 +
      (totalDesconto > 0 ? 11 : 0) +
      13 + // total
      Math.max(pagamentos.length, 1) * 11 +
      8 +
      22 + // consumidor
      30 + // chave de acesso (label + 2 linhas)
      (input.urlChave ? 18 : 0) +
      (qrSize ? qrSize + 8 : 0) +
      24 + // protocolo
      8;

    const doc = await PDFDocument.create();
    const page = doc.addPage([CUPOM_W, height]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const black = rgb(0, 0, 0);
    const gray = rgb(0.35, 0.35, 0.35);

    let y = height - MARGIN;

    const text = (
      s: string,
      size: number,
      opts?: { bold?: boolean; center?: boolean; color?: any },
    ) => {
      const f = opts?.bold ? bold : font;
      const w = f.widthOfTextAtSize(s, size);
      const x = opts?.center ? (CUPOM_W - w) / 2 : MARGIN;
      y -= size + 2;
      page.drawText(s, { x, y, size, font: f, color: opts?.color ?? black });
    };

    const hr = () => {
      y -= 4;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: CUPOM_W - MARGIN, y },
        thickness: 0.5,
        color: gray,
      });
      y -= 2;
    };

    // ── Emitente ──
    text(trunc(config.razaoSocial ?? "", 38), 9, { bold: true, center: true });
    text(`CNPJ ${formatCnpj(config.cnpj ?? "")}`, 7, { center: true });
    const endLinha = [config.logradouro, config.numero]
      .filter(Boolean)
      .join(", ");
    if (endLinha) text(trunc(endLinha, 44), 7, { center: true });
    const cidadeLinha = [config.municipio, config.uf].filter(Boolean).join(" - ");
    if (cidadeLinha) text(trunc(cidadeLinha, 44), 7, { center: true });
    hr();

    if (isHomolog) {
      text("EMITIDA EM AMBIENTE DE HOMOLOGACAO", 8, { bold: true, center: true });
      text("SEM VALOR FISCAL", 8, { bold: true, center: true });
      hr();
    }

    text("DANFE NFC-e - Documento Auxiliar da NFC-e", 7.5, {
      bold: true,
      center: true,
    });
    text("Nao permite aproveitamento de credito de ICMS", 6.5, {
      center: true,
      color: gray,
    });
    hr();

    // ── Itens ──
    text("ITEM  DESCRICAO           QTD x UNIT       TOTAL", 6.5, {
      bold: true,
    });
    itens.forEach((it, idx) => {
      const desc = trunc(it.descricao ?? "", 34);
      text(`${String(idx + 1).padStart(3, "0")} ${desc}`, 7);
      const qtd = Number(it.quantidade) || 0;
      const vu = Number(it.valorUnitario) || 0;
      const vt = Number(it.valorTotal) || 0;
      const linha = `${qtd} x ${formatBRLNumber(vu)}`;
      const totalStr = formatBRLNumber(vt);
      // linha de valores: qtd x unit à esquerda, total à direita
      y -= 9;
      page.drawText(linha, { x: MARGIN + 14, y, size: 7, font, color: black });
      const tw = bold.widthOfTextAtSize(totalStr, 7);
      page.drawText(totalStr, {
        x: CUPOM_W - MARGIN - tw,
        y,
        size: 7,
        font: bold,
        color: black,
      });
    });
    hr();

    // ── Totais + pagamentos ──
    if (totalDesconto > 0) {
      rowKV(page, font, bold, y, "Desconto", formatBRLNumber(totalDesconto));
      y -= 11;
    }
    rowKV(page, font, bold, y, "TOTAL R$", formatBRLNumber(totalNota), true);
    y -= 13;
    const pagRows =
      pagamentos.length > 0
        ? pagamentos.map((p) => ({
            label: MEIO_LABELS[p.meio] ?? String(p.meio ?? "Outros"),
            valor: formatBRLNumber(Number(p.valor) || 0),
          }))
        : [{ label: "Sem pagamento", valor: formatBRLNumber(0) }];
    for (const p of pagRows) {
      rowKV(page, font, bold, y, p.label, p.valor);
      y -= 11;
    }
    hr();

    // ── Consumidor ──
    const docDest = String(dest?.cpfCnpj ?? "").replace(/\D/g, "");
    if (docDest) {
      text(
        `CONSUMIDOR ${docDest.length <= 11 ? "CPF" : "CNPJ"} ${docDest}`,
        7,
        { center: true },
      );
    } else {
      text("CONSUMIDOR NAO IDENTIFICADO", 7, { center: true });
    }
    hr();

    // ── Chave de acesso ──
    const chave = (input.chaveAcesso ?? "").replace(/\D/g, "");
    text(
      `NFC-e n. ${draft.numero ?? ""} Serie ${draft.serie ?? ""} ${
        isHomolog ? "HOMOLOGACAO" : ""
      }`.trim(),
      7,
      { bold: true, center: true },
    );
    if (chave) {
      text("Chave de acesso:", 6.5, { center: true, color: gray });
      text(formatChave(chave), 6.5, { center: true });
    }
    if (input.urlChave) {
      text("Consulte pela chave em:", 6, { center: true, color: gray });
      text(trunc(input.urlChave, 52), 6, { center: true });
    }

    // ── QR Code ──
    if (input.qrCode) {
      try {
        const QRCode = (await import("qrcode")).default;
        const dataUrl: string = await QRCode.toDataURL(input.qrCode, {
          margin: 0,
          width: 220,
        });
        const png = await doc.embedPng(dataUrl);
        const qx = (CUPOM_W - qrSize) / 2;
        y -= qrSize + 4;
        page.drawImage(png, { x: qx, y, width: qrSize, height: qrSize });
        y -= 4;
      } catch {
        // QR é best-effort no PDF (o dado fiscal está no XML); nunca derruba
        // a geração do cupom.
        text("[QR Code indisponivel]", 7, { center: true, color: gray });
      }
    }

    // ── Protocolo ──
    if (input.protocolo) {
      const dt = input.dataAutorizacao
        ? new Date(input.dataAutorizacao)
        : null;
      const dtStr =
        dt && !Number.isNaN(dt.getTime())
          ? ` ${dt.toLocaleDateString("pt-BR")} ${dt.toLocaleTimeString("pt-BR")}`
          : "";
      text(`Protocolo de autorizacao: ${input.protocolo}${dtStr}`, 6.5, {
        center: true,
      });
    }

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

function trunc(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatCnpj(cnpj: string): string {
  const d = (cnpj ?? "").replace(/\D/g, "");
  if (d.length !== 14) return cnpj ?? "";
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Chave em grupos de 4 (2 linhas de 22 dígitos p/ caber na largura). */
function formatChave(chave: string): string {
  return chave.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function rowKV(
  page: any,
  font: any,
  bold: any,
  y: number,
  label: string,
  value: string,
  emphasize = false,
): void {
  const size = emphasize ? 8.5 : 7;
  const f = emphasize ? bold : font;
  page.drawText(label, {
    x: MARGIN,
    y: y - size,
    size,
    font: f,
    color: rgb(0, 0, 0),
  });
  const vw = f.widthOfTextAtSize(value, size);
  page.drawText(value, {
    x: CUPOM_W - MARGIN - vw,
    y: y - size,
    size,
    font: f,
    color: rgb(0, 0, 0),
  });
}

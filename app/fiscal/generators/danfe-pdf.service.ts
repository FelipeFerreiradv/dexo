import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { NfeDraftResponse, NfeDraftItem } from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeTotais } from "../domain/nfe.types";

/**
 * Gerador de DANFE simplificado usando pdf-lib.
 *
 * Gera um PDF A4 com layout simplificado contendo:
 * - Cabeçalho com dados do emitente
 * - Chave de acesso e protocolo
 * - Dados do destinatário
 * - Tabela de itens
 * - Totais e pagamentos
 *
 * NÃO é um DANFE oficial completo (precisaria de layout específico),
 * mas é funcional para homologação e conferência.
 */
export class DanfePdfService {
  async generate(
    nfe: NfeDraftResponse,
    config: CompanyFiscalConfig,
    chaveAcesso: string | null,
    protocolo: string | null,
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]); // A4
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const { width, height } = page.getSize();
    const margin = 40;
    let y = height - margin;
    const black = rgb(0, 0, 0);
    const gray = rgb(0.4, 0.4, 0.4);
    const lineHeight = 14;

    const drawText = (
      text: string,
      x: number,
      yPos: number,
      size = 9,
      f = font,
      color = black,
    ) => {
      page.drawText(text, { x, y: yPos, size, font: f, color });
    };

    const drawLine = (yPos: number) => {
      page.drawLine({
        start: { x: margin, y: yPos },
        end: { x: width - margin, y: yPos },
        thickness: 0.5,
        color: gray,
      });
    };

    // ── Header ──
    drawText("DANFE - Documento Auxiliar da Nota Fiscal Eletronica", margin, y, 12, fontBold);
    y -= 20;
    drawText("NF-e", margin, y, 10, fontBold);
    drawText(`Numero: ${nfe.numero}  Serie: ${nfe.serie}`, margin + 40, y, 10);
    y -= lineHeight;

    const ambienteLabel = nfe.ambiente === "HOMOLOGACAO"
      ? "** SEM VALOR FISCAL - HOMOLOGACAO **"
      : "";
    if (ambienteLabel) {
      drawText(ambienteLabel, margin, y, 10, fontBold, rgb(0.8, 0, 0));
      y -= lineHeight;
    }

    drawLine(y);
    y -= lineHeight;

    // ── Emitente ──
    drawText("EMITENTE", margin, y, 9, fontBold);
    y -= lineHeight;
    drawText(`Razao Social: ${config.razaoSocial}`, margin, y);
    y -= lineHeight;
    drawText(`CNPJ: ${this.formatCnpj(config.cnpj)}  IE: ${config.inscricaoEstadual}`, margin, y);
    y -= lineHeight;
    const endEmit = [config.logradouro, config.numero, config.bairro, config.municipio, config.uf]
      .filter(Boolean)
      .join(", ");
    drawText(`Endereco: ${endEmit}`, margin, y, 8);
    y -= lineHeight + 4;
    drawLine(y);
    y -= lineHeight;

    // ── Chave de acesso ──
    drawText("CHAVE DE ACESSO", margin, y, 9, fontBold);
    y -= lineHeight;
    drawText(chaveAcesso || "Pendente de autorizacao", margin, y, 8);
    y -= lineHeight;

    if (protocolo) {
      drawText(`Protocolo: ${protocolo}`, margin, y, 8);
      y -= lineHeight;
    }

    drawLine(y);
    y -= lineHeight;

    // ── Destinatário ──
    const dest = nfe.destinatarioJson;
    drawText("DESTINATARIO", margin, y, 9, fontBold);
    y -= lineHeight;
    if (dest) {
      drawText(`Nome: ${dest.nome || "-"}`, margin, y);
      y -= lineHeight;
      drawText(`CPF/CNPJ: ${dest.cpfCnpj || "-"}`, margin, y);
      y -= lineHeight;
      const endDest = [dest.logradouro, dest.numero, dest.bairro, dest.municipio, dest.uf]
        .filter(Boolean)
        .join(", ");
      if (endDest) {
        drawText(`Endereco: ${endDest}`, margin, y, 8);
        y -= lineHeight;
      }
    }
    y -= 4;
    drawLine(y);
    y -= lineHeight;

    // ── Itens ──
    drawText("PRODUTOS / SERVICOS", margin, y, 9, fontBold);
    y -= lineHeight;

    // Header da tabela
    const cols = [margin, margin + 30, margin + 230, margin + 290, margin + 350, margin + 420];
    drawText("#", cols[0], y, 7, fontBold, gray);
    drawText("Descricao", cols[1], y, 7, fontBold, gray);
    drawText("Qtd", cols[2], y, 7, fontBold, gray);
    drawText("Unit.", cols[3], y, 7, fontBold, gray);
    drawText("Total", cols[4], y, 7, fontBold, gray);
    drawText("NCM", cols[5], y, 7, fontBold, gray);
    y -= lineHeight;

    for (const item of nfe.itens) {
      if (y < margin + 80) break; // espaço para totais

      const desc =
        item.descricao.length > 35
          ? item.descricao.substring(0, 35) + "..."
          : item.descricao;

      drawText(String(item.numero), cols[0], y, 7);
      drawText(desc, cols[1], y, 7);
      drawText(String(item.quantidade), cols[2], y, 7);
      drawText(Number(item.valorUnitario).toFixed(2), cols[3], y, 7);
      drawText(Number(item.valorTotal).toFixed(2), cols[4], y, 7);
      drawText(item.ncm, cols[5], y, 7);
      y -= lineHeight;
    }

    y -= 4;
    drawLine(y);
    y -= lineHeight;

    // ── Totais ──
    const totais = (nfe.totaisJson ?? {}) as NfeTotais;
    drawText("TOTAIS", margin, y, 9, fontBold);
    y -= lineHeight;
    drawText(`Total Produtos: R$ ${(totais.totalProdutos ?? 0).toFixed(2)}`, margin, y, 8);
    drawText(`Desconto: R$ ${(totais.totalDesconto ?? 0).toFixed(2)}`, margin + 200, y, 8);
    y -= lineHeight;
    drawText(`ICMS: R$ ${(totais.totalIcms ?? 0).toFixed(2)}`, margin, y, 8);
    drawText(`PIS: R$ ${(totais.totalPis ?? 0).toFixed(2)}`, margin + 150, y, 8);
    drawText(`COFINS: R$ ${(totais.totalCofins ?? 0).toFixed(2)}`, margin + 300, y, 8);
    y -= lineHeight;
    drawText(
      `TOTAL DA NOTA: R$ ${(totais.totalNota ?? 0).toFixed(2)}`,
      margin,
      y,
      11,
      fontBold,
    );

    return doc.save();
  }

  private formatCnpj(cnpj: string): string {
    const d = cnpj.replace(/\D/g, "");
    if (d.length !== 14) return cnpj;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
}

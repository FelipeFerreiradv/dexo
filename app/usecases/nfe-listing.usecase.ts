import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import {
  buildRelatorioMensalXml,
  type RelatorioNota,
} from "../fiscal/generators/relatorio-mensal-xml";
import type {
  NfeListQuery,
  NfeListResponse,
  NfeStats,
} from "../interfaces/nfe.interface";

export class NfeListingUseCase {
  private repo = new NfeRepository();
  private configRepo = new CompanyFiscalRepository();
  private storage = new FiscalStorageService();

  async list(userId: string, query: NfeListQuery): Promise<NfeListResponse> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 10));
    return this.repo.findEmitted(userId, { ...query, page, limit });
  }

  async stats(userId: string): Promise<NfeStats> {
    return this.repo.getStats(userId);
  }

  async exportData(
    userId: string,
    filters: { status?: string; dataInicio?: string; dataFim?: string },
    format: "xlsx" | "pdf",
  ): Promise<Buffer> {
    const rows = await this.repo.findAllForExport(userId, filters);

    if (format === "xlsx") {
      return this.buildXlsx(rows);
    }
    return this.buildPdfExport(rows);
  }

  /**
   * Relatório mensal consolidado em XML (read-only): notas AUTORIZADAS do mês
   * de competência (dataEmissao) com o nfeProc de cada uma embutido verbatim.
   * A montagem do XML vive em buildRelatorioMensalXml (pura); aqui só a
   * janela do mês, a busca e a leitura dos arquivos.
   */
  async relatorioMensalXml(
    userId: string,
    ano: number,
    mes: number,
    // Multi-CNPJ: emitente do relatório. Ausente ⇒ CNPJ padrão. O cabeçalho e
    // as notas são SEMPRE do mesmo emitente (nota de outro CNPJ do tenant
    // nunca entra carimbada com o CNPJ errado). Tenant de 1 CNPJ: mesmo
    // conjunto de notas de antes (config única + notas legadas NULL).
    companyId?: string | null,
  ): Promise<{ xml: string; quantidade: number }> {
    // 00:00 de Brasília = 03:00 UTC (offset fixo -03:00, sem horário de verão
    // desde 2019 — mesma convenção do dhEmi gravado na emissão).
    const inicio = new Date(Date.UTC(ano, mes - 1, 1, 3, 0, 0));
    const fim = new Date(Date.UTC(ano, mes, 1, 3, 0, 0));

    const config = companyId
      ? await this.configRepo.findByIdForUser(companyId, userId)
      : await this.configRepo.findByUserId(userId).catch(() => null);
    if (companyId && !config) {
      throw new Error("Emitente selecionado não encontrado");
    }

    const rows = await this.repo.findAuthorizedByEmissionMonth(
      userId,
      inicio,
      fim,
      config
        ? {
            companyFiscalConfigId: config.id,
            // Notas da era 1-CNPJ (NULL) pertencem ao padrão do tenant.
            includeLegacyNull: companyId ? (config.isDefault ?? true) : true,
          }
        : undefined,
    );
    const emitSnapshot = (rows[0]?.emitenteJson ?? {}) as any;
    const emitente = {
      cnpj: config?.cnpj ?? emitSnapshot.cnpj ?? "",
      razaoSocial: config?.razaoSocial ?? emitSnapshot.razaoSocial ?? "",
    };

    const notas: RelatorioNota[] = [];
    for (const r of rows) {
      const dest = r.destinatarioJson as any;
      const totais = r.totaisJson as any;

      let xmlAutorizado: string | null = null;
      if (r.xmlAutorizadoPath) {
        const buf = await this.storage.readFile(r.xmlAutorizadoPath);
        xmlAutorizado = buf ? buf.toString("utf8") : null;
      }
      if (!xmlAutorizado) {
        console.warn(
          "[relatorio-mensal] XML autorizado indisponivel em disco — nota entra no resumo com xmlIndisponivel",
          { nfeId: r.id, numero: r.numero, path: r.xmlAutorizadoPath ?? null },
        );
      }

      notas.push({
        numero: r.numero,
        serie: r.serie,
        chaveAcesso: r.chaveAcesso,
        status: r.status,
        dataEmissao: r.dataEmissao,
        dataAutorizacao: r.dataAutorizacao,
        protocoloAutorizacao: r.protocoloAutorizacao,
        destinatarioNome: dest?.nome ?? "",
        destinatarioDocumento: dest?.cpfCnpj ?? "",
        valorTotal: Number(totais?.totalNota ?? 0),
        xmlAutorizado,
      });
    }

    const xml = buildRelatorioMensalXml({
      emitente,
      ano,
      mes,
      geradoEm: new Date(),
      notas,
    });
    return { xml, quantidade: notas.length };
  }

  private async buildXlsx(rows: any[]): Promise<Buffer> {
    const XLSX = await import("xlsx");

    const data = rows.map((r: any) => {
      const dest = r.destinatarioJson as any;
      const totais = r.totaisJson as any;
      return {
        Numero: r.numero,
        Serie: r.serie,
        "Chave de Acesso": r.chaveAcesso ?? "",
        Status: r.status,
        Ambiente: r.ambiente,
        "Tipo Operacao": r.tipoOperacao,
        "Natureza Operacao": r.naturezaOperacao,
        Destinatario: dest?.nome ?? "",
        "CPF/CNPJ": dest?.cpfCnpj ?? "",
        "Total Produtos": totais?.totalProdutos ?? 0,
        "Total ICMS": totais?.totalIcms ?? 0,
        "Total IPI": totais?.totalIpi ?? 0,
        "Total Nota": totais?.totalNota ?? 0,
        Protocolo: r.protocoloAutorizacao ?? "",
        "Data Emissao": r.dataEmissao
          ? new Date(r.dataEmissao).toLocaleDateString("pt-BR")
          : "",
        "Data Autorizacao": r.dataAutorizacao
          ? new Date(r.dataAutorizacao).toLocaleDateString("pt-BR")
          : "",
      };
    });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Notas Fiscais");
    return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  }

  private async buildPdfExport(rows: any[]): Promise<Buffer> {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 8;
    const lineHeight = 14;
    const margin = 40;

    let page = pdf.addPage([842, 595]); // A4 landscape
    let y = 555;

    // Title
    page.drawText("Notas Fiscais Emitidas", {
      x: margin,
      y,
      size: 14,
      font: fontBold,
      color: rgb(0, 0, 0),
    });
    y -= 24;

    // Header
    const cols = [
      { label: "Num", x: margin, w: 40 },
      { label: "Serie", x: 85, w: 30 },
      { label: "Status", x: 120, w: 70 },
      { label: "Destinatario", x: 195, w: 180 },
      { label: "CPF/CNPJ", x: 380, w: 100 },
      { label: "Total Nota", x: 485, w: 70 },
      { label: "Protocolo", x: 560, w: 120 },
      { label: "Data Emissao", x: 685, w: 80 },
    ];

    const drawHeader = () => {
      for (const col of cols) {
        page.drawText(col.label, {
          x: col.x,
          y,
          size: fontSize,
          font: fontBold,
          color: rgb(0.3, 0.3, 0.3),
        });
      }
      y -= lineHeight;
    };

    drawHeader();

    for (const r of rows) {
      if (y < margin + 20) {
        page = pdf.addPage([842, 595]);
        y = 555;
        drawHeader();
      }

      const dest = r.destinatarioJson as any;
      const totais = r.totaisJson as any;
      const values = [
        String(r.numero),
        String(r.serie),
        r.status,
        (dest?.nome ?? "").substring(0, 35),
        dest?.cpfCnpj ?? "",
        (totais?.totalNota ?? 0).toLocaleString("pt-BR", {
          minimumFractionDigits: 2,
        }),
        r.protocoloAutorizacao ?? "",
        r.dataEmissao
          ? new Date(r.dataEmissao).toLocaleDateString("pt-BR")
          : "",
      ];

      cols.forEach((col, i) => {
        page.drawText(values[i] ?? "", {
          x: col.x,
          y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      });
      y -= lineHeight;
    }

    const bytes = await pdf.save();
    return Buffer.from(bytes);
  }
}

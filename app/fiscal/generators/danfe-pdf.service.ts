import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type {
  NfeDraftResponse,
  NfeDraftItem,
  NfeDestinatario,
} from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeTotais } from "../domain/nfe.types";
import { parseNfeXml, type ParsedNfe } from "../sefaz/nfe-xml-parser.service";
import { renderDanfeV2, type DanfeAvatar } from "./danfe-v2-renderer";
import { composeInfCpl } from "../domain/inf-cpl";
import { toWinAnsiSafe, wrapTextLines, formatBRLNumber } from "./danfe-helpers";

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
  /**
   * Gera o DANFE. O layout redesenhado (blocos delimitados, colunas completas,
   * bloco de Cálculo do Imposto) fica atrás da flag NEXT_PUBLIC_DANFE_V2_ENABLED;
   * desligada, mantém o layout simplificado anterior (zero regressão).
   */
  async generate(
    nfe: NfeDraftResponse,
    config: CompanyFiscalConfig,
    chaveAcesso: string | null,
    protocolo: string | null,
    avatar?: DanfeAvatar | null,
  ): Promise<Uint8Array> {
    if (process.env.NEXT_PUBLIC_DANFE_V2_ENABLED === "true") {
      return this.generateV2(nfe, config, chaveAcesso, protocolo, avatar);
    }
    return this.generateLegacy(nfe, config, chaveAcesso, protocolo);
  }

  private async generateLegacy(
    nfe: NfeDraftResponse,
    config: CompanyFiscalConfig,
    chaveAcesso: string | null,
    protocolo: string | null,
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    // `page` e mutavel: o DANFE pagina quando os itens nao cabem (PAR-1).
    let page = doc.addPage([595.28, 841.89]); // A4
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
    drawText(
      "DANFE - Documento Auxiliar da Nota Fiscal Eletronica",
      margin,
      y,
      12,
      fontBold,
    );
    y -= 20;
    drawText("NF-e", margin, y, 10, fontBold);
    drawText(`Numero: ${nfe.numero}  Serie: ${nfe.serie}`, margin + 40, y, 10);
    y -= lineHeight;

    const ambienteLabel =
      nfe.ambiente === "HOMOLOGACAO"
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
    drawText(
      `CNPJ: ${this.formatCnpj(config.cnpj)}  IE: ${config.inscricaoEstadual}`,
      margin,
      y,
    );
    y -= lineHeight;
    const endEmit = [
      config.logradouro,
      config.numero,
      config.bairro,
      config.municipio,
      config.uf,
    ]
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
      const endDest = [
        dest.logradouro,
        dest.numero,
        dest.bairro,
        dest.municipio,
        dest.uf,
      ]
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
    const cols = [
      margin,
      margin + 30,
      margin + 230,
      margin + 290,
      margin + 350,
      margin + 420,
    ];
    const drawItensHeader = () => {
      drawText("#", cols[0], y, 7, fontBold, gray);
      drawText("Descricao", cols[1], y, 7, fontBold, gray);
      drawText("Qtd", cols[2], y, 7, fontBold, gray);
      drawText("Unit.", cols[3], y, 7, fontBold, gray);
      drawText("Total", cols[4], y, 7, fontBold, gray);
      drawText("NCM", cols[5], y, 7, fontBold, gray);
      y -= lineHeight;
    };
    drawItensHeader();

    // PAR-1: pagina o DANFE quando os itens nao cabem, em vez de descarta-los
    // silenciosamente. Reserva ~margin+80 da ultima pagina para os totais.
    for (const item of nfe.itens) {
      if (y < margin + 60) {
        page = doc.addPage([595.28, 841.89]);
        y = height - margin;
        drawText("PRODUTOS / SERVICOS (continuacao)", margin, y, 9, fontBold);
        y -= lineHeight;
        drawItensHeader();
      }

      const desc =
        item.descricao.length > 35
          ? item.descricao.substring(0, 35) + "..."
          : item.descricao;

      drawText(String(item.numero), cols[0], y, 7);
      drawText(desc, cols[1], y, 7);
      drawText(formatBRLNumber(Number(item.quantidade)), cols[2], y, 7);
      drawText(formatBRLNumber(Number(item.valorUnitario)), cols[3], y, 7);
      drawText(formatBRLNumber(Number(item.valorTotal)), cols[4], y, 7);
      drawText(item.ncm, cols[5], y, 7);
      y -= lineHeight;
    }

    // Garante espaco para os totais; se nao couber, nova pagina.
    if (y < margin + 70) {
      page = doc.addPage([595.28, 841.89]);
      y = height - margin;
    }

    y -= 4;
    drawLine(y);
    y -= lineHeight;

    // ── Totais ──
    const totais = (nfe.totaisJson ?? {}) as NfeTotais;
    drawText("TOTAIS", margin, y, 9, fontBold);
    y -= lineHeight;
    drawText(
      `Total Produtos: R$ ${formatBRLNumber(totais.totalProdutos ?? 0)}`,
      margin,
      y,
      8,
    );
    drawText(
      `Desconto: R$ ${formatBRLNumber(totais.totalDesconto ?? 0)}`,
      margin + 200,
      y,
      8,
    );
    y -= lineHeight;
    drawText(`ICMS: R$ ${formatBRLNumber(totais.totalIcms ?? 0)}`, margin, y, 8);
    drawText(
      `PIS: R$ ${formatBRLNumber(totais.totalPis ?? 0)}`,
      margin + 150,
      y,
      8,
    );
    drawText(
      `COFINS: R$ ${formatBRLNumber(totais.totalCofins ?? 0)}`,
      margin + 300,
      y,
      8,
    );
    y -= lineHeight;
    drawText(
      `TOTAL DA NOTA: R$ ${formatBRLNumber(totais.totalNota ?? 0)}`,
      margin,
      y,
      11,
      fontBold,
    );

    // ── Informações complementares (mesmo conteúdo do <infCpl> do XML) ──
    const infCpl = toWinAnsiSafe(composeInfCpl(nfe));
    if (infCpl) {
      y -= lineHeight;
      if (y < margin + 40) {
        page = doc.addPage([595.28, 841.89]);
        y = height - margin;
      }
      drawLine(y);
      y -= lineHeight;
      drawText("INFORMACOES COMPLEMENTARES", margin, y, 9, fontBold);
      y -= lineHeight;
      const infLines = wrapTextLines(infCpl, width - 2 * margin, (s) =>
        font.widthOfTextAtSize(s, 8),
      );
      for (const line of infLines) {
        if (y < margin) {
          page = doc.addPage([595.28, 841.89]);
          y = height - margin;
        }
        drawText(line, margin, y, 8);
        y -= 11;
      }
    }

    return doc.save();
  }

  /**
   * Layout redesenhado: blocos delimitados (Emitente, Chave, Destinatário,
   * Cálculo do Imposto), tabela de produtos com colunas completas
   * (Cód/Descrição/NCM/CST-CSOSN/CFOP/Un/Qtd/Vl Unit/Vl Total) e paginação
   * page-safe (grade redesenhada por linha, sem perder itens).
   */
  private async generateV2(
    nfe: NfeDraftResponse,
    config: CompanyFiscalConfig,
    chaveAcesso: string | null,
    protocolo: string | null,
    avatar?: DanfeAvatar | null,
  ): Promise<Uint8Array> {
    return renderDanfeV2({ nfe, config, chaveAcesso, protocolo, avatar });
  }

  private formatCnpj(cnpj: string): string {
    const d = cnpj.replace(/\D/g, "");
    if (d.length !== 14) return cnpj;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  /**
   * Gera DANFE a partir do XML autorizado (`<nfeProc>` ou `<NFe>` solto).
   *
   * Fonte primária para SEFAZ direto (após F-H), porque o XML autorizado é
   * o documento canônico imutável retornado pela SEFAZ. Para Focus NFe, o
   * use case ainda pode usar `generate(NfeEmitida, ...)` quando o XML não
   * está disponível em mão.
   *
   * Reutiliza o renderer existente — parseia o XML, projeta para os tipos
   * `NfeDraftResponse`-like e `CompanyFiscalConfig`-like e delega para
   * `generate()`. O resultado visual é idêntico.
   */
  async generateFromXml(
    xml: string,
    avatar?: DanfeAvatar | null,
  ): Promise<Uint8Array> {
    const parsed = parseNfeXml(xml);
    // PAR-4: DANFE so deve ser gerado para NF-e efetivamente AUTORIZADA. Se o
    // XML traz protNFe com cStat que NAO e autorizacao (100/150), recusamos —
    // gerar um "DANFE" de nota denegada (110) ou rejeitada induziria o operador
    // a tratar como valida. (XML sem protNFe = NFe assinada pre-envio: tambem
    // nao tem DANFE valido.)
    const cStat = parsed.protNFe?.cStat ?? null;
    if (cStat === null) {
      throw new Error(
        "DANFE exige XML autorizado (nfeProc com protNFe) — XML sem protocolo de autorizacao",
      );
    }
    if (cStat !== 100 && cStat !== 150) {
      throw new Error(
        `DANFE so pode ser gerado para NF-e autorizada (cStat 100/150). Recebido cStat=${cStat}: ${parsed.protNFe?.xMotivo ?? ""}`,
      );
    }
    const projected = projectParsedNfeToDraft(parsed);
    return this.generate(
      projected.draft,
      projected.config,
      parsed.chaveAcesso || projected.draft.chaveAcesso,
      parsed.protNFe?.nProt ?? null,
      avatar,
    );
  }
}

/**
 * Projeta o resultado do parser de XML em estruturas equivalentes às do
 * banco (NfeDraftResponse + CompanyFiscalConfig). Permite reaproveitar o
 * renderer atual sem refatorar a assinatura pública.
 *
 * Campos que existem só no DB e não no XML (orderId, customerId,
 * createdAt etc) ficam com defaults seguros — o renderer não os usa.
 */
export function projectParsedNfeToDraft(parsed: ParsedNfe): {
  draft: NfeDraftResponse;
  config: CompanyFiscalConfig;
} {
  const { ide, emit, dest, itens, total, transp, pag, protNFe } = parsed;

  const ambiente = ide.tpAmb === "1" ? "PRODUCAO" : "HOMOLOGACAO";

  const config: CompanyFiscalConfig = {
    id: "from-xml",
    userId: "from-xml",
    cnpj: emit.CNPJ ?? emit.CPF ?? "",
    razaoSocial: emit.xNome,
    nomeFantasia: emit.xFant,
    inscricaoEstadual: emit.IE,
    inscricaoMunicipal: emit.IM,
    // CRT: 1=Simples, 2=Simples Excesso, 4=MEI → todos sao "Simples" para o
    // nosso enum de regime; 3=Regime Normal → LUCRO_PRESUMIDO (default normal).
    regimeTributario:
      emit.CRT === "1" || emit.CRT === "2" || emit.CRT === "4"
        ? "SIMPLES"
        : "LUCRO_PRESUMIDO",
    cnae: emit.CNAE,
    ambiente,
    cep: emit.ender.CEP,
    logradouro: emit.ender.xLgr,
    numero: emit.ender.nro,
    complemento: emit.ender.xCpl,
    bairro: emit.ender.xBairro,
    municipio: emit.ender.xMun,
    codMunicipio: emit.ender.cMun,
    uf: emit.ender.UF,
    codPais: emit.ender.cPais,
    pais: emit.ender.xPais,
    certificadoPath: null,
    certificadoSenhaEnc: null,
    certificadoValidoAte: null,
    providerName: "SEFAZ_DIRECT",
    providerToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as CompanyFiscalConfig;

  const destinatario: NfeDestinatario = {
    tipoPessoa: dest.CPF ? "PF" : dest.idEstrangeiro ? "EXTERIOR" : "PJ",
    cpfCnpj: dest.CNPJ ?? dest.CPF ?? dest.idEstrangeiro ?? "",
    nome: dest.xNome,
    inscricaoEstadual: dest.IE,
    email: dest.email,
    telefone: dest.ender?.fone ?? null,
    cep: dest.ender?.CEP ?? null,
    logradouro: dest.ender?.xLgr ?? null,
    numero: dest.ender?.nro ?? null,
    complemento: dest.ender?.xCpl ?? null,
    bairro: dest.ender?.xBairro ?? null,
    municipio: dest.ender?.xMun ?? null,
    codMunicipio: dest.ender?.cMun ?? null,
    uf: dest.ender?.UF ?? null,
    codPais: dest.ender?.cPais ?? null,
    pais: dest.ender?.xPais ?? null,
  };

  const draftItens: NfeDraftItem[] = itens.map((it) => ({
    productId: null,
    numero: it.nItem,
    codigo: it.cProd,
    descricao: it.xProd,
    ncm: it.NCM,
    cfop: it.CFOP,
    cest: it.CEST,
    origem: 0,
    unidade: it.uCom,
    quantidade: it.qCom,
    valorUnitario: it.vUnCom,
    valorTotal: it.vProd,
    desconto: it.vDesc > 0 ? it.vDesc : null,
    observacoes: null,
    cstIcms: null,
    cstPis: null,
    cstCofins: null,
    aliquotaIcms: null,
    aliquotaIpi: null,
    aliquotaPis: null,
    aliquotaCofins: null,
    reducaoBcIcms: null,
    tributosJson: null,
  }));

  const totais: NfeTotais = {
    totalProdutos: total.vProd,
    totalDesconto: total.vDesc,
    totalBcIcms: total.vBC,
    totalIcms: total.vICMS,
    totalBcIpi: 0,
    totalIpi: total.vIPI,
    totalPis: total.vPIS,
    totalCofins: total.vCOFINS,
    totalNota: total.vNF,
    totalTributos: total.vICMS + total.vIPI + total.vPIS + total.vCOFINS,
  };

  const draft: NfeDraftResponse = {
    id: "from-xml",
    userId: "from-xml",
    orderId: null,
    customerId: null,
    ambiente,
    modelo: ide.mod,
    serie: ide.serie,
    numero: ide.nNF,
    chaveAcesso: parsed.chaveAcesso,
    tipoOperacao: ide.tpNF === "1" ? "SAIDA" : "ENTRADA",
    finalidade: "NORMAL",
    destinoOperacao: "INTERNA",
    naturezaOperacao: ide.natOp,
    indPresenca: "PRESENCIAL",
    intermediador: null,
    numeroPedido: null,
    // O infCpl do XML já vem composto (observações + "Pedido: N"); entra
    // inteiro aqui e composeInfCpl o devolve como está (numeroPedido: null).
    informacoesComplementares: parsed.infCpl,
    dataEmissao: ide.dhEmi ? new Date(ide.dhEmi) : null,
    dataSaida: ide.dhSaiEnt ? new Date(ide.dhSaiEnt) : null,
    destinatarioJson: destinatario,
    emitenteJson: null,
    modalidadeFrete: mapModFreteToDomain(transp?.modFrete ?? "9"),
    transportadoraJson: transp?.transporta ?? null,
    totaisJson: totais,
    notasReferenciadasJson: null,
    exportacaoJson: null,
    pagamentosJson: pag.length > 0 ? pag : null,
    duplicatasJson: null,
    volumesJson: null,
    status: protNFe ? "AUTHORIZED" : "DRAFT",
    createdAt: new Date(),
    updatedAt: new Date(),
    itens: draftItens,
  };

  return { draft, config };
}

function mapModFreteToDomain(cod: string): string | null {
  switch (cod) {
    case "0":
      return "CIF";
    case "1":
      return "FOB";
    case "2":
      return "TERCEIROS";
    case "3":
      return "PROPRIO_REMETENTE";
    case "4":
      return "PROPRIO_DESTINATARIO";
    case "9":
      return "SEM_FRETE";
    default:
      return null;
  }
}

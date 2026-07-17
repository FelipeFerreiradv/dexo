import prisma from "../lib/prisma";
import { normalizeSku } from "../lib/sku";
import { isCodeLikeQuery } from "./product-search-terms";
import { lookupCStat } from "../fiscal/sefaz/cstat-mapper";
import { isNfeReemissaoRejeitadaEnabled } from "../fiscal/domain/nfe-number-reuse";
import type {
  NfeDraftCreateInput,
  NfeDraftUpdateInput,
  NfeDraftResponse,
  NfeDraftItem,
  CustomerLookup,
  ProductLookup,
  NfeListQuery,
  NfeListItem,
  NfeListResponse,
  NfeStats,
} from "../interfaces/nfe.interface";

function toDraftResponse(row: any): NfeDraftResponse {
  return {
    id: row.id,
    userId: row.userId,
    orderId: row.orderId,
    customerId: row.customerId,
    ambiente: row.ambiente,
    modelo: row.modelo,
    serie: row.serie,
    numero: row.numero,
    chaveAcesso: row.chaveAcesso,
    tipoOperacao: row.tipoOperacao,
    finalidade: row.finalidade,
    destinoOperacao: row.destinoOperacao,
    naturezaOperacao: row.naturezaOperacao,
    indPresenca: row.indPresenca,
    intermediador: row.intermediador,
    numeroPedido: row.numeroPedido,
    informacoesComplementares: row.informacoesComplementares,
    dataEmissao: row.dataEmissao,
    dataSaida: row.dataSaida,
    destinatarioJson: row.destinatarioJson as any,
    emitenteJson: row.emitenteJson as any,
    modalidadeFrete: row.modalidadeFrete,
    transportadoraJson: row.transportadoraJson as any,
    totaisJson: row.totaisJson as any,
    notasReferenciadasJson: row.notasReferenciadasJson as any,
    exportacaoJson: row.exportacaoJson as any,
    pagamentosJson: row.pagamentosJson as any,
    duplicatasJson: row.duplicatasJson as any,
    volumesJson: row.volumesJson as any,
    status: row.status,
    motivoRejeicao: row.motivoRejeicao ?? null,
    cStatRejeicao: row.cStatRejeicao ?? null,
    reaproveitavel:
      row.cStatRejeicao != null &&
      lookupCStat(row.cStatRejeicao).categoria === "rejeitada",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    itens: (row.itens ?? []).map((item: any) => ({
      id: item.id,
      productId: item.productId,
      numero: item.numero,
      codigo: item.codigo,
      descricao: item.descricao,
      ncm: item.ncm,
      cfop: item.cfop,
      cest: item.cest,
      origem: item.origem,
      unidade: item.unidade,
      quantidade: Number(item.quantidade),
      valorUnitario: Number(item.valorUnitario),
      valorTotal: Number(item.valorTotal),
      desconto: item.desconto != null ? Number(item.desconto) : null,
      observacoes: item.observacoes,
      tributosJson: item.tributosJson as any,
    })),
  };
}

/**
 * NF-e HISTÓRICA (importação de dados legados): registro de nota JÁ emitida
 * no sistema antigo do cliente. Nunca nasce DRAFT, nunca passa pela SEFAZ e
 * não mexe em NfeSequence (o import ajusta a sequência à parte, via
 * NfeSequenceService.ajustarProximoNumero — que só avança).
 */
export interface NfeHistoricCreate {
  userId: string;
  ambiente: string; // "PRODUCAO" | "HOMOLOGACAO"
  serie: number;
  numero: number;
  chaveAcesso?: string | null;
  tipoOperacao: string;
  finalidade: string;
  destinoOperacao: string;
  naturezaOperacao: string;
  indPresenca: string;
  informacoesComplementares?: string | null;
  dataEmissao?: Date | null;
  dataAutorizacao?: Date | null;
  /** Shape lido por nfe-listing: { nome, cpfCnpj }. */
  destinatarioJson: Record<string, unknown>;
  emitenteJson?: Record<string, unknown> | null;
  /** Shape lido por nfe-listing: { totalNota, totalProdutos, totalIcms… }. */
  totaisJson: Record<string, unknown>;
  /** AUTHORIZED | CANCELLED | INUTILIZED | REJECTED (derivado da origem). */
  status: string;
}

/**
 * Mapeia um item de rascunho para o payload de create do NfeItem. Extraido para
 * ser reutilizado por updateDraft (edicao do usuario) e persistCalculo
 * (persistencia dos tributos calculados na emissao) — mesma forma, para os dois
 * caminhos nunca divergirem.
 */
function buildNfeItemCreateData(
  nfeId: string,
  item: NfeDraftItem,
  idx: number,
) {
  return {
    nfeId,
    productId: item.productId ?? null,
    numero: item.numero ?? idx + 1,
    codigo: item.codigo,
    descricao: item.descricao,
    ncm: item.ncm,
    cfop: item.cfop,
    cest: item.cest ?? null,
    origem: item.origem,
    unidade: item.unidade,
    quantidade: item.quantidade,
    valorUnitario: item.valorUnitario,
    valorTotal: item.valorTotal,
    desconto: item.desconto ?? null,
    observacoes: item.observacoes ?? null,
    tributosJson: item.tributosJson ?? null,
  };
}

export class NfeRepository {
  /**
   * Cria o registro histórico (ver NfeHistoricCreate). Caminho SEPARADO do
   * createDraft de propósito — o pipeline de emissão real fica intocado. A
   * unicidade fica com o banco: chaveAcesso @unique e
   * @@unique([userId, ambiente, serie, numero]) (P2002 = já importada).
   */
  async createHistoric(data: NfeHistoricCreate): Promise<{ id: string }> {
    const row = await (prisma as any).nfeEmitida.create({
      data: {
        userId: data.userId,
        ambiente: data.ambiente,
        modelo: "55",
        serie: data.serie,
        numero: data.numero,
        chaveAcesso: data.chaveAcesso ?? null,
        tipoOperacao: data.tipoOperacao,
        finalidade: data.finalidade,
        destinoOperacao: data.destinoOperacao,
        naturezaOperacao: data.naturezaOperacao,
        indPresenca: data.indPresenca,
        informacoesComplementares: data.informacoesComplementares ?? null,
        dataEmissao: data.dataEmissao ?? null,
        dataAutorizacao: data.dataAutorizacao ?? null,
        destinatarioJson: data.destinatarioJson as any,
        emitenteJson: (data.emitenteJson as any) ?? null,
        totaisJson: data.totaisJson as any,
        status: data.status,
        emittedByUserId: data.userId,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  async findExistingDraft(userId: string): Promise<NfeDraftResponse | null> {
    const row = await (prisma as any).nfeEmitida.findFirst({
      where: { userId, status: "DRAFT" },
      orderBy: { updatedAt: "desc" },
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    return row ? toDraftResponse(row) : null;
  }

  async createDraft(
    userId: string,
    input: NfeDraftCreateInput,
  ): Promise<NfeDraftResponse> {
    // Count existing drafts to generate a unique placeholder numero
    const draftCount = await (prisma as any).nfeEmitida.count({
      where: { userId, status: "DRAFT" },
    });

    const row = await (prisma as any).nfeEmitida.create({
      data: {
        userId,
        orderId: input.orderId ?? null,
        customerId: input.customerId ?? null,
        ambiente: input.ambiente ?? "HOMOLOGACAO",
        // NFC-e (Fase 2): ausente ⇒ "55" (fluxo atual intacto).
        modelo: input.modelo ?? "55",
        serie: input.serie ?? 1,
        numero: -(draftCount + 1), // placeholder negativo, será atribuído na emissão
        tipoOperacao: "SAIDA",
        finalidade: "NORMAL",
        destinoOperacao: "INTERNA",
        naturezaOperacao: "VENDA DE MERCADORIA",
        indPresenca: "NAO_SE_APLICA",
        destinatarioJson: {},
        status: "DRAFT",
        emittedByUserId: userId,
      },
      include: { itens: true },
    });
    return toDraftResponse(row);
  }

  /**
   * NFC-e (Fase 2) — idempotência do 1 clique do PDV: localiza a nota mais
   * recente de um modelo vinculada a um numeroPedido (link textual
   * "receivable:<id>"), ignorando CANCELLED. Seleção enxuta (egress).
   */
  async findByNumeroPedidoAndModelo(
    userId: string,
    numeroPedido: string,
    modelo: "55" | "65",
  ): Promise<{
    id: string;
    status: string;
    numero: number;
    serie: number;
    chaveAcesso: string | null;
    danfePdfPath: string | null;
    motivoRejeicao: string | null;
  } | null> {
    const row = await (prisma as any).nfeEmitida.findFirst({
      where: {
        userId,
        numeroPedido,
        modelo,
        status: { not: "CANCELLED" },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        numero: true,
        serie: true,
        chaveAcesso: true,
        danfePdfPath: true,
        motivoRejeicao: true,
      },
    });
    return row ?? null;
  }

  async findDraftById(
    userId: string,
    id: string,
  ): Promise<NfeDraftResponse | null> {
    // Aceita DRAFT e REJECTED: uma nota REJEITADA pela SEFAZ pode ser reaberta,
    // corrigida e reemitida. Sem REJECTED, o wizard dava "Rascunho nao
    // encontrado" ao voltar etapas apos uma rejeicao.
    const row = await (prisma as any).nfeEmitida.findFirst({
      where: { id, userId, status: { in: ["DRAFT", "REJECTED"] } },
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    return row ? toDraftResponse(row) : null;
  }

  async updateDraft(
    userId: string,
    id: string,
    input: NfeDraftUpdateInput,
  ): Promise<NfeDraftResponse> {
    // Build update data — only set fields that were provided. A guarda atomica
    // abaixo (updateMany condicional a userId + status) substitui a antiga
    // pre-checagem de posse: uma linha de outro tenant nunca casa o where.
    const data: Record<string, any> = {};

    if (input.serie !== undefined) data.serie = input.serie;
    if (input.tipoOperacao !== undefined)
      data.tipoOperacao = input.tipoOperacao;
    if (input.finalidade !== undefined) data.finalidade = input.finalidade;
    if (input.destinoOperacao !== undefined)
      data.destinoOperacao = input.destinoOperacao;
    if (input.naturezaOperacao !== undefined)
      data.naturezaOperacao = input.naturezaOperacao;
    if (input.indPresenca !== undefined) data.indPresenca = input.indPresenca;
    if (input.intermediador !== undefined)
      data.intermediador = input.intermediador;
    if (input.numeroPedido !== undefined)
      data.numeroPedido = input.numeroPedido;
    if (input.informacoesComplementares !== undefined)
      data.informacoesComplementares = input.informacoesComplementares;
    if (input.dataEmissao !== undefined)
      data.dataEmissao = input.dataEmissao ? new Date(input.dataEmissao) : null;
    if (input.dataSaida !== undefined)
      data.dataSaida = input.dataSaida ? new Date(input.dataSaida) : null;
    if (input.destinatarioJson !== undefined)
      data.destinatarioJson = input.destinatarioJson ?? {};
    if (input.customerId !== undefined) data.customerId = input.customerId;
    if (input.modalidadeFrete !== undefined)
      data.modalidadeFrete = input.modalidadeFrete;
    if (input.transportadoraJson !== undefined)
      data.transportadoraJson = input.transportadoraJson;
    if (input.volumesJson !== undefined) data.volumesJson = input.volumesJson;
    if (input.duplicatasJson !== undefined)
      data.duplicatasJson = input.duplicatasJson;
    if (input.pagamentosJson !== undefined)
      data.pagamentosJson = input.pagamentosJson;
    if (input.totaisJson !== undefined) data.totaisJson = input.totaisJson;
    if (input.notasReferenciadasJson !== undefined)
      data.notasReferenciadasJson = input.notasReferenciadasJson;
    if (input.exportacaoJson !== undefined)
      data.exportacaoJson = input.exportacaoJson;

    // Editar reabre como DRAFT e limpa a rejeicao anterior.
    data.status = "DRAFT";
    data.motivoRejeicao = null;

    // GUARDA ATOMICA (anti-corrida do BUG "nota autorizada some da listagem"):
    // a escrita SO acontece quando o status atual e DRAFT ou REJECTED. Um
    // autosave atrasado que aterrisse DEPOIS de a emissao ter reivindicado a
    // nota (VALIDATING/SIGNING/SENDING) ou autorizado (AUTHORIZED) e um NO-OP
    // SILENCIOSO: nao rebaixa o status para DRAFT nem troca os itens (o front ja
    // trata saveDraft como best-effort silencioso). A emissao NAO passa mais por
    // aqui para persistir totais — usa persistCalculo (que preserva o status),
    // senao esta guarda bloquearia a propria emissao.
    const buildResponse = async (db: any): Promise<NfeDraftResponse> => {
      const row = await db.nfeEmitida.findFirst({
        where: { id },
        include: { itens: { orderBy: { numero: "asc" } } },
      });
      return toDraftResponse(row);
    };
    const noopOrThrow = async (db: any): Promise<NfeDraftResponse> => {
      const current = await db.nfeEmitida.findFirst({
        where: { id, userId },
        include: { itens: { orderBy: { numero: "asc" } } },
      });
      if (!current) throw new Error("Rascunho de NF-e não encontrado");
      return toDraftResponse(current);
    };

    // PERF/EGRESS: sem troca de itens (a maioria dos autosaves de step do wizard
    // NAO manda `itens`), o updateMany condicional ao status JA e atomico como
    // statement unico — evitamos a $transaction interativa (BEGIN/COMMIT segura
    // conexao do pool). So abrimos transacao quando ha itens a trocar, pois ai a
    // guarda + delete/create precisam ser atomicos juntos. Reduz retencao de
    // conexao no caminho quente (ver incidente do pooler Supabase).
    if (input.itens === undefined) {
      const claim = await (prisma as any).nfeEmitida.updateMany({
        where: { id, userId, status: { in: ["DRAFT", "REJECTED"] } },
        data,
      });
      if (claim.count === 0) return noopOrThrow(prisma);
      return buildResponse(prisma);
    }

    // Com troca de itens: guarda + swap na MESMA transacao/pre-condicao, para um
    // save atrasado nunca apagar/recriar itens de uma nota ja emitida. Captura
    // `itens` num const (ja narrowed p/ NfeDraftItem[] apos o early-return) — o
    // TS re-alarga input.itens dentro da closure async.
    const itens = input.itens;
    return await (prisma as any).$transaction(async (tx: any) => {
      const claim = await tx.nfeEmitida.updateMany({
        where: { id, userId, status: { in: ["DRAFT", "REJECTED"] } },
        data,
      });
      if (claim.count === 0) return noopOrThrow(tx);

      await tx.nfeItem.deleteMany({ where: { nfeId: id } });
      if (itens.length > 0) {
        await tx.nfeItem.createMany({
          data: itens.map((item: NfeDraftItem, idx: number) =>
            buildNfeItemCreateData(id, item, idx),
          ),
        });
      }
      return buildResponse(tx);
    });
  }

  /**
   * Persiste os totais e os tributos calculados dos itens DURANTE a emissao,
   * SEM tocar em status/motivoRejeicao. Diferente de updateDraft (que forca
   * DRAFT e agora e guardado a DRAFT/REJECTED), este metodo preserva o status
   * atual — a essa altura a nota ja esta em VALIDATING, reivindicada pela
   * emissao. Por isso a emissao NAO pode usar updateDraft aqui: a guarda de
   * status bloquearia a propria emissao. Ver NfeEmissionUseCase.emit.
   */
  async persistCalculo(
    nfeId: string,
    input: { totaisJson: any; itens?: NfeDraftItem[] },
  ): Promise<void> {
    await (prisma as any).$transaction(async (tx: any) => {
      // select:{id} — o retorno e descartado (metodo void), entao nao ha por que
      // trafegar de volta as ~9 colunas JSONB do snapshot da nota (R1 egress).
      await tx.nfeEmitida.update({
        where: { id: nfeId },
        data: { totaisJson: input.totaisJson },
        select: { id: true },
      });
      if (input.itens !== undefined) {
        await tx.nfeItem.deleteMany({ where: { nfeId } });
        if (input.itens.length > 0) {
          await tx.nfeItem.createMany({
            data: input.itens.map((item, idx) =>
              buildNfeItemCreateData(nfeId, item, idx),
            ),
          });
        }
      }
    });
  }

  async deleteDraft(userId: string, id: string): Promise<void> {
    // SEGURANÇA (multi-tenant): só apaga se o rascunho for do próprio userId.
    // Antes o `where` usava só `id` => deleção cross-tenant por id.
    const owned = await (prisma as any).nfeEmitida.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) throw new Error("Rascunho de NF-e não encontrado");
    // Items cascade via onDelete: Cascade
    await (prisma as any).nfeEmitida.delete({
      where: { id },
    });
  }

  async addAuditLog(
    nfeId: string,
    userId: string,
    evento: string,
    detalhes?: any,
  ): Promise<void> {
    await (prisma as any).nfeAuditLog.create({
      data: {
        nfeId,
        userId,
        evento,
        detalhes: detalhes ?? null,
      },
    });
  }

  // ── Lookups ──

  async lookupCustomers(
    userId: string,
    query: string,
  ): Promise<CustomerLookup[]> {
    const q = `%${query}%`;
    const rows = await (prisma as any).customer.findMany({
      where: {
        userId,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { razaoSocial: { contains: query, mode: "insensitive" } },
          { cpf: { contains: query } },
          { cnpj: { contains: query } },
          { deliveryCnpj: { contains: query } },
          { email: { contains: query, mode: "insensitive" } },
        ],
      },
      take: 20,
      orderBy: { name: "asc" },
      select: {
        id: true,
        personType: true,
        name: true,
        cpf: true,
        cnpj: true,
        razaoSocial: true,
        nomeFantasia: true,
        inscricaoEstadual: true,
        indicadorIE: true,
        email: true,
        phone: true,
        mobile: true,
        deliveryCnpj: true,
        deliveryCorporateName: true,
        cep: true,
        street: true,
        number: true,
        complement: true,
        neighborhood: true,
        city: true,
        state: true,
        ibge: true,
      },
    });
    return rows;
  }

  async lookupProducts(
    userId: string,
    query: string,
  ): Promise<ProductLookup[]> {
    const trimmed = (query ?? "").trim();
    // Precisão de SKU/código (alinhado ao BLOCO 2): quando a query "parece um
    // código" (numérica "043" ou alfanumérica "ABC-1"), casamos por IGUALDADE
    // (skuNormalized / sku / partNumber) — não por `contains`, que trazia
    // produtos não-relacionados ("208" casando "1208"/"2089"). Buscas
    // descritivas ("mola", "filtro de óleo") seguem com `contains` em
    // name/sku/partNumber, preservando o recall do picker do balcão/orçamento.
    const norm = normalizeSku(trimmed);
    const where = isCodeLikeQuery(trimmed)
      ? {
          userId,
          OR: [
            ...(norm
              ? [{ skuNormalized: norm }, { partNumberNormalized: norm }]
              : []),
            { sku: { equals: trimmed, mode: "insensitive" } },
            { partNumber: { equals: trimmed, mode: "insensitive" } },
          ],
        }
      : {
          userId,
          OR: [
            { name: { contains: trimmed, mode: "insensitive" } },
            { sku: { contains: trimmed, mode: "insensitive" } },
            { partNumber: { contains: trimmed, mode: "insensitive" } },
          ],
        };

    const rows = await (prisma as any).product.findMany({
      where,
      take: 20,
      orderBy: { name: "asc" },
      select: {
        id: true,
        sku: true,
        name: true,
        price: true,
        stock: true,
        // Aditivo: sucata de origem (id p/ vínculo + rótulo p/ exibição no balcão).
        scrapId: true,
        scrap: {
          select: { brand: true, model: true, year: true, plate: true },
        },
      },
    });
    return rows.map((r: any) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      price: Number(r.price),
      stock: r.stock,
      scrapId: r.scrapId ?? null,
      scrapLabel: r.scrap
        ? [
            `${r.scrap.brand} ${r.scrap.model}`.trim(),
            r.scrap.year || null,
            r.scrap.plate || null,
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
    }));
  }

  // ── Listagem de notas emitidas (F6) ──

  async findEmitted(
    userId: string,
    query: NfeListQuery,
  ): Promise<NfeListResponse> {
    const where: any = {
      userId,
      status: { not: "DRAFT" },
    };

    if (query.status) {
      where.status = query.status;
    }
    if (query.serie !== undefined) {
      where.serie = query.serie;
    }
    if (query.ambiente) {
      where.ambiente = query.ambiente;
    }
    if (query.dataInicio || query.dataFim) {
      where.createdAt = {};
      if (query.dataInicio) where.createdAt.gte = new Date(query.dataInicio);
      if (query.dataFim)
        where.createdAt.lte = new Date(query.dataFim + "T23:59:59.999Z");
    }
    if (query.search && query.search.trim().length >= 2) {
      const term = query.search.trim();
      where.OR = [
        { chaveAcesso: { contains: term } },
        { naturezaOperacao: { contains: term, mode: "insensitive" } },
        { protocoloAutorizacao: { contains: term } },
        { numero: isNaN(Number(term)) ? undefined : Number(term) },
      ].filter(Boolean);
      // Also search destinatario name inside JSON — fallback via raw text match
      // Prisma doesn't support JSON field search well, so we add a path-based filter
    }

    const reemissaoEnabled = isNfeReemissaoRejeitadaEnabled();

    const [rows, total] = await Promise.all([
      (prisma as any).nfeEmitida.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        // Notas emitidas em ordem de numeração decrescente (nº maior primeiro).
        // Drafts são excluídos no where (status != DRAFT), então todo nº é real.
        orderBy: { numero: "desc" },
        select: {
          id: true,
          orderId: true,
          ambiente: true,
          modelo: true,
          serie: true,
          numero: true,
          chaveAcesso: true,
          tipoOperacao: true,
          finalidade: true,
          naturezaOperacao: true,
          destinatarioJson: true,
          totaisJson: true,
          status: true,
          protocoloAutorizacao: true,
          dataEmissao: true,
          dataAutorizacao: true,
          createdAt: true,
          xmlAutorizadoPath: true,
          xmlOriginalPath: true,
          danfePdfPath: true,
          // So seleciona a coluna nova quando a feature esta ligada — com a flag
          // OFF o app roda sem depender da migration (coluna pode nao existir).
          ...(reemissaoEnabled ? { cStatRejeicao: true } : {}),
        },
      }),
      (prisma as any).nfeEmitida.count({ where }),
    ]);

    const notas: NfeListItem[] = rows.map((r: any) => {
      const dest = r.destinatarioJson as any;
      const totais = r.totaisJson as any;
      return {
        id: r.id,
        orderId: r.orderId,
        ambiente: r.ambiente,
        modelo: r.modelo,
        serie: r.serie,
        numero: r.numero,
        chaveAcesso: r.chaveAcesso,
        tipoOperacao: r.tipoOperacao,
        finalidade: r.finalidade,
        naturezaOperacao: r.naturezaOperacao,
        destinatarioNome: dest?.nome ?? "",
        destinatarioCpfCnpj: dest?.cpfCnpj ?? "",
        totalNota: totais?.totalNota ?? 0,
        status: r.status,
        protocoloAutorizacao: r.protocoloAutorizacao,
        dataEmissao: r.dataEmissao?.toISOString() ?? null,
        dataAutorizacao: r.dataAutorizacao?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        hasXml: !!(r.xmlAutorizadoPath || r.xmlOriginalPath),
        hasDanfe: !!r.danfePdfPath,
        // Elegivel ao "Tentar novamente": rejeicao reaproveitavel (numero nao
        // consumido). Sempre false com a flag off. NAO expoe o texto do motivo.
        reaproveitavel:
          reemissaoEnabled &&
          r.status === "REJECTED" &&
          r.cStatRejeicao != null &&
          lookupCStat(r.cStatRejeicao).categoria === "rejeitada",
      };
    });

    return {
      notas,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getStats(userId: string): Promise<NfeStats> {
    // Single groupBy replaces 4 count() queries — Postgres resolves it from the
    // (userId, status) composite index in one pass.
    const [groups, sumRows] = await Promise.all([
      (prisma as any).nfeEmitida.groupBy({
        by: ["status"],
        where: { userId, status: { not: "DRAFT" } },
        _count: { _all: true },
      }),
      // EGRESS: soma o totalNota no Postgres em vez de puxar 1 linha por nota
      // autorizada só para reduzir em JS. totaisJson é JSONB — extrai e soma
      // direto (COALESCE p/ 0 quando não há notas). Usa o índice [userId,status].
      prisma.$queryRaw<Array<{ valorTotal: number }>>`
        SELECT COALESCE(SUM(("totaisJson"->>'totalNota')::numeric), 0)::float8 AS "valorTotal"
        FROM "NfeEmitida"
        WHERE "userId" = ${userId} AND "status" = 'AUTHORIZED'
      `,
    ]);

    let total = 0;
    let autorizadas = 0;
    let rejeitadas = 0;
    let canceladas = 0;
    for (const g of groups as Array<{
      status: string;
      _count: { _all: number };
    }>) {
      const count = g._count._all;
      total += count;
      if (g.status === "AUTHORIZED") autorizadas = count;
      else if (g.status === "REJECTED") rejeitadas = count;
      else if (g.status === "CANCELLED") canceladas = count;
    }

    const valorTotal = Number(sumRows[0]?.valorTotal ?? 0);

    return { total, autorizadas, rejeitadas, canceladas, valorTotal };
  }

  async findAllForExport(
    userId: string,
    filters: { status?: string; dataInicio?: string; dataFim?: string },
  ): Promise<any[]> {
    const where: any = { userId, status: { not: "DRAFT" } };
    if (filters.status) where.status = filters.status;
    if (filters.dataInicio || filters.dataFim) {
      where.createdAt = {};
      if (filters.dataInicio)
        where.createdAt.gte = new Date(filters.dataInicio);
      if (filters.dataFim)
        where.createdAt.lte = new Date(filters.dataFim + "T23:59:59.999Z");
    }

    // EGRESS: o export (XLSX/PDF em nfe-listing.usecase) lê só estes campos —
    // nunca `itens`. Select mínimo evita puxar os demais blocos JSON e os itens,
    // cortando o payload pesado da exportação.
    return (prisma as any).nfeEmitida.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        numero: true,
        serie: true,
        chaveAcesso: true,
        status: true,
        ambiente: true,
        tipoOperacao: true,
        naturezaOperacao: true,
        destinatarioJson: true,
        totaisJson: true,
        protocoloAutorizacao: true,
        dataEmissao: true,
        dataAutorizacao: true,
      },
    });
  }

  /**
   * Notas AUTORIZADAS do mês de competência fiscal, para o relatório mensal
   * XML. Diferente de findAllForExport (que filtra por createdAt e serve o
   * /nfe/export existente — intocado), aqui a janela é por dataEmissao:
   * intervalo semiaberto [inicio, fim) calculado pelo usecase em horário de
   * Brasília. Usa o índice (userId, dataEmissao).
   */
  async findAuthorizedByEmissionMonth(
    userId: string,
    inicio: Date,
    fim: Date,
  ): Promise<any[]> {
    return (prisma as any).nfeEmitida.findMany({
      where: {
        userId,
        status: "AUTHORIZED",
        dataEmissao: { gte: inicio, lt: fim },
      },
      orderBy: { numero: "asc" },
      select: {
        id: true,
        numero: true,
        serie: true,
        chaveAcesso: true,
        status: true,
        destinatarioJson: true,
        emitenteJson: true,
        totaisJson: true,
        protocoloAutorizacao: true,
        dataEmissao: true,
        dataAutorizacao: true,
        xmlAutorizadoPath: true,
      },
    });
  }

  /**
   * NF-e AUTORIZADA de um pedido — para o módulo de Etiqueta de Envio. ADITIVO:
   * não altera `findEmitted` (listagem da tela F6). Escopo multi-tenant por
   * `userId`. Quando `ambiente` é informado, filtra PRODUCAO/HOMOLOGACAO — o
   * módulo de etiqueta exige PRODUCAO. Retorna a autorizada mais recente.
   */
  async findAuthorizedByOrderId(
    userId: string,
    orderId: string,
    ambiente?: "PRODUCAO" | "HOMOLOGACAO",
  ): Promise<{
    id: string;
    chaveAcesso: string | null;
    xmlAutorizadoPath: string | null;
    ambiente: string;
    modelo: string;
    status: string;
  } | null> {
    const row = await (prisma as any).nfeEmitida.findFirst({
      where: {
        userId,
        orderId,
        status: "AUTHORIZED",
        ...(ambiente ? { ambiente } : {}),
      },
      orderBy: { dataAutorizacao: "desc" },
      select: {
        id: true,
        chaveAcesso: true,
        xmlAutorizadoPath: true,
        ambiente: true,
        modelo: true,
        status: true,
      },
    });
    return row ?? null;
  }
}

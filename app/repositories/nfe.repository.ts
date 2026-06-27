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

export class NfeRepository {
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
        modelo: "55",
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
    // SEGURANÇA (multi-tenant): garante que o rascunho pertence ao userId antes
    // de qualquer escrita. Antes o `where` usava só `id` => qualquer usuário
    // podia editar a NF-e de outro tenant conhecendo o id.
    const owned = await (prisma as any).nfeEmitida.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) throw new Error("Rascunho de NF-e não encontrado");

    // Build update data — only set fields that were provided
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

    // Handle items — replace strategy: delete all then re-create
    if (input.itens !== undefined) {
      await (prisma as any).nfeItem.deleteMany({ where: { nfeId: id } });

      if (input.itens.length > 0) {
        await (prisma as any).nfeItem.createMany({
          data: input.itens.map((item: NfeDraftItem, idx: number) => ({
            nfeId: id,
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
          })),
        });
      }
    }

    // Editar reabre como DRAFT e limpa a rejeicao anterior. Como este metodo
    // so e alcancado via findDraftById (DRAFT|REJECTED), e seguro/idempotente:
    // numa nota ja DRAFT nao muda nada; numa REJECTED, reabre para reemissao.
    data.status = "DRAFT";
    data.motivoRejeicao = null;

    const row = await (prisma as any).nfeEmitida.update({
      where: { id },
      data,
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    return toDraftResponse(row);
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
            ...(norm ? [{ skuNormalized: norm }] : []),
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
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          orderId: true,
          ambiente: true,
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

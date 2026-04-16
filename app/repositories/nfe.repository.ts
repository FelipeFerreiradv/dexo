import prisma from "../lib/prisma";
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
  async createDraft(
    userId: string,
    input: NfeDraftCreateInput,
  ): Promise<NfeDraftResponse> {
    const row = await (prisma as any).nfeEmitida.create({
      data: {
        userId,
        orderId: input.orderId ?? null,
        customerId: input.customerId ?? null,
        ambiente: "HOMOLOGACAO",
        modelo: "55",
        serie: 1,
        numero: 0, // será atribuído na emissão
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
    const row = await (prisma as any).nfeEmitida.findFirst({
      where: { id, userId, status: "DRAFT" },
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    return row ? toDraftResponse(row) : null;
  }

  async updateDraft(
    userId: string,
    id: string,
    input: NfeDraftUpdateInput,
  ): Promise<NfeDraftResponse> {
    // Build update data — only set fields that were provided
    const data: Record<string, any> = {};

    if (input.serie !== undefined) data.serie = input.serie;
    if (input.tipoOperacao !== undefined) data.tipoOperacao = input.tipoOperacao;
    if (input.finalidade !== undefined) data.finalidade = input.finalidade;
    if (input.destinoOperacao !== undefined)
      data.destinoOperacao = input.destinoOperacao;
    if (input.naturezaOperacao !== undefined)
      data.naturezaOperacao = input.naturezaOperacao;
    if (input.indPresenca !== undefined) data.indPresenca = input.indPresenca;
    if (input.intermediador !== undefined)
      data.intermediador = input.intermediador;
    if (input.numeroPedido !== undefined) data.numeroPedido = input.numeroPedido;
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

    const row = await (prisma as any).nfeEmitida.update({
      where: { id },
      data,
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    return toDraftResponse(row);
  }

  async deleteDraft(userId: string, id: string): Promise<void> {
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
          { cpf: { contains: query } },
          { deliveryCnpj: { contains: query } },
          { email: { contains: query, mode: "insensitive" } },
        ],
      },
      take: 20,
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        cpf: true,
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
    const rows = await (prisma as any).product.findMany({
      where: {
        userId,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { sku: { contains: query, mode: "insensitive" } },
          { partNumber: { contains: query, mode: "insensitive" } },
        ],
      },
      take: 20,
      orderBy: { name: "asc" },
      select: {
        id: true,
        sku: true,
        name: true,
        price: true,
        stock: true,
      },
    });
    return rows.map((r: any) => ({
      ...r,
      price: Number(r.price),
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
      if (query.dataFim) where.createdAt.lte = new Date(query.dataFim + "T23:59:59.999Z");
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
    const baseWhere = { userId, status: { not: "DRAFT" } };

    const [total, autorizadas, rejeitadas, canceladas, allAuthorized] =
      await Promise.all([
        (prisma as any).nfeEmitida.count({ where: baseWhere }),
        (prisma as any).nfeEmitida.count({
          where: { userId, status: "AUTHORIZED" },
        }),
        (prisma as any).nfeEmitida.count({
          where: { userId, status: "REJECTED" },
        }),
        (prisma as any).nfeEmitida.count({
          where: { userId, status: "CANCELLED" },
        }),
        (prisma as any).nfeEmitida.findMany({
          where: { userId, status: "AUTHORIZED" },
          select: { totaisJson: true },
        }),
      ]);

    const valorTotal = allAuthorized.reduce((sum: number, r: any) => {
      const totais = r.totaisJson as any;
      return sum + (totais?.totalNota ?? 0);
    }, 0);

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
      if (filters.dataInicio) where.createdAt.gte = new Date(filters.dataInicio);
      if (filters.dataFim) where.createdAt.lte = new Date(filters.dataFim + "T23:59:59.999Z");
    }

    return (prisma as any).nfeEmitida.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { itens: { orderBy: { numero: "asc" } } },
    });
  }
}

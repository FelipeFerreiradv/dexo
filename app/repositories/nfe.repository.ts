import prisma from "../lib/prisma";
import type {
  NfeDraftCreateInput,
  NfeDraftUpdateInput,
  NfeDraftResponse,
  NfeDraftItem,
  CustomerLookup,
  ProductLookup,
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
}

import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  Budget,
  BudgetCancelOptions,
  BudgetCreate,
  BudgetListFilters,
  BudgetListResult,
  BudgetStage,
  BudgetUpdate,
} from "../interfaces/budget.interface";

function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Mesma filosofia do finance: `items` é undefined quando não incluído
// (preserva listagens egress-light) e array quando incluído.
function toEntry(raw: any): Budget {
  return {
    id: raw.id,
    userId: raw.userId,
    customerId: raw.customerId,
    vendedorId: raw.vendedorId ?? null,
    document: raw.document ?? null,
    reason: raw.reason ?? null,
    notes: raw.notes ?? null,
    totalAmount: Number(raw.totalAmount),
    status: raw.status,
    validUntil: raw.validUntil ?? null,
    pipelineStage: raw.pipelineStage ?? null,
    lostReason: raw.lostReason ?? null,
    receivableId: raw.receivable?.id ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    customer: raw.customer
      ? {
          id: raw.customer.id,
          name: raw.customer.name,
          cpf: raw.customer.cpf,
          email: raw.customer.email,
        }
      : null,
    unidade: raw.unidade
      ? { id: raw.unidade.id, name: raw.unidade.name }
      : null,
    vendedor: raw.vendedor
      ? {
          id: raw.vendedor.id,
          name: raw.vendedor.name ?? null,
          email: raw.vendedor.email,
        }
      : null,
    items: Array.isArray(raw.items)
      ? raw.items.map((i: any) => ({
          id: i.id,
          productId: i.productId ?? null,
          description: i.description ?? null,
          scrapId: i.scrapId ?? null,
          listingId: i.listingId ?? null,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
          createdAt: i.createdAt,
          product: i.product
            ? { id: i.product.id, sku: i.product.sku, name: i.product.name }
            : null,
        }))
      : undefined,
  };
}

// Itens com produto (sem JOIN de Scrap — egress, igual ao finance).
const itemsInclude = {
  orderBy: { createdAt: "asc" as const },
  include: { product: { select: { id: true, sku: true, name: true } } },
};

function buildInclude(withItems: boolean): any {
  const include: any = {
    customer: { select: { id: true, name: true, cpf: true, email: true } },
    unidade: { select: { id: true, name: true } },
    vendedor: { select: { id: true, name: true, email: true } },
    receivable: { select: { id: true } },
  };
  if (withItems) include.items = itemsInclude;
  return include;
}

export class BudgetRepository {
  async create(
    data: BudgetCreate,
    tx?: Prisma.TransactionClient,
  ): Promise<Budget> {
    const wantsItems = Array.isArray(data.items) && data.items.length > 0;
    if (!wantsItems) {
      return this.createSingle(data, tx);
    }
    if (tx) {
      return this.createWithItems(data, tx);
    }
    return prisma.$transaction((txClient) =>
      this.createWithItems(data, txClient),
    );
  }

  private async createSingle(
    data: BudgetCreate,
    tx?: Prisma.TransactionClient,
  ): Promise<Budget> {
    const db: any = tx ?? prisma;
    const created = await db.budget.create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        vendedorId: data.vendedorId ?? null,
        document: data.document ?? null,
        reason: data.reason ?? null,
        notes: data.notes ?? null,
        totalAmount: data.totalAmount,
        validUntil: parseDate(data.validUntil ?? null),
        status: "ABERTO",
      },
      include: buildInclude(false),
    });
    return toEntry(created);
  }

  private async createWithItems(
    data: BudgetCreate,
    tx: Prisma.TransactionClient,
  ): Promise<Budget> {
    const created = await (tx as any).budget.create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        vendedorId: data.vendedorId ?? null,
        document: data.document ?? null,
        reason: data.reason ?? null,
        notes: data.notes ?? null,
        totalAmount: data.totalAmount,
        validUntil: parseDate(data.validUntil ?? null),
        status: "ABERTO",
      },
      select: { id: true },
    });

    await (tx as any).budgetItem.createMany({
      data: data.items!.map((it) => ({
        budgetId: created.id,
        productId: it.productId ?? null,
        description: it.description ?? null,
        scrapId: it.scrapId ?? null,
        listingId: it.listingId ?? null,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
      })),
    });

    const full = await (tx as any).budget.findUnique({
      where: { id: created.id },
      include: buildInclude(true),
    });
    return toEntry(full);
  }

  async update(
    id: string,
    userId: string,
    data: BudgetUpdate,
    tx?: Prisma.TransactionClient,
  ): Promise<Budget> {
    const hasItemsField = "items" in data && data.items !== undefined;
    if (!hasItemsField) {
      return this.updateSingle(id, userId, data, tx);
    }
    if (tx) {
      return this.updateWithItems(id, userId, data, tx);
    }
    return prisma.$transaction((txClient) =>
      this.updateWithItems(id, userId, data, txClient),
    );
  }

  private async updateSingle(
    id: string,
    userId: string,
    data: BudgetUpdate,
    tx?: Prisma.TransactionClient,
  ): Promise<Budget> {
    const db: any = tx ?? prisma;
    const payload: any = { ...data };
    delete payload.items;
    delete payload.userId;
    delete payload.newCustomer;
    if ("validUntil" in payload)
      payload.validUntil = parseDate(payload.validUntil);

    const res = await db.budget.updateMany({
      where: { id, userId },
      data: payload,
    });
    if (res.count === 0) throw new Error("Orçamento não encontrado");

    const updated = await db.budget.findUnique({
      where: { id },
      include: buildInclude(false),
    });
    return toEntry(updated);
  }

  private async updateWithItems(
    id: string,
    userId: string,
    data: BudgetUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<Budget> {
    const items = data.items ?? [];
    const otherFields: any = { ...data };
    delete otherFields.items;
    delete otherFields.userId;
    delete otherFields.newCustomer;
    if ("validUntil" in otherFields)
      otherFields.validUntil = parseDate(otherFields.validUntil);

    const res = await (tx as any).budget.updateMany({
      where: { id, userId },
      data: otherFields,
    });
    if (res.count === 0) throw new Error("Orçamento não encontrado");

    // Replace strategy (igual ao finance): apaga e recria os itens.
    await (tx as any).budgetItem.deleteMany({ where: { budgetId: id } });
    if (items.length > 0) {
      await (tx as any).budgetItem.createMany({
        data: items.map((it) => ({
          budgetId: id,
          productId: it.productId ?? null,
          description: it.description ?? null,
          scrapId: it.scrapId ?? null,
          listingId: it.listingId ?? null,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
      });
    }

    const updated = await (tx as any).budget.findUnique({
      where: { id },
      include: buildInclude(true),
    });
    return toEntry(updated);
  }

  async findById(id: string, userId: string): Promise<Budget | null> {
    const res = await prisma.budget.findFirst({
      where: { id, userId },
      include: buildInclude(true),
    });
    return res ? toEntry(res) : null;
  }

  async findAll(
    filters: BudgetListFilters,
    userId: string,
  ): Promise<BudgetListResult> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.unidadeId) {
      where.unidadeId =
        filters.unidadeId === "sem_unidade" ? null : filters.unidadeId;
    }
    if (filters.vendedorId) {
      where.vendedorId =
        filters.vendedorId === "sem_vendedor" ? null : filters.vendedorId;
    }
    // EXPIRADO é derivado (não persistido): mapeia para ABERTO + validUntil
    // vencido. Os demais status são persistidos e filtram direto.
    if (filters.status === "EXPIRADO") {
      where.status = "ABERTO";
      where.validUntil = { lt: new Date() };
    } else if (filters.status) {
      where.status = filters.status;
    }
    // Filtro por estágio de funil (CRM). Aditivo/opcional.
    if (filters.pipelineStage) where.pipelineStage = filters.pipelineStage;
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }
    if (filters.search) {
      const term = filters.search.trim();
      where.OR = [
        { document: { contains: term, mode: "insensitive" } },
        { reason: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
        { customer: { name: { contains: term, mode: "insensitive" } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.budget.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          userId: true,
          customerId: true,
          unidadeId: true,
          vendedorId: true,
          document: true,
          reason: true,
          notes: true,
          totalAmount: true,
          status: true,
          validUntil: true,
          pipelineStage: true,
          lostReason: true,
          createdAt: true,
          updatedAt: true,
          customer: {
            select: { id: true, name: true, cpf: true, email: true },
          },
          unidade: { select: { id: true, name: true } },
          vendedor: { select: { id: true, name: true, email: true } },
          receivable: { select: { id: true } },
        },
      }),
      prisma.budget.count({ where }),
    ]);

    return {
      items: rows.map(toEntry),
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Cancela (status → CANCELADO). Bloqueado se já CONVERTIDO (preserva o
  // histórico/vínculo). Idempotente para ABERTO/EXPIRADO/CANCELADO.
  //
  // ADITIVO (CRM): opts?.pipelineStage carimba o sub-estágio do funil
  // ("CANCELADO" default ou "PERDIDO") + lostReason opcional. Sem opts =
  // comportamento de hoje + default "CANCELADO" (invisível ao Financeiro, que
  // não lê pipelineStage; a coluna Cancelado deriva igual).
  async cancel(
    id: string,
    userId: string,
    opts?: BudgetCancelOptions,
  ): Promise<Budget> {
    const stage: BudgetStage = opts?.pipelineStage ?? "CANCELADO";
    const data: any = { status: "CANCELADO", pipelineStage: stage };
    if (opts && "lostReason" in opts) data.lostReason = opts.lostReason ?? null;

    const res = await prisma.budget.updateMany({
      where: { id, userId, status: { not: "CONVERTIDO" } },
      data,
    });
    if (res.count === 0) {
      const exists = await prisma.budget.findFirst({
        where: { id, userId },
        select: { status: true },
      });
      if (!exists) throw new Error("Orçamento não encontrado");
      throw new Error("Orçamento convertido não pode ser cancelado");
    }
    const updated = await this.findById(id, userId);
    return updated!;
  }

  // Move o orçamento entre estágios ABERTOS do funil (Novo/Em negociação/
  // Proposta enviada) — só atualiza pipelineStage, SEM efeito financeiro.
  // Guarda atômica: só ABERTO (persistido) muda de estágio; CONVERTIDO/CANCELADO
  // → 409. EXPIRADO é ABERTO por baixo, então é aceito. A validação do valor de
  // `stage` (aberto) fica no usecase.
  async setStage(
    id: string,
    userId: string,
    stage: BudgetStage,
  ): Promise<Budget> {
    const res = await prisma.budget.updateMany({
      where: { id, userId, status: "ABERTO" },
      data: { pipelineStage: stage },
    });
    if (res.count === 0) {
      const exists = await prisma.budget.findFirst({
        where: { id, userId },
        select: { status: true },
      });
      if (!exists) throw new Error("Orçamento não encontrado");
      throw new Error("Apenas orçamentos abertos podem mudar de estágio");
    }
    const updated = await this.findById(id, userId);
    return updated!;
  }

  // Contagem de orçamentos por cliente (indicador da tabela de Clientes).
  // Batelado: uma única groupBy p/ os IDs da página atual, escopado por userId.
  // `open` = status ABERTO persistido (inclui os que exibirão EXPIRADO).
  async countByCustomer(
    userId: string,
    ids: string[],
  ): Promise<Record<string, { total: number; open: number }>> {
    const out: Record<string, { total: number; open: number }> = {};
    for (const id of ids) out[id] = { total: 0, open: 0 };
    if (ids.length === 0) return out;

    const rows = await prisma.budget.groupBy({
      by: ["customerId", "status"],
      where: { userId, customerId: { in: ids } },
      _count: { _all: true },
    });
    for (const r of rows) {
      const bucket =
        out[r.customerId] ?? (out[r.customerId] = { total: 0, open: 0 });
      const n = r._count._all;
      bucket.total += n;
      if (r.status === "ABERTO") bucket.open += n;
    }
    return out;
  }

  // Hard-delete (cascade dos itens). Bloqueado se CONVERTIDO (mantém o vínculo
  // com a venda como histórico). Use cancel() para descartar um orçamento ativo.
  async delete(id: string, userId: string): Promise<void> {
    const target = await prisma.budget.findFirst({
      where: { id, userId },
      select: { status: true },
    });
    if (!target) throw new Error("Orçamento não encontrado");
    if (target.status === "CONVERTIDO") {
      throw new Error("Orçamento convertido não pode ser excluído");
    }
    await prisma.budget.deleteMany({ where: { id, userId } });
  }
}

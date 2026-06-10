import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceStatus,
  FinanceSummary,
} from "../interfaces/finance.interface";

function model(kind: FinanceKind): any {
  return kind === "receivable"
    ? prisma.receivable
    : prisma.payable;
}

function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Itens só são incluídos no include de receivable (payable não tem relação).
// Quando incluído, `raw.items` é um array (possivelmente vazio); quando não
// incluído, é undefined — preserva-se no toEntry para não alterar payloads
// que historicamente não traziam itens.
function toEntry(raw: any): FinanceEntry {
  return {
    id: raw.id,
    userId: raw.userId,
    customerId: raw.customerId,
    document: raw.document,
    reason: raw.reason,
    debtDetails: raw.debtDetails,
    totalAmount: Number(raw.totalAmount),
    fineAmount: toNumberOrNull(raw.fineAmount),
    finePercent: toNumberOrNull(raw.finePercent),
    interestPercent: toNumberOrNull(raw.interestPercent),
    toleranceDays: raw.toleranceDays,
    installments: raw.installments,
    periodDays: raw.periodDays,
    dueDate: raw.dueDate,
    status: raw.status,
    paidAt: raw.paidAt,
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
      ? {
          id: raw.unidade.id,
          name: raw.unidade.name,
        }
      : null,
    items: Array.isArray(raw.items)
      ? raw.items.map((i: any) => ({
          id: i.id,
          productId: i.productId,
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

// Include de itens (somente receivable). Não-receivable ignora.
const itemsInclude = {
  orderBy: { createdAt: "asc" as const },
  include: { product: { select: { id: true, sku: true, name: true } } },
};

function buildInclude(kind: FinanceKind, withItems: boolean): any {
  const include: any = {
    customer: { select: { id: true, name: true, cpf: true, email: true } },
    unidade: { select: { id: true, name: true } },
  };
  if (withItems && kind === "receivable") include.items = itemsInclude;
  return include;
}

export class FinanceRepository {
  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const wantsItems =
      kind === "receivable" && Array.isArray(data.items) && data.items.length > 0;

    // Sem itens => caminho atual 100% inalterado (sem $transaction se o caller
    // também não passou tx; com tx se o caller forneceu — ex.: quick-create).
    if (!wantsItems) {
      return this.createSingle(kind, data, tx);
    }

    // Com itens => atomicidade obrigatória (Receivable + ReceivableItem na
    // MESMA transação). Se o caller já abriu tx (ex.: quick-create), reusa.
    if (tx) {
      return this.createWithItems(kind, data, tx);
    }
    return prisma.$transaction((txClient) =>
      this.createWithItems(kind, data, txClient),
    );
  }

  // Caminho histórico — preservado byte-idêntico ao da Fase 1.
  private async createSingle(
    kind: FinanceKind,
    data: FinanceEntryCreate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const db: Prisma.TransactionClient = tx ?? prisma;
    const delegate: any = kind === "receivable" ? db.receivable : db.payable;
    const created = await delegate.create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        document: data.document ?? null,
        reason: data.reason ?? null,
        debtDetails: data.debtDetails ?? null,
        totalAmount: data.totalAmount,
        fineAmount: data.fineAmount ?? null,
        finePercent: data.finePercent ?? null,
        interestPercent: data.interestPercent ?? null,
        toleranceDays: data.toleranceDays ?? null,
        installments: data.installments ?? 1,
        periodDays: data.periodDays ?? null,
        dueDate: parseDate(data.dueDate)!,
        status: (data.status as FinanceStatus) ?? "PENDENTE",
        paidAt: parseDate(data.paidAt ?? null),
      },
      include: {
        customer: { select: { id: true, name: true, cpf: true, email: true } },
        unidade: { select: { id: true, name: true } },
      },
    });
    return toEntry(created);
  }

  // Caminho com itens — só receivable, sempre dentro de uma tx (o create
  // wrapper garante isso). Cria Receivable + ReceivableItems e re-busca com
  // include de itens.
  private async createWithItems(
    kind: FinanceKind,
    data: FinanceEntryCreate,
    tx: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    if (kind !== "receivable") {
      // Defesa-em-profundidade — o usecase já bloqueia este caminho.
      throw new Error(
        "Itens inválidos: somente contas a receber aceitam itens",
      );
    }
    const delegate: any = (tx as any).receivable;
    const created = await delegate.create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        document: data.document ?? null,
        reason: data.reason ?? null,
        debtDetails: data.debtDetails ?? null,
        totalAmount: data.totalAmount,
        fineAmount: data.fineAmount ?? null,
        finePercent: data.finePercent ?? null,
        interestPercent: data.interestPercent ?? null,
        toleranceDays: data.toleranceDays ?? null,
        installments: data.installments ?? 1,
        periodDays: data.periodDays ?? null,
        dueDate: parseDate(data.dueDate)!,
        status: (data.status as FinanceStatus) ?? "PENDENTE",
        paidAt: parseDate(data.paidAt ?? null),
      },
      // Não incluímos itens aqui (acabamos de criar e vamos preencher na
      // próxima query); a 2ª query traz o include completo.
      select: { id: true },
    });

    await (tx as any).receivableItem.createMany({
      data: data.items!.map((it) => ({
        receivableId: created.id,
        productId: it.productId,
        listingId: it.listingId ?? null,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
      })),
    });

    const full = await (tx as any).receivable.findUnique({
      where: { id: created.id },
      include: buildInclude("receivable", true),
    });
    return toEntry(full);
  }

  async update(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    // `items` no payload significa "substituir lista de itens" (replace
    // strategy). Ausência (undefined) preserva itens existentes — fluxo atual
    // não-quebra.
    const hasItemsField = "items" in data && data.items !== undefined;

    if (!hasItemsField) {
      return this.updateSingle(kind, id, userId, data, tx);
    }
    if (kind !== "receivable") {
      throw new Error(
        "Itens inválidos: somente contas a receber aceitam itens",
      );
    }
    if (tx) {
      return this.updateWithItems(kind, id, userId, data, tx);
    }
    return prisma.$transaction((txClient) =>
      this.updateWithItems(kind, id, userId, data, txClient),
    );
  }

  // Caminho histórico — preservado byte-idêntico ao da Fase 1 (sem tx).
  private async updateSingle(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const db: any = tx ?? prisma;
    const delegate: any = kind === "receivable" ? db.receivable : db.payable;
    const payload: any = { ...data };
    delete payload.items; // defesa: nunca passar items pro update do delegate
    if ("dueDate" in payload) payload.dueDate = parseDate(payload.dueDate);
    if ("paidAt" in payload) payload.paidAt = parseDate(payload.paidAt);
    delete payload.userId;

    const res = await delegate.updateMany({
      where: { id, userId },
      data: payload,
    });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");

    const updated = await delegate.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, cpf: true, email: true } },
        unidade: { select: { id: true, name: true } },
      },
    });
    return toEntry(updated);
  }

  // Atualiza receivable + replace de itens — atomicidade obrigatória.
  private async updateWithItems(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const items = data.items ?? [];
    const otherFields: any = { ...data };
    delete otherFields.items;
    delete otherFields.userId;
    if ("dueDate" in otherFields)
      otherFields.dueDate = parseDate(otherFields.dueDate);
    if ("paidAt" in otherFields)
      otherFields.paidAt = parseDate(otherFields.paidAt);

    const res = await (tx as any).receivable.updateMany({
      where: { id, userId },
      data: otherFields,
    });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");

    // Replace strategy: apaga todos e re-cria. Igual ao padrão usado em
    // NfeRepository.updateDraft para itens de NFe.
    await (tx as any).receivableItem.deleteMany({ where: { receivableId: id } });
    if (items.length > 0) {
      await (tx as any).receivableItem.createMany({
        data: items.map((it) => ({
          receivableId: id,
          productId: it.productId,
          listingId: it.listingId ?? null,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
      });
    }

    const updated = await (tx as any).receivable.findUnique({
      where: { id },
      include: buildInclude("receivable", true),
    });
    return toEntry(updated);
  }

  async findById(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry | null> {
    // Receivable: traz items (uso pontual — pagamento, cupom, etc.).
    // Payable: items não se aplica (preserva payload atual).
    const res = await model(kind).findFirst({
      where: { id, userId },
      include: buildInclude(kind, true),
    });
    return res ? toEntry(res) : null;
  }

  // Busca apenas os itens de uma Receivable (ownership-aware via JOIN
  // implícito pelo `receivable.userId`). Útil para markPaid (Fase 6) sem
  // precisar carregar o entry inteiro.
  async findItems(
    receivableId: string,
    userId: string,
  ): Promise<NonNullable<FinanceEntry["items"]>> {
    const rows = await prisma.receivableItem.findMany({
      where: { receivableId, receivable: { userId } },
      orderBy: { createdAt: "asc" },
      include: { product: { select: { id: true, sku: true, name: true } } },
    });
    return rows.map((i: any) => ({
      id: i.id,
      productId: i.productId,
      listingId: i.listingId ?? null,
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
      createdAt: i.createdAt,
      product: i.product
        ? { id: i.product.id, sku: i.product.sku, name: i.product.name }
        : null,
    }));
  }

  async findAll(
    kind: FinanceKind,
    filters: FinanceListFilters,
    userId: string,
  ): Promise<FinanceListResult> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    // Filtro de unidade: ausente/"" => não filtra (resultado idêntico ao atual);
    // "sem_unidade" => contas sem unidade; outro valor => aquela unidade.
    if (filters.unidadeId) {
      where.unidadeId =
        filters.unidadeId === "sem_unidade" ? null : filters.unidadeId;
    }
    if (filters.from || filters.to) {
      where.dueDate = {};
      if (filters.from) where.dueDate.gte = new Date(filters.from);
      if (filters.to) where.dueDate.lte = new Date(filters.to);
    }
    if (filters.search) {
      const term = filters.search.trim();
      where.OR = [
        { document: { contains: term, mode: "insensitive" } },
        { reason: { contains: term, mode: "insensitive" } },
        { customer: { name: { contains: term, mode: "insensitive" } } },
      ];
    }

    const [rows, total] = await Promise.all([
      model(kind).findMany({
        where,
        skip,
        take: limit,
        orderBy: { dueDate: "asc" },
        select: {
          id: true,
          userId: true,
          customerId: true,
          unidadeId: true,
          document: true,
          reason: true,
          totalAmount: true,
          fineAmount: true,
          finePercent: true,
          interestPercent: true,
          toleranceDays: true,
          installments: true,
          periodDays: true,
          dueDate: true,
          status: true,
          paidAt: true,
          createdAt: true,
          updatedAt: true,
          customer: {
            select: { id: true, name: true, cpf: true, email: true },
          },
          unidade: {
            select: { id: true, name: true },
          },
        },
      }),
      model(kind).count({ where }),
    ]);

    return {
      items: rows.map(toEntry),
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async delete(kind: FinanceKind, id: string, userId: string): Promise<void> {
    const res = await model(kind).deleteMany({ where: { id, userId } });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");
  }

  async summary(userId: string, unidadeId?: string): Promise<FinanceSummary> {
    const now = new Date();

    // Sem filtro de unidade => objeto vazio => where idêntico ao comportamento
    // atual ({ userId } e { userId, status, dueDate }).
    const unidadeWhere: Record<string, unknown> =
      unidadeId === undefined || unidadeId === ""
        ? {}
        : { unidadeId: unidadeId === "sem_unidade" ? null : unidadeId };

    async function stats(m: any) {
      const [grouped, overdue] = await Promise.all([
        m.groupBy({
          by: ["status"],
          where: { userId, ...unidadeWhere },
          _sum: { totalAmount: true },
          _count: { _all: true },
        }),
        m.aggregate({
          where: {
            userId,
            ...unidadeWhere,
            status: { in: ["PENDENTE", "VENCIDA"] },
            dueDate: { lt: now },
          },
          _sum: { totalAmount: true },
          _count: true,
        }),
      ]);

      let totalCount = 0;
      let totalAmount = 0;
      let pendingAmount = 0;
      let paidAmount = 0;
      for (const g of grouped) {
        const count = g._count?._all ?? 0;
        const amount = Number(g._sum?.totalAmount ?? 0);
        totalCount += count;
        totalAmount += amount;
        if (g.status === "PENDENTE") pendingAmount += amount;
        if (g.status === "PAGA") paidAmount += amount;
      }

      return {
        totalCount,
        totalAmount,
        overdueCount: overdue._count ?? 0,
        overdueAmount: Number(overdue._sum?.totalAmount ?? 0),
        pendingAmount,
        paidAmount,
      };
    }

    const [receivables, payables] = await Promise.all([
      stats(prisma.receivable),
      stats(prisma.payable),
    ]);

    return { receivables, payables };
  }
}

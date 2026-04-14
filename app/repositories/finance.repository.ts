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
  };
}

export class FinanceRepository {
  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
  ): Promise<FinanceEntry> {
    const created = await model(kind).create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
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
      },
    });
    return toEntry(created);
  }

  async update(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
  ): Promise<FinanceEntry> {
    const payload: any = { ...data };
    if ("dueDate" in payload) payload.dueDate = parseDate(payload.dueDate);
    if ("paidAt" in payload) payload.paidAt = parseDate(payload.paidAt);
    delete payload.userId;

    const res = await model(kind).updateMany({
      where: { id, userId },
      data: payload,
    });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");

    const updated = await model(kind).findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, cpf: true, email: true } },
      },
    });
    return toEntry(updated);
  }

  async findById(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry | null> {
    const res = await model(kind).findFirst({
      where: { id, userId },
      include: {
        customer: { select: { id: true, name: true, cpf: true, email: true } },
      },
    });
    return res ? toEntry(res) : null;
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

  async summary(userId: string): Promise<FinanceSummary> {
    const now = new Date();

    async function stats(m: any) {
      const [grouped, overdue] = await Promise.all([
        m.groupBy({
          by: ["status"],
          where: { userId },
          _sum: { totalAmount: true },
          _count: { _all: true },
        }),
        m.aggregate({
          where: {
            userId,
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

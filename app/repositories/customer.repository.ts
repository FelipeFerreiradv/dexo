import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  Customer,
  CustomerCreate,
  CustomerListFilters,
  CustomerListResult,
  CustomerUpdate,
} from "../interfaces/customer.interface";

// Aceita o client global OU um client de transação ($transaction). Default =
// prisma global, então TODOS os callers atuais continuam idênticos.
type Db = Prisma.TransactionClient;

type PrismaCustomer = any;

function toCustomer(c: PrismaCustomer): Customer {
  return { ...c } as Customer;
}

function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function onlyDigits(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  return d.length > 0 ? d : null;
}

export class CustomerRepository {
  async create(data: CustomerCreate, tx?: Db): Promise<Customer> {
    const db: Db = tx ?? prisma;
    const created = await db.customer.create({
      data: {
        userId: data.userId,
        personType: data.personType ?? "PF",
        name: data.name,
        cpf: onlyDigits(data.cpf),
        rg: data.rg ?? null,
        birthDate: parseDate(data.birthDate),
        gender: data.gender ?? null,
        maritalStatus: data.maritalStatus ?? null,
        cnpj: onlyDigits(data.cnpj),
        razaoSocial: data.razaoSocial ?? null,
        nomeFantasia: data.nomeFantasia ?? null,
        inscricaoEstadual: data.inscricaoEstadual ?? null,
        indicadorIE: data.indicadorIE ?? null,
        email: data.email ?? null,
        phone: onlyDigits(data.phone),
        mobile: onlyDigits(data.mobile),
        cep: onlyDigits(data.cep),
        street: data.street ?? null,
        number: data.number ?? null,
        complement: data.complement ?? null,
        neighborhood: data.neighborhood ?? null,
        city: data.city ?? null,
        state: data.state ? data.state.toUpperCase() : null,
        ibge: data.ibge ?? null,
        reference: data.reference ?? null,
        deliveryName: data.deliveryName ?? null,
        deliveryCorporateName: data.deliveryCorporateName ?? null,
        deliveryCpf: onlyDigits(data.deliveryCpf),
        deliveryCnpj: onlyDigits(data.deliveryCnpj),
        deliveryRg: data.deliveryRg ?? null,
        deliveryCep: onlyDigits(data.deliveryCep),
        deliveryPhone: onlyDigits(data.deliveryPhone),
        deliveryCity: data.deliveryCity ?? null,
        deliveryNeighborhood: data.deliveryNeighborhood ?? null,
        deliveryState: data.deliveryState
          ? data.deliveryState.toUpperCase()
          : null,
        deliveryStreet: data.deliveryStreet ?? null,
        deliveryComplement: data.deliveryComplement ?? null,
        deliveryNumber: data.deliveryNumber ?? null,
        notes: data.notes ?? null,
      },
    });
    return toCustomer(created);
  }

  async update(
    id: string,
    userId: string,
    data: CustomerUpdate,
  ): Promise<Customer> {
    const updateData: any = { ...data };
    if ("cpf" in updateData) updateData.cpf = onlyDigits(updateData.cpf);
    if ("cnpj" in updateData) updateData.cnpj = onlyDigits(updateData.cnpj);
    if ("phone" in updateData) updateData.phone = onlyDigits(updateData.phone);
    if ("mobile" in updateData)
      updateData.mobile = onlyDigits(updateData.mobile);
    if ("cep" in updateData) updateData.cep = onlyDigits(updateData.cep);
    if ("deliveryCpf" in updateData)
      updateData.deliveryCpf = onlyDigits(updateData.deliveryCpf);
    if ("deliveryCnpj" in updateData)
      updateData.deliveryCnpj = onlyDigits(updateData.deliveryCnpj);
    if ("deliveryCep" in updateData)
      updateData.deliveryCep = onlyDigits(updateData.deliveryCep);
    if ("deliveryPhone" in updateData)
      updateData.deliveryPhone = onlyDigits(updateData.deliveryPhone);
    if ("birthDate" in updateData)
      updateData.birthDate = parseDate(updateData.birthDate);
    if (updateData.state)
      updateData.state = String(updateData.state).toUpperCase();
    if (updateData.deliveryState)
      updateData.deliveryState = String(updateData.deliveryState).toUpperCase();
    delete updateData.userId;

    const result = await prisma.customer.updateMany({
      where: { id, userId },
      data: updateData,
    });
    if (result.count === 0) {
      throw new Error("Cliente não encontrado");
    }
    const updated = await prisma.customer.findUnique({ where: { id } });
    return toCustomer(updated);
  }

  async findById(id: string, userId: string): Promise<Customer | null> {
    const result = await prisma.customer.findFirst({
      where: { id, userId },
    });
    return result ? toCustomer(result) : null;
  }

  async findByCpf(
    cpf: string,
    userId: string,
    tx?: Db,
  ): Promise<Customer | null> {
    const db: Db = tx ?? prisma;
    const clean = cpf.replace(/\D/g, "");
    if (!clean) return null;
    const result = await db.customer.findFirst({
      where: { userId, cpf: clean },
    });
    return result ? toCustomer(result) : null;
  }

  async findByCnpj(
    cnpj: string,
    userId: string,
    tx?: Db,
  ): Promise<Customer | null> {
    const db: Db = tx ?? prisma;
    const clean = cnpj.replace(/\D/g, "");
    if (!clean) return null;
    const result = await db.customer.findFirst({
      where: { userId, cnpj: clean },
    });
    return result ? toCustomer(result) : null;
  }

  /**
   * Busca por e-mail (exato, case-insensitive) dentro do dono. Usado para casar
   * o comprador de um pedido de marketplace a um Customer e autopreencher o
   * destinatário da NF-e. Retorna o mais antigo em caso de empate.
   */
  async findByEmail(
    email: string,
    userId: string,
    tx?: Db,
  ): Promise<Customer | null> {
    const db: Db = tx ?? prisma;
    const clean = email.trim();
    if (!clean) return null;
    const result = await db.customer.findFirst({
      where: { userId, email: { equals: clean, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });
    return result ? toCustomer(result) : null;
  }

  /**
   * Busca por nome (exato, case-insensitive) dentro do dono. Fallback fraco
   * quando o pedido não casa por e-mail. Retorna o mais antigo em caso de empate.
   */
  async findByName(
    name: string,
    userId: string,
    tx?: Db,
  ): Promise<Customer | null> {
    const db: Db = tx ?? prisma;
    const clean = name.trim();
    if (clean.length < 2) return null;
    const result = await db.customer.findFirst({
      where: { userId, name: { equals: clean, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });
    return result ? toCustomer(result) : null;
  }

  async findAll(
    filters: CustomerListFilters,
    userId: string,
  ): Promise<CustomerListResult> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (filters.search) {
      const term = filters.search.trim();
      const termDigits = term.replace(/\D/g, "");
      const or: any[] = [
        { name: { contains: term, mode: "insensitive" } },
        { razaoSocial: { contains: term, mode: "insensitive" } },
        { nomeFantasia: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ];
      if (termDigits.length > 0) {
        or.push({ cpf: { contains: termDigits } });
        or.push({ cnpj: { contains: termDigits } });
        or.push({ phone: { contains: termDigits } });
        or.push({ mobile: { contains: termDigits } });
      }
      where.OR = or;
    }

    if (filters.createdFrom) {
      where.createdAt = { gte: filters.createdFrom };
    }

    const [items, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        // EGRESS: a tabela só exibe estes campos. O modal de edição busca o
        // registro completo via GET /customers/:id (findById) ao abrir, então
        // a lista não precisa trafegar as ~46 colunas (endereço, delivery*,
        // datas etc.). Saída visível idêntica.
        select: {
          id: true,
          name: true,
          cpf: true,
          cnpj: true,
          email: true,
          phone: true,
          mobile: true,
          city: true,
          state: true,
        },
      }),
      prisma.customer.count({ where }),
    ]);

    return {
      customers: items.map(toCustomer),
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async search(q: string, userId: string, limit = 10): Promise<Customer[]> {
    const term = q.trim();
    if (term.length < 1) return [];
    const termDigits = term.replace(/\D/g, "");
    const or: any[] = [
      { name: { contains: term, mode: "insensitive" } },
      { razaoSocial: { contains: term, mode: "insensitive" } },
      { nomeFantasia: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
    ];
    if (termDigits.length > 0) {
      or.push({ cpf: { contains: termDigits } });
      or.push({ cnpj: { contains: termDigits } });
    }
    const items = await prisma.customer.findMany({
      where: { userId, OR: or },
      take: limit,
      orderBy: { name: "asc" },
    });
    return items.map(toCustomer);
  }

  async delete(id: string, userId: string): Promise<void> {
    const result = await prisma.customer.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) {
      throw new Error("Cliente não encontrado");
    }
  }
}

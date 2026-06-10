import prisma from "../lib/prisma";
import {
  Unidade,
  UnidadeCreate,
  UnidadeListResult,
  UnidadeUpdate,
} from "../interfaces/unidade.interface";

function toUnidade(u: any): Unidade {
  return { ...u } as Unidade;
}

export class UnidadeRepository {
  async create(data: UnidadeCreate): Promise<Unidade> {
    const created = await prisma.unidade.create({
      data: {
        userId: data.userId,
        name: data.name,
        code: data.code ?? null,
        notes: data.notes ?? null,
        active: data.active ?? true,
      },
    });
    return toUnidade(created);
  }

  async update(
    id: string,
    userId: string,
    data: UnidadeUpdate,
  ): Promise<Unidade> {
    const updateData: any = { ...data };
    delete updateData.userId;

    const result = await prisma.unidade.updateMany({
      where: { id, userId },
      data: updateData,
    });
    if (result.count === 0) {
      throw new Error("Unidade não encontrada");
    }
    const updated = await prisma.unidade.findUnique({ where: { id } });
    return toUnidade(updated);
  }

  async findById(id: string, userId: string): Promise<Unidade | null> {
    const result = await prisma.unidade.findFirst({ where: { id, userId } });
    return result ? toUnidade(result) : null;
  }

  async findByCode(code: string, userId: string): Promise<Unidade | null> {
    const result = await prisma.unidade.findFirst({ where: { userId, code } });
    return result ? toUnidade(result) : null;
  }

  async findAll(
    userId: string,
    includeInactive: boolean,
  ): Promise<UnidadeListResult> {
    const where: any = { userId };
    if (!includeInactive) where.active = true;

    const [items, total] = await Promise.all([
      prisma.unidade.findMany({ where, orderBy: { name: "asc" } }),
      prisma.unidade.count({ where }),
    ]);

    return { unidades: items.map(toUnidade), total };
  }
}

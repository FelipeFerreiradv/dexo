import {
  ProductCompatibility,
  ProductCompatibilityCreate,
  ProductCompatibilityRepository,
} from "../interfaces/compatibility.interface";
import prisma from "../lib/prisma";

function mapPrismaToCompatibility(item: any): ProductCompatibility {
  return {
    id: item.id,
    productId: item.productId,
    brand: item.brand,
    model: item.model,
    yearFrom: item.yearFrom,
    yearTo: item.yearTo,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Garante que o produto pertence ao tenant antes de qualquer operação de
 * compatibilidade. Lança se não pertencer (ou não existir) — fecha o IDOR.
 */
async function assertProductOwned(
  productId: string,
  userId: string,
): Promise<void> {
  const owned = await prisma.product.findFirst({
    where: { id: productId, userId },
    select: { id: true },
  });
  if (!owned) throw new Error("Produto não encontrado");
}

export class ProductCompatibilityRepositoryPrisma implements ProductCompatibilityRepository {
  async findByProductId(
    productId: string,
    userId: string,
  ): Promise<ProductCompatibility[]> {
    const items = await prisma.productCompatibility.findMany({
      where: { productId, product: { userId } },
      orderBy: { createdAt: "asc" },
    });
    return items.map(mapPrismaToCompatibility);
  }

  async create(
    productId: string,
    data: ProductCompatibilityCreate,
    userId: string,
  ): Promise<ProductCompatibility> {
    await assertProductOwned(productId, userId);
    const item = await prisma.productCompatibility.create({
      data: {
        productId,
        brand: data.brand,
        model: data.model,
        yearFrom: data.yearFrom ?? null,
        yearTo: data.yearTo ?? null,
        version: data.version ?? null,
      },
    });
    return mapPrismaToCompatibility(item);
  }

  async createMany(
    productId: string,
    data: ProductCompatibilityCreate[],
    userId: string,
  ): Promise<ProductCompatibility[]> {
    if (data.length === 0) return [];
    await assertProductOwned(productId, userId);

    const items = await prisma.productCompatibility.createManyAndReturn({
      data: data.map((d) => ({
        productId,
        brand: d.brand,
        model: d.model,
        yearFrom: d.yearFrom ?? null,
        yearTo: d.yearTo ?? null,
        version: d.version ?? null,
      })),
    });

    return items.map(mapPrismaToCompatibility);
  }

  async delete(id: string, userId: string): Promise<void> {
    // deleteMany com filtro pelo dono do produto: apaga 0 se for de outro
    // tenant (sem vazar existência) e a compat correta se for do usuário.
    await prisma.productCompatibility.deleteMany({
      where: { id, product: { userId } },
    });
  }

  async deleteByProductId(productId: string, userId: string): Promise<void> {
    await prisma.productCompatibility.deleteMany({
      where: { productId, product: { userId } },
    });
  }

  async replaceAll(
    productId: string,
    data: ProductCompatibilityCreate[],
    userId: string,
  ): Promise<ProductCompatibility[]> {
    await assertProductOwned(productId, userId);
    return prisma.$transaction(async (tx) => {
      await tx.productCompatibility.deleteMany({ where: { productId } });

      if (data.length === 0) return [];

      const items = await tx.productCompatibility.createManyAndReturn({
        data: data.map((d) => ({
          productId,
          brand: d.brand,
          model: d.model,
          yearFrom: d.yearFrom ?? null,
          yearTo: d.yearTo ?? null,
          version: d.version ?? null,
        })),
      });

      return items.map(mapPrismaToCompatibility);
    });
  }
}

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

export class ProductCompatibilityRepositoryPrisma implements ProductCompatibilityRepository {
  async findByProductId(productId: string): Promise<ProductCompatibility[]> {
    const items = await prisma.productCompatibility.findMany({
      where: { productId },
      orderBy: { createdAt: "asc" },
    });
    return items.map(mapPrismaToCompatibility);
  }

  async create(
    productId: string,
    data: ProductCompatibilityCreate,
  ): Promise<ProductCompatibility> {
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
  ): Promise<ProductCompatibility[]> {
    if (data.length === 0) return [];

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

  async delete(id: string): Promise<void> {
    await prisma.productCompatibility.delete({ where: { id } });
  }

  async deleteByProductId(productId: string): Promise<void> {
    await prisma.productCompatibility.deleteMany({ where: { productId } });
  }

  async replaceAll(
    productId: string,
    data: ProductCompatibilityCreate[],
  ): Promise<ProductCompatibility[]> {
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

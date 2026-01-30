import {
  Product,
  ProductCreate,
  ProductRepository,
} from "../interfaces/product.interface";
import prisma from "../lib/prisma";

class ProductRepositoryPrisma implements ProductRepository {
  async create(data: ProductCreate): Promise<Product> {
    try {
      const result = await prisma.product.create({
        data: {
          name: data.name,
          sku: data.sku,
          description: data.description ?? null,
          price: data.price,
          stock: data.stock,
        },
      });

      const product: Product = {
        id: result.id,
        sku: result.sku,
        name: result.name,
        description: result.description ?? undefined,
        stock: result.stock,
        price: result.price.toNumber(),
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };

      return product;
    } catch {
      throw new Error("Erro ao criar produto");
    }
  }

  async findBySku(sku: string): Promise<Product | null> {
    try {
      const data = await prisma.product.findMany({
        where: { sku },
      });
      const item = data[0];
      if (!item) return null;

      const product: Product = {
        id: item.id,
        sku: item.sku,
        name: item.name,
        description: item.description ?? undefined,
        stock: item.stock,
        price: item.price.toNumber(),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };

      return product;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }
}

export { ProductRepositoryPrisma };

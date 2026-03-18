import {
  Product,
  ProductCreate,
  ProductUpdate,
  ProductRepository,
  Quality,
} from "../interfaces/product.interface";
import prisma from "../lib/prisma";
import { Product as PrismaProduct } from "@prisma/client";

// Helper para converter Prisma Product para interface Product
function mapPrismaToProduct(item: PrismaProduct): Product {
  return {
    id: item.id,
    userId: item.userId ?? undefined,
    sku: item.sku,
    name: item.name,
    description: item.description ?? undefined,
    stock: item.stock,
    price: item.price.toNumber(),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    // Campos de autopeças
    costPrice: item.costPrice?.toNumber() ?? undefined,
    markup: item.markup?.toNumber() ?? undefined,
    brand: item.brand ?? undefined,
    model: item.model ?? undefined,
    year: item.year ?? undefined,
    version: item.version ?? undefined,
    category: item.category ?? undefined,
    location: item.location ?? undefined,
    partNumber: item.partNumber ?? undefined,
    quality: (item.quality as Quality) ?? undefined,
    isSecurityItem: item.isSecurityItem ?? undefined,
    isTraceable: item.isTraceable ?? undefined,
    sourceVehicle: item.sourceVehicle ?? undefined,
    mlCategoryId: item.mlCategoryId ?? undefined,
    mlCategorySource: (item as any).mlCategorySource ?? undefined,
    mlCategoryChosenAt: item.mlCategoryChosenAt ?? undefined,
    shopeeCategoryId: (item as any).shopeeCategoryId ?? undefined,
    shopeeCategorySource: (item as any).shopeeCategorySource ?? undefined,
    shopeeCategoryChosenAt: (item as any).shopeeCategoryChosenAt ?? undefined,

    // Medidas / peso
    heightCm: item.heightCm ?? undefined,
    widthCm: item.widthCm ?? undefined,
    lengthCm: item.lengthCm ?? undefined,
    weightKg: item.weightKg?.toNumber() ?? undefined,

    // Imagem do produto
    imageUrl: item.imageUrl ?? undefined,
  };
}

class ProductRepositoryPrisma implements ProductRepository {
  async create(data: ProductCreate): Promise<Product> {
    try {
      const result = await prisma.product.create({
        data: {
          userId: data.userId ?? null,
          name: data.name,
          sku: data.sku,
          description: data.description ?? null,
          price: data.price,
          stock: data.stock,
          // Campos de autopeças
          costPrice: data.costPrice ?? null,
          markup: data.markup ?? null,
          brand: data.brand ?? null,
          model: data.model ?? null,
          year: data.year ?? null,
          version: data.version ?? null,
          category: data.category ?? null,
          location: data.location ?? null,
          partNumber: data.partNumber ?? null,
          quality: data.quality ?? null,
          isSecurityItem: data.isSecurityItem ?? false,
          isTraceable: data.isTraceable ?? false,
          sourceVehicle: data.sourceVehicle ?? null,
          mlCategoryId: data.mlCategoryId ?? null,
          mlCategorySource: data.mlCategorySource ?? null,
          mlCategoryChosenAt: data.mlCategoryChosenAt ?? null,
          shopeeCategoryId: data.shopeeCategoryId ?? null,
          shopeeCategorySource: data.shopeeCategorySource ?? null,
          shopeeCategoryChosenAt: data.shopeeCategoryChosenAt ?? null,

          // Medidas / peso
          heightCm: data.heightCm ?? null,
          widthCm: data.widthCm ?? null,
          lengthCm: data.lengthCm ?? null,
          weightKg: data.weightKg ?? null,

          // Imagem do produto
          imageUrl: data.imageUrl,
        },
      });

      return mapPrismaToProduct(result);
    } catch (error: any) {
      console.error("Erro Prisma ao criar produto:", error);

      // Prisma unique constraint (sku) -> normalize message
      if (error?.code === "P2002" && error?.meta?.target?.includes("sku")) {
        throw new Error("Produto com esse sku já existe");
      }

      throw new Error(
        error instanceof Error ? error.message : "Erro ao criar produto",
      );
    }
  }

  async findBySku(sku: string, userId?: string): Promise<Product | null> {
    try {
      const data = await prisma.product.findMany({
        where: { sku, ...(userId ? { userId } : {}) },
      });
      const item = data[0];
      if (!item) return null;

      return mapPrismaToProduct(item);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findAll(
    options?: {
      search?: string;
      page?: number;
      limit?: number;
    },
    userId?: string,
  ): Promise<{ products: Product[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 10;
    const skip = (page - 1) * limit;
    const search = options?.search ?? "";

    const where: any = userId ? { userId } : {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" as const } },
        { sku: { contains: search, mode: "insensitive" as const } },
      ];
    }
    try {
      const [items, total] = await Promise.all([
        prisma.product.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        prisma.product.count({ where }),
      ]);

      const products: Product[] = items.map(mapPrismaToProduct);
      return { products, total };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async delete(id: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        const owner = await prisma.product.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Produto nÃ£o encontrado para este usuÃ¡rio");
      }
      // Verificar se o produto tem pedidos associados
      const orderItemsCount = await prisma.orderItem.count({
        where: { productId: id },
      });

      if (orderItemsCount > 0) {
        throw new Error(
          "Não é possível deletar o produto pois ele possui pedidos associados",
        );
      }

      // Deletar logs de estoque relacionados
      await prisma.stockLog.deleteMany({
        where: { productId: id },
      });

      // Deletar listings relacionados ao produto
      await prisma.productListing.deleteMany({
        where: { productId: id },
      });

      // Agora pode deletar o produto
      await prisma.product.delete({
        where: { id },
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findById(id: string, userId?: string): Promise<Product | null> {
    try {
      const item = await prisma.product.findFirst({
        where: { id, ...(userId ? { userId } : {}) },
      });

      if (!item) return null;

      return mapPrismaToProduct(item);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async update(
    id: string,
    data: ProductUpdate,
    userId?: string,
  ): Promise<Product> {
    try {
      if (userId) {
        const owner = await prisma.product.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Produto nÃ£o encontrado para este usuÃ¡rio");
      }
      const result = await prisma.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && {
            description: data.description,
          }),
          ...(data.price !== undefined && { price: data.price }),
          ...(data.stock !== undefined && { stock: data.stock }),
          // Campos de autopeças
          ...(data.costPrice !== undefined && { costPrice: data.costPrice }),
          ...(data.markup !== undefined && { markup: data.markup }),
          ...(data.brand !== undefined && { brand: data.brand }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.year !== undefined && { year: data.year }),
          ...(data.version !== undefined && { version: data.version }),
          ...(data.category !== undefined && { category: data.category }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.partNumber !== undefined && { partNumber: data.partNumber }),
          ...(data.quality !== undefined && { quality: data.quality }),
          ...(data.isSecurityItem !== undefined && {
            isSecurityItem: data.isSecurityItem,
          }),
          ...(data.isTraceable !== undefined && {
            isTraceable: data.isTraceable,
          }),
          ...(data.sourceVehicle !== undefined && {
            sourceVehicle: data.sourceVehicle,
          }),
          ...(data.mlCategoryId !== undefined && {
            mlCategoryId: data.mlCategoryId,
          }),
          ...(data.mlCategorySource !== undefined && {
            mlCategorySource: data.mlCategorySource,
          }),
          ...(data.mlCategoryChosenAt !== undefined && {
            mlCategoryChosenAt: data.mlCategoryChosenAt as any,
          }),
          ...(data.shopeeCategoryId !== undefined && {
            shopeeCategoryId: data.shopeeCategoryId,
          }),
          ...(data.shopeeCategorySource !== undefined && {
            shopeeCategorySource: data.shopeeCategorySource,
          }),
          ...(data.shopeeCategoryChosenAt !== undefined && {
            shopeeCategoryChosenAt: data.shopeeCategoryChosenAt as any,
          }),

          // Medidas / peso
          ...(data.heightCm !== undefined && { heightCm: data.heightCm }),
          ...(data.widthCm !== undefined && { widthCm: data.widthCm }),
          ...(data.lengthCm !== undefined && { lengthCm: data.lengthCm }),
          ...(data.weightKg !== undefined && { weightKg: data.weightKg }),

          // Imagem do produto
          ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        },
      });

      return mapPrismaToProduct(result);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Conta total de produtos para gerar próximo SKU
   */
  async count(userId?: string): Promise<number> {
    try {
      return await prisma.product.count({ where: userId ? { userId } : {} });
    } catch {
      throw new Error("Erro ao contar produtos");
    }
  }

  /**
   * Busca o maior SKU numérico existente (para evitar duplicação)
   * Exemplo: PROD-005 → retorna 5
   */
  async getMaxSkuNumber(userId?: string): Promise<number> {
    try {
      const products = await prisma.product.findMany({
        where: {
          sku: {
            startsWith: "PROD-",
          },
          ...(userId ? { userId } : {}),
        },
        select: { sku: true },
      });

      if (products.length === 0) return 0;

      const numbers = products
        .map((p) => {
          const match = p.sku.match(/PROD-(\d+)/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter((n) => !isNaN(n));

      return numbers.length > 0 ? Math.max(...numbers) : 0;
    } catch {
      throw new Error("Erro ao buscar maior SKU");
    }
  }
}
export { ProductRepositoryPrisma };

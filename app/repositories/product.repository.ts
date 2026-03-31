import {
  Product,
  ProductCreate,
  ProductUpdate,
  ProductRepository,
  Quality,
} from "../interfaces/product.interface";
import prisma from "../lib/prisma";
import { Platform, Product as PrismaProduct, Prisma } from "@prisma/client";

// Helper para converter Prisma Product para interface Product
function mapPrismaToProduct(item: PrismaProduct): Product {
  const listingsRaw = (item as any).listings as
    | Array<{
        marketplaceAccountId: string;
        requestedCategoryId?: string | null;
        marketplaceAccount?: { platform?: Platform };
      }>
    | undefined;

  const listings =
    listingsRaw && listingsRaw.length > 0
      ? (listingsRaw
          .map((listing) => {
            const platform = listing.marketplaceAccount?.platform;
            if (!platform) return null;
            return {
              platform,
              accountIds: [listing.marketplaceAccountId],
              categoryId: listing.requestedCategoryId ?? undefined,
            };
          })
          .filter(Boolean) as Product["listings"])
      : undefined;

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
    locationId: (item as any).locationId ?? undefined,
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
    imageUrls: (item as any).imageUrls ?? [],

    // Sucata vinculada
    scrapId: (item as any).scrapId ?? undefined,

    // Listagens criadas em marketplaces (simplificadas para UI)
    listings,
  };
}

class ProductRepositoryPrisma implements ProductRepository {
  private static extensionsReady = false;

  /**
   * Garanta extensões e índices para busca tolerante a erro.
   * Usa IF NOT EXISTS para ser idempotente e roda apenas uma vez por processo.
   */
  private async ensureTextSearchExtensions() {
    if (ProductRepositoryPrisma.extensionsReady) return;
    try {
      await prisma.$executeRawUnsafe(`
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        -- wrapper imutável sem depender da extensão unaccent
        CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        AS $$
          SELECT translate(
            $1,
            'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ',
            'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy'
          )
        $$;
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_name_trgm_idx') THEN
            EXECUTE 'CREATE INDEX product_name_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("name")) gin_trgm_ops)';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_sku_trgm_idx') THEN
            EXECUTE 'CREATE INDEX product_sku_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("sku")) gin_trgm_ops)';
          END IF;
        END$$;
      `);
    } catch (error) {
      console.error(
        "[product-search] Falha ao garantir pg_trgm/unaccent; usando busca simples.",
        error,
      );
    } finally {
      ProductRepositoryPrisma.extensionsReady = true;
    }
  }

  private get productSelect() {
    return {
      id: true,
      userId: true,
      sku: true,
      name: true,
      description: true,
      price: true,
      stock: true,
      createdAt: true,
      updatedAt: true,
      costPrice: true,
      markup: true,
      brand: true,
      model: true,
      year: true,
      version: true,
      category: true,
      location: true,
      locationId: true,
      partNumber: true,
      quality: true,
      isSecurityItem: true,
      isTraceable: true,
      sourceVehicle: true,
      imageUrl: true,
      imageUrls: true,
      mlCategoryId: true,
      mlCategorySource: true,
      mlCategoryChosenAt: true,
      shopeeCategoryId: true,
      shopeeCategorySource: true,
      shopeeCategoryChosenAt: true,
      heightCm: true,
      widthCm: true,
      lengthCm: true,
      weightKg: true,
      scrapId: true,
      listings: {
        select: {
          marketplaceAccountId: true,
          requestedCategoryId: true,
          marketplaceAccount: { select: { platform: true } },
        },
      },
    } as const;
  }

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
          locationId: data.locationId ?? null,
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
          imageUrls: data.imageUrls ?? [],

          // Sucata vinculada
          scrapId: data.scrapId ?? null,
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

  async findBySku(sku: string, userId: string): Promise<Product | null> {
    try {
      const item = await prisma.product.findFirst({
        where: { sku, userId },
      });
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
    const search = (options?.search ?? "").trim();

    // Rota rápida: se o termo é puramente numérico, trate como SKU exato
    if (search && /^[0-9]+$/.test(search)) {
      const whereExact: any = {
        ...(userId ? { userId } : {}),
        sku: search,
      };
      const [items, total] = await Promise.all([
        prisma.product.findMany({
          where: whereExact,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: this.productSelect,
        }),
        prisma.product.count({ where: whereExact }),
      ]);

      const products: Product[] = items.map(mapPrismaToProduct);
      return { products, total };
    }

    // Fuzzy/híbrida: SKU parcial + nome com tolerância a erros
    if (search) {
      try {
        await this.ensureTextSearchExtensions();
        const similarityThreshold = search.length >= 4 ? 0.22 : 0.3;
        const userPredicate = userId
          ? Prisma.sql`"userId" = ${userId} AND`
          : Prisma.sql``;

        const rankedIds = await prisma.$queryRaw<
          { id: string; score: number }[]
        >`
          SELECT "id",
                 GREATEST(
                   similarity(immutable_unaccent(lower("name")), immutable_unaccent(lower(${search}))),
                   similarity(immutable_unaccent(lower("sku")),  immutable_unaccent(lower(${search})))
                 ) AS score
          FROM "Product"
          WHERE ${userPredicate}
                (
                  immutable_unaccent("name") ILIKE immutable_unaccent('%' || ${search} || '%') OR
                  immutable_unaccent("sku")  ILIKE immutable_unaccent('%' || ${search} || '%') OR
                  similarity(immutable_unaccent("name"), ${search}) >= ${similarityThreshold} OR
                  similarity(immutable_unaccent("sku"),  ${search}) >= ${similarityThreshold}
                )
          ORDER BY score DESC, "createdAt" DESC
          OFFSET ${skip} LIMIT ${limit};
        `;

        const idOrder = rankedIds.map((r) => r.id);

        const totalRow = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint as count
          FROM "Product"
          WHERE ${userPredicate}
                (
                  immutable_unaccent("name") ILIKE immutable_unaccent('%' || ${search} || '%') OR
                  immutable_unaccent("sku")  ILIKE immutable_unaccent('%' || ${search} || '%') OR
                  similarity(immutable_unaccent("name"), ${search}) >= ${similarityThreshold} OR
                  similarity(immutable_unaccent("sku"),  ${search}) >= ${similarityThreshold}
                );
        `;
        const total = Number(totalRow?.[0]?.count ?? 0);

        if (idOrder.length === 0) {
          return { products: [], total };
        }

        const items = await prisma.product.findMany({
          where: { id: { in: idOrder }, ...(userId ? { userId } : {}) },
          select: this.productSelect,
        });

        const mapped = new Map(
          items.map((p) => [p.id, mapPrismaToProduct(p as unknown as PrismaProduct)]),
        );
        const products = idOrder
          .map((id) => mapped.get(id))
          .filter(Boolean) as Product[];

        return { products, total };
      } catch (error) {
        console.error(
          "[product-search] fallback para busca simples devido a erro:",
          error,
        );
      }
    }

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
          select: this.productSelect,
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
      // Parallel pre-checks: ownership + order items count
      const [owner, orderItemsCount] = await Promise.all([
        userId
          ? prisma.product.findFirst({
              where: { id, userId },
              select: { id: true },
            })
          : Promise.resolve({ id }), // skip check if no userId
        prisma.orderItem.count({
          where: { productId: id },
        }),
      ]);

      if (userId && !owner)
        throw new Error("Produto não encontrado para este usuário");

      if (orderItemsCount > 0) {
        throw new Error(
          "Não é possível deletar o produto pois ele possui pedidos associados",
        );
      }

      // Use transaction for atomic cascade delete
      await prisma.$transaction([
        prisma.stockLog.deleteMany({ where: { productId: id } }),
        prisma.productListing.deleteMany({ where: { productId: id } }),
        prisma.product.delete({ where: { id } }),
      ]);
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
        if (!owner)
          throw new Error("Produto nÃ£o encontrado para este usuÃ¡rio");
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
          ...(data.locationId !== undefined && { locationId: data.locationId }),
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
          ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
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
   * Uses DB-side ordering to avoid fetching all products
   */
  async getMaxSkuNumber(userId?: string): Promise<number> {
    try {
      const result = await prisma.product.findFirst({
        where: {
          sku: { startsWith: "PROD-" },
          ...(userId ? { userId } : {}),
        },
        select: { sku: true },
        orderBy: { sku: "desc" },
      });

      if (!result) return 0;

      const match = result.sku.match(/PROD-(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      throw new Error("Erro ao buscar maior SKU");
    }
  }
}
export { ProductRepositoryPrisma };

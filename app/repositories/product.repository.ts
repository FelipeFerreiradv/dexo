import {
  ProductPublishedCategoryFilterOption,
  Product,
  ProductCreate,
  ProductListFilters,
  ProductMarketplaceFilter,
  ProductPublicationStatus,
  ProductRepository,
  ProductUpdate,
  Quality,
} from "../interfaces/product.interface";
import prisma from "../lib/prisma";
import { Platform, Prisma, Product as PrismaProduct } from "@prisma/client";
import {
  buildProductListingCategoryValue,
  normalizeProductListingCategoryId,
  parseProductListingCategoryValue,
} from "../lib/product-listing-category";
import { normalizeSku } from "../lib/sku";

const LOW_STOCK_THRESHOLD = 10;
const PUBLISHED_MARKETPLACE_PLATFORMS = ["MERCADO_LIVRE", "SHOPEE"] as const;
type PublishedMarketplacePlatform =
  (typeof PUBLISHED_MARKETPLACE_PLATFORMS)[number];

const MARKETPLACE_LABELS: Record<PublishedMarketplacePlatform, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
};
const PUBLICATION_STATUS_VALUES: Record<
  Exclude<ProductPublicationStatus, "NO_LISTING">,
  string[]
> = {
  ACTIVE: ["active", "normal"],
  PAUSED: ["paused", "unlist"],
  PENDING: ["pending", "reviewing"],
  ERROR: ["error", "banned"],
  CLOSED: ["closed", "deleted", "seller_deleted", "inactive"],
};

function isPublishedMarketplacePlatform(
  platform: Platform | null | undefined,
): platform is PublishedMarketplacePlatform {
  return platform === "MERCADO_LIVRE" || platform === "SHOPEE";
}

function combineWhereClauses(
  ...clauses: Array<Prisma.ProductWhereInput | undefined>
): Prisma.ProductWhereInput {
  const validClauses = clauses.filter(
    (clause): clause is Prisma.ProductWhereInput =>
      clause !== undefined && Object.keys(clause).length > 0,
  );

  if (validClauses.length === 0) return {};
  if (validClauses.length === 1) return validClauses[0];
  return { AND: validClauses };
}

function combineListingWhereClauses(
  ...clauses: Array<Prisma.ProductListingWhereInput | undefined>
): Prisma.ProductListingWhereInput {
  const validClauses = clauses.filter(
    (clause): clause is Prisma.ProductListingWhereInput =>
      clause !== undefined && Object.keys(clause).length > 0,
  );

  if (validClauses.length === 0) return {};
  if (validClauses.length === 1) return validClauses[0];
  return { AND: validClauses };
}

function combineSqlClauses(clauses: Prisma.Sql[]): Prisma.Sql {
  if (clauses.length === 0) {
    return Prisma.sql`TRUE`;
  }

  return clauses
    .slice(1)
    .reduce(
      (combined, clause) => Prisma.sql`${combined} AND ${clause}`,
      clauses[0],
    );
}

function mapPrismaCompatibilities(item: PrismaProduct): Product["compatibilities"] {
  const raw = (item as any).compatibilities as
    | Array<{
        brand: string;
        model: string;
        yearFrom?: number | null;
        yearTo?: number | null;
        version?: string | null;
      }>
    | undefined;
  if (!raw || raw.length === 0) return undefined;
  return raw.map((c) => ({
    brand: c.brand,
    model: c.model,
    yearFrom: c.yearFrom ?? null,
    yearTo: c.yearTo ?? null,
    version: c.version ?? null,
  }));
}

function mapPrismaToProduct(item: PrismaProduct): Product {
  const listingsRaw = (item as any).listings as
    | Array<{
        marketplaceAccountId: string;
        requestedCategoryId?: string | null;
        externalListingId?: string | null;
        permalink?: string | null;
        status?: string | null;
        updatedAt?: Date | null;
        marketplaceAccount?: { platform?: Platform; shopId?: number | null };
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
              marketplaceAccountId: listing.marketplaceAccountId,
              accountIds: [listing.marketplaceAccountId],
              categoryId: listing.requestedCategoryId ?? undefined,
              externalListingId: listing.externalListingId ?? undefined,
              permalink: listing.permalink ?? undefined,
              shopId: listing.marketplaceAccount?.shopId ?? undefined,
              status: listing.status ?? undefined,
              updatedAt: listing.updatedAt ?? undefined,
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
    mlCategory: (item as any).mlCategory?.externalId ?? undefined,
    mlCategorySource: (item as any).mlCategorySource ?? undefined,
    mlCategoryChosenAt: item.mlCategoryChosenAt ?? undefined,
    shopeeCategoryId: (item as any).shopeeCategoryId ?? undefined,
    shopeeCategorySource: (item as any).shopeeCategorySource ?? undefined,
    shopeeCategoryChosenAt: (item as any).shopeeCategoryChosenAt ?? undefined,
    heightCm: item.heightCm ?? undefined,
    widthCm: item.widthCm ?? undefined,
    lengthCm: item.lengthCm ?? undefined,
    weightKg: item.weightKg?.toNumber() ?? undefined,
    imageUrl: item.imageUrl ?? undefined,
    imageUrls: (item as any).imageUrls ?? [],
    scrapId: (item as any).scrapId ?? undefined,
    listings,
    compatibilities: mapPrismaCompatibilities(item),
  };
}

class ProductRepositoryPrisma implements ProductRepository {
  private static extensionsReady = false;

  private async ensureTextSearchExtensions() {
    if (ProductRepositoryPrisma.extensionsReady) return;

    try {
      // Prisma's $executeRawUnsafe wraps each call in a prepared statement,
      // which Postgres refuses for multi-command strings ("cannot insert
      // multiple commands into a prepared statement"). Split into one call
      // per statement.
      await prisma.$executeRawUnsafe(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
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
         $$`,
      );
      await prisma.$executeRawUnsafe(
        `DO $outer$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_name_trgm_idx') THEN
             EXECUTE 'CREATE INDEX product_name_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("name")) gin_trgm_ops)';
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_sku_trgm_idx') THEN
             EXECUTE 'CREATE INDEX product_sku_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("sku")) gin_trgm_ops)';
           END IF;
         END$outer$`,
      );
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
      mlCategory: {
        select: { externalId: true, fullPath: true },
      },
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
          externalListingId: true,
          permalink: true,
          status: true,
          updatedAt: true,
          marketplaceAccount: {
            select: {
              platform: true,
              shopId: true,
            },
          },
        },
      },
    } as const;
  }

  private buildPublicationListingWhere(
    publicationStatus?: ProductPublicationStatus,
    marketplace?: ProductMarketplaceFilter,
    listingCategory?: string,
  ): Prisma.ProductListingWhereInput | undefined {
    const clauses: Prisma.ProductListingWhereInput[] = [];
    const parsedListingCategory =
      parseProductListingCategoryValue(listingCategory);
    const effectiveMarketplace =
      parsedListingCategory?.platform ??
      (marketplace === "MERCADO_LIVRE" || marketplace === "SHOPEE"
        ? marketplace
        : undefined);

    if (effectiveMarketplace) {
      clauses.push({
        marketplaceAccount: {
          is: {
            platform: effectiveMarketplace,
          },
        },
      });
    }

    if (parsedListingCategory) {
      clauses.push({
        OR: parsedListingCategory.requestedCategoryIds.map((categoryId) => ({
          requestedCategoryId: {
            equals: categoryId,
            mode: "insensitive" as const,
          },
        })),
      });
    }

    if (publicationStatus && publicationStatus !== "NO_LISTING") {
      clauses.push({
        OR: PUBLICATION_STATUS_VALUES[publicationStatus].map((status) => ({
          status: {
            equals: status,
            mode: "insensitive" as const,
          },
        })),
      });
    }

    return clauses.length > 0
      ? combineListingWhereClauses(...clauses)
      : undefined;
  }

  private buildMarketplaceMembershipWhere(
    marketplace?: ProductMarketplaceFilter,
  ): Prisma.ProductWhereInput | undefined {
    switch (marketplace) {
      case "MERCADO_LIVRE":
        return combineWhereClauses(
          {
            listings: {
              some: {
                marketplaceAccount: {
                  is: {
                    platform: "MERCADO_LIVRE",
                  },
                },
              },
            },
          },
          {
            listings: {
              none: {
                marketplaceAccount: {
                  is: {
                    platform: "SHOPEE",
                  },
                },
              },
            },
          },
        );
      case "SHOPEE":
        return combineWhereClauses(
          {
            listings: {
              some: {
                marketplaceAccount: {
                  is: {
                    platform: "SHOPEE",
                  },
                },
              },
            },
          },
          {
            listings: {
              none: {
                marketplaceAccount: {
                  is: {
                    platform: "MERCADO_LIVRE",
                  },
                },
              },
            },
          },
        );
      case "BOTH":
        return combineWhereClauses(
          {
            listings: {
              some: {
                marketplaceAccount: {
                  is: {
                    platform: "MERCADO_LIVRE",
                  },
                },
              },
            },
          },
          {
            listings: {
              some: {
                marketplaceAccount: {
                  is: {
                    platform: "SHOPEE",
                  },
                },
              },
            },
          },
        );
      default:
        return undefined;
    }
  }

  private buildMarketplaceMembershipSqlClauses(
    marketplace?: ProductMarketplaceFilter,
  ): Prisma.Sql[] {
    const existsInPlatform = (platform: PublishedMarketplacePlatform) =>
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "ProductListing" pl_scope
        JOIN "MarketplaceAccount" ma_scope
          ON ma_scope."id" = pl_scope."marketplaceAccountId"
        WHERE pl_scope."productId" = p."id"
          AND ma_scope."platform" = ${platform}
      )`;

    const doesNotExistInPlatform = (platform: PublishedMarketplacePlatform) =>
      Prisma.sql`NOT EXISTS (
        SELECT 1
        FROM "ProductListing" pl_scope
        JOIN "MarketplaceAccount" ma_scope
          ON ma_scope."id" = pl_scope."marketplaceAccountId"
        WHERE pl_scope."productId" = p."id"
          AND ma_scope."platform" = ${platform}
      )`;

    switch (marketplace) {
      case "MERCADO_LIVRE":
        return [
          existsInPlatform("MERCADO_LIVRE"),
          doesNotExistInPlatform("SHOPEE"),
        ];
      case "SHOPEE":
        return [
          existsInPlatform("SHOPEE"),
          doesNotExistInPlatform("MERCADO_LIVRE"),
        ];
      case "BOTH":
        return [existsInPlatform("MERCADO_LIVRE"), existsInPlatform("SHOPEE")];
      default:
        return [];
    }
  }

  private buildBaseWhere(
    filters?: ProductListFilters,
    userId?: string,
  ): Prisma.ProductWhereInput {
    const clauses: Prisma.ProductWhereInput[] = [];

    if (userId) {
      clauses.push({ userId });
    }

    const marketplaceMembershipWhere = this.buildMarketplaceMembershipWhere(
      filters?.marketplace,
    );

    if (marketplaceMembershipWhere) {
      clauses.push(marketplaceMembershipWhere);
    }

    if (filters?.createdFrom || filters?.createdTo) {
      clauses.push({
        createdAt: {
          ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
          ...(filters.createdTo ? { lte: filters.createdTo } : {}),
        },
      });
    }

    if (filters?.stockStatus === "IN_STOCK") {
      clauses.push({ stock: { gt: 0 } });
    }

    if (filters?.stockStatus === "OUT_OF_STOCK") {
      clauses.push({ stock: 0 });
    }

    if (filters?.stockStatus === "LOW_STOCK") {
      clauses.push({ stock: { lte: LOW_STOCK_THRESHOLD } });
    }

    if (filters?.priceMin !== undefined || filters?.priceMax !== undefined) {
      clauses.push({
        price: {
          ...(filters.priceMin !== undefined ? { gte: filters.priceMin } : {}),
          ...(filters.priceMax !== undefined ? { lte: filters.priceMax } : {}),
        },
      });
    }

    if (filters?.brand) {
      clauses.push({
        OR: [
          {
            brand: {
              equals: filters.brand,
              mode: "insensitive",
            },
          },
          {
            compatibilities: {
              some: {
                brand: {
                  equals: filters.brand,
                  mode: "insensitive",
                },
              },
            },
          },
        ],
      });
    }

    if (filters?.quality) {
      clauses.push({ quality: filters.quality });
    }

    if (filters?.locationId) {
      clauses.push({ locationId: filters.locationId });
    }

    if (filters?.publicationStatus === "NO_LISTING") {
      clauses.push({
        listings: {
          none:
            this.buildPublicationListingWhere(
              undefined,
              filters.marketplace,
              filters.listingCategory,
            ) ?? {},
        },
      });
    } else {
      const listingWhere = this.buildPublicationListingWhere(
        filters?.publicationStatus,
        filters?.marketplace,
        filters?.listingCategory,
      );

      if (listingWhere) {
        clauses.push({
          listings: {
            some: listingWhere,
          },
        });
      }
    }

    return combineWhereClauses(...clauses);
  }

  private buildBaseSqlWhere(
    filters?: ProductListFilters,
    userId?: string,
  ): Prisma.Sql {
    const clauses: Prisma.Sql[] = [];
    const parsedListingCategory = parseProductListingCategoryValue(
      filters?.listingCategory,
    );

    if (userId) {
      clauses.push(Prisma.sql`p."userId" = ${userId}`);
    }

    clauses.push(
      ...this.buildMarketplaceMembershipSqlClauses(filters?.marketplace),
    );

    if (filters?.createdFrom) {
      clauses.push(Prisma.sql`p."createdAt" >= ${filters.createdFrom}`);
    }

    if (filters?.createdTo) {
      clauses.push(Prisma.sql`p."createdAt" <= ${filters.createdTo}`);
    }

    if (filters?.stockStatus === "IN_STOCK") {
      clauses.push(Prisma.sql`p."stock" > 0`);
    }

    if (filters?.stockStatus === "OUT_OF_STOCK") {
      clauses.push(Prisma.sql`p."stock" = 0`);
    }

    if (filters?.stockStatus === "LOW_STOCK") {
      clauses.push(Prisma.sql`p."stock" <= ${LOW_STOCK_THRESHOLD}`);
    }

    if (filters?.priceMin !== undefined) {
      clauses.push(Prisma.sql`p."price" >= ${filters.priceMin}`);
    }

    if (filters?.priceMax !== undefined) {
      clauses.push(Prisma.sql`p."price" <= ${filters.priceMax}`);
    }

    if (filters?.brand) {
      clauses.push(
        Prisma.sql`(
          LOWER(COALESCE(p."brand", '')) = LOWER(${filters.brand}) OR
          EXISTS (
            SELECT 1
            FROM "ProductCompatibility" pc
            WHERE pc."productId" = p."id"
              AND LOWER(COALESCE(pc."brand", '')) = LOWER(${filters.brand})
          )
        )`,
      );
    }

    if (filters?.quality) {
      clauses.push(Prisma.sql`p."quality" = ${filters.quality}`);
    }

    if (filters?.locationId) {
      clauses.push(Prisma.sql`p."locationId" = ${filters.locationId}`);
    }

    const listingClauses: Prisma.Sql[] = [Prisma.sql`pl."productId" = p."id"`];

    const scopedMarketplace =
      parsedListingCategory?.platform ??
      (filters?.marketplace === "MERCADO_LIVRE" ||
      filters?.marketplace === "SHOPEE"
        ? filters.marketplace
        : undefined);

    if (scopedMarketplace) {
      listingClauses.push(Prisma.sql`ma."platform" = ${scopedMarketplace}`);
    }

    if (parsedListingCategory) {
      listingClauses.push(
        Prisma.sql`LOWER(COALESCE(pl."requestedCategoryId", '')) IN (${Prisma.join(
          parsedListingCategory.requestedCategoryIds.map((categoryId) =>
            categoryId.toLowerCase(),
          ),
        )})`,
      );
    }

    if (filters?.publicationStatus === "NO_LISTING") {
      clauses.push(
        Prisma.sql`NOT EXISTS (
          SELECT 1
          FROM "ProductListing" pl
          JOIN "MarketplaceAccount" ma
            ON ma."id" = pl."marketplaceAccountId"
          WHERE ${combineSqlClauses(listingClauses)}
        )`,
      );
    } else if (filters?.publicationStatus || filters?.marketplace) {
      const scopedListingClauses = [...listingClauses];

      if (filters?.publicationStatus) {
        scopedListingClauses.push(
          Prisma.sql`LOWER(pl."status") IN (${Prisma.join(
            PUBLICATION_STATUS_VALUES[filters.publicationStatus].map((status) =>
              status.toLowerCase(),
            ),
          )})`,
        );
      }

      clauses.push(
        Prisma.sql`EXISTS (
          SELECT 1
          FROM "ProductListing" pl
          JOIN "MarketplaceAccount" ma
            ON ma."id" = pl."marketplaceAccountId"
          WHERE ${combineSqlClauses(scopedListingClauses)}
        )`,
      );
    }

    return combineSqlClauses(clauses);
  }

  async create(data: ProductCreate): Promise<Product> {
    try {
      const compatInput = Array.isArray(data.compatibilities)
        ? data.compatibilities
            .filter(
              (c) =>
                c &&
                typeof c.brand === "string" &&
                c.brand.trim().length > 0 &&
                typeof c.model === "string" &&
                c.model.trim().length > 0,
            )
            .map((c) => ({
              brand: c.brand.trim(),
              model: c.model.trim(),
              yearFrom: c.yearFrom ?? null,
              yearTo: c.yearTo ?? null,
              version:
                typeof c.version === "string" && c.version.trim().length > 0
                  ? c.version.trim()
                  : null,
            }))
        : [];

      const result = await prisma.product.create({
        data: {
          userId: data.userId ?? null,
          name: data.name,
          sku: data.sku,
          skuNormalized: normalizeSku(data.sku),
          description: data.description ?? null,
          price: data.price,
          stock: data.stock,
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
          heightCm: data.heightCm ?? null,
          widthCm: data.widthCm ?? null,
          lengthCm: data.lengthCm ?? null,
          weightKg: data.weightKg ?? null,
          imageUrl: data.imageUrl,
          imageUrls: data.imageUrls ?? [],
          scrapId: data.scrapId ?? null,
          ...(compatInput.length > 0
            ? { compatibilities: { create: compatInput } }
            : {}),
        },
        include: { compatibilities: true },
      });

      return mapPrismaToProduct(result);
    } catch (error: any) {
      console.error("Erro Prisma ao criar produto:", error);

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
    filters?: ProductListFilters,
    userId?: string,
  ): Promise<{ products: Product[]; total: number }> {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 10;
    const skip = (page - 1) * limit;
    const search = (filters?.search ?? "").trim();
    const baseWhere = this.buildBaseWhere(filters, userId);

    if (search && /^[0-9]+$/.test(search)) {
      const whereExact = combineWhereClauses(baseWhere, { sku: search });
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

      return {
        products: items.map(mapPrismaToProduct),
        total,
      };
    }

    if (search) {
      try {
        await this.ensureTextSearchExtensions();
        const similarityThreshold = search.length >= 4 ? 0.22 : 0.3;
        const baseSqlWhere = this.buildBaseSqlWhere(filters, userId);
        const fuzzyPredicate = Prisma.sql`(
          immutable_unaccent(p."name") ILIKE immutable_unaccent(${`%${search}%`}) OR
          immutable_unaccent(p."sku") ILIKE immutable_unaccent(${`%${search}%`}) OR
          similarity(immutable_unaccent(p."name"), ${search}) >= ${similarityThreshold} OR
          similarity(immutable_unaccent(p."sku"), ${search}) >= ${similarityThreshold}
        )`;
        const rankedWhere = combineSqlClauses([baseSqlWhere, fuzzyPredicate]);

        const [rankedIds, totalRow] = await Promise.all([
          prisma.$queryRaw<{ id: string; score: number }[]>`
            SELECT p."id",
                   GREATEST(
                     similarity(immutable_unaccent(lower(p."name")), immutable_unaccent(lower(${search}))),
                     similarity(immutable_unaccent(lower(p."sku")), immutable_unaccent(lower(${search})))
                   ) AS score
            FROM "Product" p
            WHERE ${rankedWhere}
            ORDER BY score DESC, p."createdAt" DESC
            OFFSET ${skip} LIMIT ${limit};
          `,
          prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*)::bigint as count
            FROM "Product" p
            WHERE ${rankedWhere};
          `,
        ]);
        const total = Number(totalRow?.[0]?.count ?? 0);
        const idOrder = rankedIds.map((item) => item.id);

        if (idOrder.length === 0) {
          return { products: [], total };
        }

        const items = await prisma.product.findMany({
          where: combineWhereClauses(baseWhere, {
            id: { in: idOrder },
          }),
          select: this.productSelect,
        });

        const mapped = new Map(
          items.map((item) => [
            item.id,
            mapPrismaToProduct(item as unknown as PrismaProduct),
          ]),
        );

        return {
          products: idOrder
            .map((id) => mapped.get(id))
            .filter(Boolean) as Product[],
          total,
        };
      } catch (error) {
        console.error(
          "[product-search] fallback para busca simples devido a erro:",
          error,
        );
      }
    }

    const where = search
      ? combineWhereClauses(baseWhere, {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { sku: { contains: search, mode: "insensitive" } },
          ],
        })
      : baseWhere;

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

      return {
        products: items.map(mapPrismaToProduct),
        total,
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findPublishedCategories(
    userId: string,
  ): Promise<ProductPublishedCategoryFilterOption[]> {
    const listings = await prisma.productListing.findMany({
      where: {
        requestedCategoryId: { not: null },
        product: { userId },
        marketplaceAccount: {
          is: {
            platform: {
              in: [...PUBLISHED_MARKETPLACE_PLATFORMS],
            },
          },
        },
      },
      select: {
        requestedCategoryId: true,
        marketplaceAccount: {
          select: {
            platform: true,
          },
        },
      },
    });

    const distinctCategories = new Map<
      string,
      {
        platform: PublishedMarketplacePlatform;
        normalizedCategoryId: string;
        rawCategoryId: string;
      }
    >();

    for (const listing of listings) {
      const requestedCategoryId = listing.requestedCategoryId?.trim();
      const platform = listing.marketplaceAccount?.platform;

      if (!requestedCategoryId || !isPublishedMarketplacePlatform(platform)) {
        continue;
      }

      const normalizedCategoryId = normalizeProductListingCategoryId(
        platform,
        requestedCategoryId,
      );

      if (!normalizedCategoryId) {
        continue;
      }

      const key = buildProductListingCategoryValue(
        platform,
        normalizedCategoryId,
      );
      if (!key || distinctCategories.has(key)) {
        continue;
      }

      distinctCategories.set(key, {
        platform,
        normalizedCategoryId,
        rawCategoryId: requestedCategoryId,
      });
    }

    if (distinctCategories.size === 0) {
      return [];
    }

    const categoryRecords = await prisma.marketplaceCategory.findMany({
      where: {
        externalId: {
          in: Array.from(distinctCategories.values()).map(
            (item) => item.normalizedCategoryId,
          ),
        },
      },
      select: {
        externalId: true,
        fullPath: true,
        name: true,
      },
    });

    const categoryLookup = new Map(
      categoryRecords.map((category) => [
        category.externalId,
        category.fullPath || category.name || category.externalId,
      ]),
    );

    return Array.from(distinctCategories.values())
      .map((item) => {
        const categoryName =
          categoryLookup.get(item.normalizedCategoryId) || item.rawCategoryId;

        return {
          value: buildProductListingCategoryValue(
            item.platform,
            item.normalizedCategoryId,
          ),
          label: `${MARKETPLACE_LABELS[item.platform]} \u2022 ${categoryName}`,
          platform: item.platform,
          categoryId: item.normalizedCategoryId,
        };
      })
      .sort((left, right) =>
        left.label.localeCompare(right.label, "pt-BR", {
          sensitivity: "base",
        }),
      );
  }

  async delete(id: string, userId?: string): Promise<void> {
    try {
      const [owner, orderItemsCount] = await Promise.all([
        userId
          ? prisma.product.findFirst({
              where: { id, userId },
              select: { id: true },
            })
          : Promise.resolve({ id }),
        prisma.orderItem.count({
          where: { productId: id },
        }),
      ]);

      if (userId && !owner) {
        throw new Error("Produto não encontrado para este usuário");
      }

      if (orderItemsCount > 0) {
        throw new Error(
          "Não é possível deletar o produto pois ele possui pedidos associados",
        );
      }

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
        include: { compatibilities: true },
      });

      if (!item) return null;
      return mapPrismaToProduct(item as unknown as PrismaProduct);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findByIdDetailed(id: string, userId: string) {
    // Run product + stock-log queries in parallel (independent reads)
    const [item, recentStockChanges] = await Promise.all([
      prisma.product.findFirst({
        where: { id, userId },
        include: {
          compatibilities: true,
          mlCategory: {
            select: { externalId: true, fullPath: true },
          },
          listings: {
            include: {
              marketplaceAccount: {
                select: {
                  id: true,
                  platform: true,
                  accountName: true,
                  shopId: true,
                },
              },
            },
          },
          scrap: {
            select: {
              id: true,
              brand: true,
              model: true,
              year: true,
              version: true,
              color: true,
              plate: true,
            },
          },
        },
      }),
      prisma.stockLog.findMany({
        where: { productId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          change: true,
          reason: true,
          previousStock: true,
          newStock: true,
          createdAt: true,
        },
      }),
    ]);

    if (!item) return null;

    const product = mapPrismaToProduct(item as unknown as PrismaProduct);

    // Enrich listings with account details
    const detailedListings = (item.listings || []).map((listing) => ({
      id: listing.id,
      platform: listing.marketplaceAccount.platform,
      accountName: listing.marketplaceAccount.accountName,
      marketplaceAccountId: listing.marketplaceAccountId,
      externalListingId: listing.externalListingId,
      status: listing.status,
      permalink: listing.permalink ?? undefined,
      shopId: listing.marketplaceAccount.shopId ?? undefined,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
      // Settings ML persistidos (permitem o edit modal hidratar do ProductListing
      // antes de cair nos user.default*)
      listingType: (listing as any).listingType ?? null,
      itemCondition: (listing as any).itemCondition ?? null,
      hasWarranty: (listing as any).hasWarranty ?? null,
      warrantyUnit: (listing as any).warrantyUnit ?? null,
      warrantyDuration: (listing as any).warrantyDuration ?? null,
      shippingMode: (listing as any).shippingMode ?? null,
      freeShipping: (listing as any).freeShipping ?? null,
      localPickup: (listing as any).localPickup ?? null,
      manufacturingTime: (listing as any).manufacturingTime ?? null,
    }));

    const scrapSummary = item.scrap
      ? {
          id: item.scrap.id,
          brand: item.scrap.brand,
          model: item.scrap.model,
          year: item.scrap.year ?? undefined,
          version: item.scrap.version ?? undefined,
          color: item.scrap.color ?? undefined,
          plate: item.scrap.plate ?? undefined,
        }
      : undefined;

    return {
      product,
      detailedListings,
      recentStockChanges,
      scrapSummary,
    };
  }

  async update(
    id: string,
    data: ProductUpdate,
    userId?: string,
  ): Promise<Product> {
    try {
      // Preparar compatibilidades se fornecidas (CPU-only, antes da transação)
      const compatInput =
        data.compatibilities !== undefined
          ? (Array.isArray(data.compatibilities)
              ? data.compatibilities
                  .filter(
                    (c) =>
                      c &&
                      typeof c.brand === "string" &&
                      c.brand.trim().length > 0 &&
                      typeof c.model === "string" &&
                      c.model.trim().length > 0,
                  )
                  .map((c) => ({
                    brand: c.brand.trim(),
                    model: c.model.trim(),
                    yearFrom: c.yearFrom ?? null,
                    yearTo: c.yearTo ?? null,
                    version:
                      typeof c.version === "string" &&
                      c.version.trim().length > 0
                        ? c.version.trim()
                        : null,
                  }))
              : [])
          : undefined;

      const productData: Prisma.ProductUpdateInput = {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.price !== undefined && { price: data.price }),
        ...(data.stock !== undefined && { stock: data.stock }),
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
        ...(data.heightCm !== undefined && { heightCm: data.heightCm }),
        ...(data.widthCm !== undefined && { widthCm: data.widthCm }),
        ...(data.lengthCm !== undefined && { lengthCm: data.lengthCm }),
        ...(data.weightKg !== undefined && { weightKg: data.weightKg }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
      };

      // Transação atômica: ownership check + produto + compatibilidades juntos
      const result = await prisma.$transaction(async (tx) => {
        if (userId) {
          const owner = await tx.product.findFirst({
            where: { id, userId },
            select: { id: true },
          });
          if (!owner) {
            throw new Error("Produto não encontrado para este usuário");
          }
        }

        if (compatInput !== undefined) {
          await tx.productCompatibility.deleteMany({
            where: { productId: id },
          });
          if (compatInput.length > 0) {
            await tx.productCompatibility.createMany({
              data: compatInput.map((c) => ({ ...c, productId: id })),
            });
          }
        }

        return tx.product.update({
          where: { id },
          data: productData,
          include: { compatibilities: true },
        });
      });

      return mapPrismaToProduct(result as unknown as PrismaProduct);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async count(userId?: string): Promise<number> {
    try {
      return await prisma.product.count({ where: userId ? { userId } : {} });
    } catch {
      throw new Error("Erro ao contar produtos");
    }
  }

  async getMaxSkuNumber(userId?: string): Promise<number> {
    try {
      const rows = await prisma.product.findMany({
        where: userId ? { userId } : {},
        select: { sku: true },
      });

      let max = 0;
      for (const { sku } of rows) {
        if (!sku) continue;
        const match = sku.match(/^(?:PROD-)?(\d{1,9})$/);
        if (!match) continue;
        const n = parseInt(match[1], 10);
        if (!Number.isSafeInteger(n)) continue;
        if (n > max) max = n;
      }
      return max;
    } catch {
      throw new Error("Erro ao buscar maior SKU");
    }
  }
}

export { ProductRepositoryPrisma };

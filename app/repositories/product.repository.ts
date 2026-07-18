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
import {
  tokenizeSearch,
  reduceVariants,
  isCodeLikeQuery,
} from "./product-search-terms";

const LOW_STOCK_THRESHOLD = 10;
const PUBLISHED_MARKETPLACE_PLATFORMS = [
  "MERCADO_LIVRE",
  "SHOPEE",
  "MAGALU",
] as const;
type PublishedMarketplacePlatform =
  (typeof PUBLISHED_MARKETPLACE_PLATFORMS)[number];

const MARKETPLACE_LABELS: Record<PublishedMarketplacePlatform, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
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
  return (
    platform === "MERCADO_LIVRE" ||
    platform === "SHOPEE" ||
    platform === "MAGALU"
  );
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

/**
 * Campos textuais usados na busca por termo. Coincidem com as expressões já
 * indexadas via GIN trigram em `ensureTextSearchExtensions`
 * (`immutable_unaccent(lower("campo"))`), então o ILIKE por termo usa índice.
 */
const TOKEN_SEARCH_FIELDS = [
  "name",
  "sku",
  "brand",
  "model",
  "partNumber",
] as const;

/** Expressão normalizada de um campo (bate com o índice trigram). */
function fieldUnaccent(field: string): Prisma.Sql {
  // `field` vem sempre de TOKEN_SEARCH_FIELDS (constantes), nunca de input.
  return Prisma.raw(`immutable_unaccent(lower(p."${field}"))`);
}

/** OR de várias cláusulas SQL (FALSE se vazio). */
function joinOr(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) return Prisma.sql`FALSE`;
  return parts
    .slice(1)
    .reduce((acc, part) => Prisma.sql`${acc} OR ${part}`, parts[0]);
}

/** `campo ILIKE %variante%` para cada (campo, variante), unidos por OR. */
function ilikeAnyField(
  variants: string[],
  fields: readonly string[],
): Prisma.Sql {
  // Colapsa variantes redundantes (`%tras%` cobre `%traseira%`) antes de gerar
  // as condições — mesmo resultado, menos trabalho no Postgres.
  const effective = reduceVariants(variants);
  const parts: Prisma.Sql[] = [];
  for (const field of fields) {
    const expr = fieldUnaccent(field);
    for (const variant of effective) {
      parts.push(Prisma.sql`${expr} ILIKE ${`%${variant}%`}`);
    }
  }
  return joinOr(parts);
}

/**
 * Predicado AND: cada grupo de termos deve casar em ALGUM campo. É isto que
 * derruba o ruído — "fecha tras esq palio" exige fecha E tras E esq E palio,
 * em vez de qualquer-um (OR da frase inteira).
 */
function buildTokenPredicate(groups: string[][]): Prisma.Sql {
  const groupClauses = groups.map(
    (variants) => Prisma.sql`(${ilikeAnyField(variants, TOKEN_SEARCH_FIELDS)})`,
  );
  return combineSqlClauses(groupClauses); // AND entre grupos
}

/**
 * Score de relevância: por grupo, pega o MAIOR peso de campo casado
 * (name/partNumber=3, sku/brand/model=2) e soma entre os grupos. Usado só
 * para ORDENAR; o predicado AND já filtrou o conjunto.
 */
function buildTokenScore(groups: string[][]): Prisma.Sql {
  if (groups.length === 0) return Prisma.sql`0`;
  const perGroup = groups.map((variants) => {
    const high = ilikeAnyField(variants, ["name", "partNumber"]);
    const mid = ilikeAnyField(variants, ["sku", "brand", "model"]);
    return Prisma.sql`(CASE WHEN ${high} THEN 3 WHEN ${mid} THEN 2 ELSE 0 END)`;
  });
  return perGroup
    .slice(1)
    .reduce((acc, group) => Prisma.sql`${acc} + ${group}`, perGroup[0]);
}

function mapPrismaCompatibilities(
  item: PrismaProduct,
): Product["compatibilities"] {
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
    magaluCategoryId: (item as any).magaluCategoryId ?? undefined,
    magaluCategorySource: (item as any).magaluCategorySource ?? undefined,
    magaluCategoryChosenAt: (item as any).magaluCategoryChosenAt ?? undefined,
    heightCm: item.heightCm ?? undefined,
    widthCm: item.widthCm ?? undefined,
    lengthCm: item.lengthCm ?? undefined,
    weightKg: item.weightKg?.toNumber() ?? undefined,
    imageUrl: item.imageUrl ?? undefined,
    imageUrls: (item as any).imageUrls ?? [],
    attributes:
      ((item as any).attributes as
        | Record<string, { value_id?: string; value_name?: string }>
        | null
        | undefined) ?? undefined,
    mlCatalogProductId: (item as any).mlCatalogProductId ?? undefined,
    mlCatalogSnapshot:
      ((item as any).mlCatalogSnapshot as
        | Record<string, unknown>
        | null
        | undefined) ?? undefined,
    scrapId: (item as any).scrapId ?? undefined,
    createdFromMarketplace: (item as any).createdFromMarketplace ?? false,
    originPlatform: (item as any).originPlatform ?? undefined,
    productLocation: (item as any).productLocation
      ? {
          id: (item as any).productLocation.id,
          code: (item as any).productLocation.code,
          description: (item as any).productLocation.description ?? undefined,
        }
      : undefined,
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
      await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
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
           IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_brand_trgm_idx') THEN
             EXECUTE 'CREATE INDEX product_brand_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("brand")) gin_trgm_ops)';
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_model_trgm_idx') THEN
             EXECUTE 'CREATE INDEX product_model_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("model")) gin_trgm_ops)';
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'product_partnumber_trgm_idx') THEN
             EXECUTE 'CREATE INDEX product_partnumber_trgm_idx ON "Product" USING GIN (immutable_unaccent(lower("partNumber")) gin_trgm_ops)';
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
      productLocation: {
        select: {
          id: true,
          code: true,
          description: true,
        },
      },
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
      magaluCategoryId: true,
      magaluCategorySource: true,
      magaluCategoryChosenAt: true,
      heightCm: true,
      widthCm: true,
      lengthCm: true,
      weightKg: true,
      attributes: true,
      mlCatalogProductId: true,
      // mlCatalogSnapshot OMITIDO da lista: é um JSONB pesado (KB/linha) que a UI
      // nunca lê (só usa mlCatalogProductId). O detalhe (findByIdDetailed) usa
      // `include` e continua trazendo-o; o update guarda `!== undefined`, então
      // salvar uma edição não o sobrescreve. EGRESS: corta o maior peso por linha.
      scrapId: true,
      createdFromMarketplace: true,
      originPlatform: true,
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
      (marketplace && marketplace !== "BOTH" ? marketplace : undefined);

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
      case "MAGALU":
        // Canal único (igual a ML/SHOPEE): produtos com ao menos 1 anúncio
        // Magalu. Sem exclusão dos outros canais (evita mexer na semântica
        // histórica de ML/Shopee).
        return {
          listings: {
            some: {
              marketplaceAccount: {
                is: {
                  platform: "MAGALU",
                },
              },
            },
          },
        };
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
      case "MAGALU":
        // Canal único: ao menos 1 anúncio Magalu (sem excluir ML/Shopee).
        return [existsInPlatform("MAGALU")];
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

      // Tenant guard: se um scrapId for informado, a sucata DEVE pertencer ao
      // mesmo userId do produto. Product.scrapId é FK p/ Scrap sem garantir
      // Product.userId == Scrap.userId — sem esta checagem, um payload forjado
      // poderia vincular o produto à sucata de OUTRO tenant (poluindo as
      // agregações daquela sucata: getScrapParts/getScrapMoney/reconcile). No-op
      // para produtos legítimos (mesmo dono). "inválido" → 400 no route handler.
      if (data.scrapId && data.userId) {
        const ownsScrap = await prisma.scrap.findFirst({
          where: { id: data.scrapId, userId: data.userId },
          select: { id: true },
        });
        if (!ownsScrap) {
          throw new Error(
            "Vínculo de sucata inválido: sucata não encontrada para este usuário",
          );
        }
      }

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
          partNumberNormalized: normalizeSku(data.partNumber),
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
          magaluCategoryId: data.magaluCategoryId ?? null,
          magaluCategorySource: data.magaluCategorySource ?? null,
          magaluCategoryChosenAt: data.magaluCategoryChosenAt ?? null,
          heightCm: data.heightCm ?? null,
          widthCm: data.widthCm ?? null,
          lengthCm: data.lengthCm ?? null,
          weightKg: data.weightKg ?? null,
          imageUrl: data.imageUrl,
          imageUrls: data.imageUrls ?? [],
          attributes: data.attributes ?? Prisma.DbNull,
          mlCatalogProductId: data.mlCatalogProductId ?? null,
          mlCatalogSnapshot:
            data.mlCatalogSnapshot == null
              ? Prisma.DbNull
              : (data.mlCatalogSnapshot as Prisma.InputJsonValue),
          scrapId: data.scrapId ?? null,
          createdFromMarketplace: data.createdFromMarketplace ?? false,
          originPlatform: data.originPlatform ?? null,
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

  // Existência por SKU sem trafegar o Product inteiro (evita as colunas JSONB
  // — attributes, mlCatalogSnapshot, imageUrls…). Usado nos checks booleanos
  // do create/getNextSku, quentes em importação. Ver findBySku.
  async existsBySku(sku: string, userId: string): Promise<boolean> {
    const item = await prisma.product.findFirst({
      where: { sku, userId },
      select: { id: true },
    });
    return item !== null;
  }

  /**
   * Tier 1 da busca: AND por termo. Cada grupo de variantes precisa casar em
   * algum dos campos indexados; ordena por score de relevância. Mantém o
   * contrato de 2 chamadas `$queryRaw` (ids + total) seguidas da hidratação.
   */
  private async runTokenSearch(params: {
    tokenGroups: string[][];
    baseSqlWhere: Prisma.Sql;
    baseWhere: Prisma.ProductWhereInput;
    skip: number;
    limit: number;
  }): Promise<{ products: Product[]; total: number }> {
    const { tokenGroups, baseSqlWhere, baseWhere, skip, limit } = params;
    const predicate = buildTokenPredicate(tokenGroups);
    const scoreExpr = buildTokenScore(tokenGroups);
    const rankedWhere = combineSqlClauses([baseSqlWhere, predicate]);

    const [rankedIds, totalRow] = await Promise.all([
      prisma.$queryRaw<{ id: string; score: number }[]>`
        SELECT p."id", (${scoreExpr}) AS score
        FROM "Product" p
        WHERE ${rankedWhere}
        ORDER BY score DESC, (p."stock" > 0) DESC, p."createdAt" DESC
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
      where: combineWhereClauses(baseWhere, { id: { in: idOrder } }),
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
  }

  /**
   * Tier 2 (fallback de recall): fuzzy legado — frase inteira via ILIKE +
   * `similarity()` trigram. Menos preciso, mas tolera digitação/vocabulário
   * fora do dicionário de sinônimos. Acionado só quando o Tier 1 não acha nada.
   */
  private async runLegacyFuzzySearch(params: {
    search: string;
    baseSqlWhere: Prisma.Sql;
    baseWhere: Prisma.ProductWhereInput;
    skip: number;
    limit: number;
  }): Promise<{ products: Product[]; total: number }> {
    const { search, baseSqlWhere, baseWhere, skip, limit } = params;
    const similarityThreshold = search.length >= 4 ? 0.22 : 0.3;
    const fuzzyPredicate = Prisma.sql`(
      immutable_unaccent(p."name") ILIKE immutable_unaccent(${`%${search}%`}) OR
      immutable_unaccent(p."sku") ILIKE immutable_unaccent(${`%${search}%`}) OR
      immutable_unaccent(lower(p."brand")) ILIKE immutable_unaccent(lower(${`%${search}%`})) OR
      immutable_unaccent(lower(p."model")) ILIKE immutable_unaccent(lower(${`%${search}%`})) OR
      immutable_unaccent(lower(p."partNumber")) ILIKE immutable_unaccent(lower(${`%${search}%`})) OR
      similarity(immutable_unaccent(p."name"), ${search}) >= ${similarityThreshold} OR
      similarity(immutable_unaccent(p."sku"), ${search}) >= ${similarityThreshold} OR
      similarity(immutable_unaccent(lower(p."brand")), immutable_unaccent(lower(${search}))) >= ${similarityThreshold} OR
      similarity(immutable_unaccent(lower(p."model")), immutable_unaccent(lower(${search}))) >= ${similarityThreshold} OR
      similarity(immutable_unaccent(lower(p."partNumber")), immutable_unaccent(lower(${search}))) >= ${similarityThreshold}
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
        ORDER BY (p."stock" > 0) DESC, p."createdAt" DESC
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
      where: combineWhereClauses(baseWhere, { id: { in: idOrder } }),
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

    // Match exato de SKU/part number para buscas que "parecem um código"
    // (numéricas como "043" ou alfanuméricas como "ABC-1"). Casamos por
    // skuNormalized/partNumberNormalized (= trim().toLowerCase(),
    // case-insensitive) E pelo sku/partNumber crus (cobrem linhas
    // antigas/importadas sem a coluna normalizada) — superset do antigo
    // `{ sku }`, então é zero-regressão. O part number ganha o MESMO
    // tratamento exato-prioritário que o SKU (antes só casava no Tier 1).
    if (search && isCodeLikeQuery(search)) {
      const normalized = normalizeSku(search);
      const whereExact = combineWhereClauses(baseWhere, {
        OR: normalized
          ? [
              { sku: search },
              { skuNormalized: normalized },
              { partNumber: search },
              { partNumberNormalized: normalized },
            ]
          : [{ sku: search }, { partNumber: search }],
      });
      const [items, total] = await Promise.all([
        prisma.product.findMany({
          where: whereExact,
          skip,
          take: limit,
          orderBy: [{ stock: "desc" }, { createdAt: "desc" }],
          select: this.productSelect,
        }),
        prisma.product.count({ where: whereExact }),
      ]);

      // Match exato de SKU tem prioridade. Mas se NÃO houver SKU exato, não
      // retorna vazio: cai para o Tier 1 abaixo (partNumber/modelo/nome) —
      // essencial para buscas numéricas de número de peça / modelo (ex.: "208").
      // O que MUDA vs. antes: um código sem match de Tier 1 NÃO cai mais no
      // fuzzy (ver guard code-like antes do Tier 2) — vira "não encontrado".
      if (total > 0) {
        return {
          products: items.map((it) =>
            mapPrismaToProduct(it as unknown as PrismaProduct),
          ),
          total,
        };
      }
    }

    if (search) {
      try {
        await this.ensureTextSearchExtensions();
        const baseSqlWhere = this.buildBaseSqlWhere(filters, userId);

        // Tier 1 — precisão: cada termo (expandido por sinônimos) deve casar
        // em algum campo (AND entre termos). É o que corrige o ruído.
        const tokenGroups = tokenizeSearch(search);
        if (tokenGroups.length > 0) {
          const tier1 = await this.runTokenSearch({
            tokenGroups,
            baseSqlWhere,
            baseWhere,
            skip,
            limit,
          });
          if (tier1.total > 0) {
            return tier1;
          }
          // total === 0 com 2+ grupos de termos: busca multi-termo sem match
          // exato (AND). NÃO cair no fuzzy de frase inteira (Tier 2) — ele
          // descarta a estrutura de termos e, com threshold frouxo (0.22),
          // traz qualquer item que só compartilhe UM termo comum (ex.: "mola
          // dianteira gol" enchia a tela de "Fechadura/Botão ... Dianteira").
          // Devolve o vazio do Tier 1 e a UI mostra o empty state.
          if (tokenGroups.length >= 2) {
            return tier1; // { products: [], total: 0 }
          }
          // 1 grupo (termo único) com total === 0 → digitação/vocábulo fora do
          // dicionário: cai para o fuzzy (recall) abaixo, tolerando "molla"→"mola".
        }

        // Buscas code-like (SKU / código) NUNCA entram no fuzzy trigram: se
        // chegaram aqui é porque não houve match exato (acima) nem no Tier 1 →
        // é um código inexistente → vazio ("produto não encontrado"), em vez
        // dos SKUs aleatórios que o similarity() de threshold frouxo trazia.
        // "208" não é afetado (casa no Tier 1 via partNumber/model); "molla"
        // não é code-like (alfabético puro) → segue para o fuzzy abaixo.
        if (isCodeLikeQuery(search)) {
          return { products: [], total: 0 };
        }

        // Tier 2 — recall: fuzzy legado (frase inteira + similarity trigram).
        // Alcançado só com 1 grupo de token alfabético (ou 0 grupos: ex.: só
        // stopword) — tolerância a digitação ("molla"→"mola").
        return await this.runLegacyFuzzySearch({
          search,
          baseSqlWhere,
          baseWhere,
          skip,
          limit,
        });
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
            { brand: { contains: search, mode: "insensitive" } },
            { model: { contains: search, mode: "insensitive" } },
            { partNumber: { contains: search, mode: "insensitive" } },
          ],
        })
      : baseWhere;

    // Ordena por (stock > 0) DESC, createdAt DESC via SQL bruto. O Prisma
    // findMany.orderBy não suporta a expressão booleana; um simples
    // { stock: "desc" } ordenaria por QUANTIDADE (estoque=5 antes de 1 antes
    // de 0), enterrando produtos recém-criados com pouco estoque abaixo de
    // produtos antigos com muito. O agrupamento booleano garante: em-estoque
    // mais novo primeiro, depois fora-de-estoque mais novo primeiro — mesma
    // regra que o caminho de busca fuzzy acima.
    try {
      const baseSqlWhere = this.buildBaseSqlWhere(filters, userId);
      const sqlWhere = search
        ? combineSqlClauses([
            baseSqlWhere,
            Prisma.sql`(p."name" ILIKE ${`%${search}%`} OR p."sku" ILIKE ${`%${search}%`} OR p."brand" ILIKE ${`%${search}%`} OR p."model" ILIKE ${`%${search}%`} OR p."partNumber" ILIKE ${`%${search}%`})`,
          ])
        : baseSqlWhere;

      const [rankedRows, totalRow] = await Promise.all([
        prisma.$queryRaw<{ id: string }[]>`
          SELECT p."id"
          FROM "Product" p
          WHERE ${sqlWhere}
          ORDER BY (p."stock" > 0) DESC, p."createdAt" DESC
          OFFSET ${skip} LIMIT ${limit};
        `,
        prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint as count
          FROM "Product" p
          WHERE ${sqlWhere};
        `,
      ]);
      const total = Number(totalRow?.[0]?.count ?? 0);
      const idOrder = rankedRows.map((r) => r.id);

      if (idOrder.length === 0) {
        return { products: [], total };
      }

      const items = await prisma.product.findMany({
        where: combineWhereClauses(baseWhere, { id: { in: idOrder } }),
        select: this.productSelect,
      });
      const itemsById = new Map(
        items.map((item) => [
          item.id,
          mapPrismaToProduct(item as unknown as PrismaProduct),
        ]),
      );

      return {
        products: idOrder
          .map((id) => itemsById.get(id))
          .filter(Boolean) as Product[],
        total,
      };
    } catch (error) {
      // Fallback de segurança: se o SQL bruto falhar por qualquer motivo,
      // cai pro findMany do Prisma ordenado por createdAt apenas. Mantém
      // "novo primeiro" e a listagem nunca quebra (perde só o "estoque 0
      // ao fim" temporariamente até o erro ser investigado).
      console.error("[product-list] fallback para findMany simples:", error);
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
        products: items.map((it) =>
          mapPrismaToProduct(it as unknown as PrismaProduct),
        ),
        total,
      };
    }
  }

  async findPublishedCategories(
    userId: string,
  ): Promise<ProductPublishedCategoryFilterOption[]> {
    // EGRESS: só precisamos dos pares distintos (conta, categoria) — não de uma
    // linha por anúncio. `distinct` vira DISTINCT ON no Postgres, cortando de
    // ~N anúncios (dezenas de milhares em contas grandes) para o nº de pares
    // distintos. A dedup/normalização em JS abaixo continua igual (a categoria
    // é determinada pela conta+categoria, então a saída é idêntica).
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
      distinct: ["marketplaceAccountId", "requestedCategoryId"],
      select: {
        marketplaceAccountId: true,
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

  async findById(
    id: string,
    userId?: string,
    // Egress (padrão perf do projeto): `rulesLite` projeta só
    // (id, name, price, costPrice) — o que as regras de bulk/escalonamento
    // consomem — em vez da row inteira (JSONBs pesados) + compatibilidades.
    // O retorno é um cast parcial: NÃO leia outros campos nesse modo.
    // Default (ausente) = comportamento histórico, byte-idêntico.
    opts?: { rulesLite?: boolean },
  ): Promise<Product | null> {
    try {
      if (opts?.rulesLite) {
        const lite = await prisma.product.findFirst({
          where: { id, ...(userId ? { userId } : {}) },
          select: { id: true, name: true, price: true, costPrice: true },
        });
        return lite ? (lite as unknown as Product) : null;
      }
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

  /**
   * Projeção EGRESS-LEAN para o preflight do bulk: só (id, shopeeCategoryId)
   * do lote inteiro numa ÚNICA query — o preflight só precisa dessa coluna, e
   * o findById traria a linha completa (JSONBs pesados) + compatibilidades em
   * N queries. Padrão perf(egress) do projeto.
   */
  async findShopeeCategoryIds(
    ids: string[],
    userId: string,
  ): Promise<Array<{ id: string; shopeeCategoryId: string | null }>> {
    if (ids.length === 0) return [];
    return prisma.product.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, shopeeCategoryId: true },
    });
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
              chassis: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          productLocation: {
            select: {
              id: true,
              code: true,
              description: true,
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
          chassis:
            (item.scrap as { chassis?: string | null }).chassis ?? undefined,
        }
      : undefined;

    const creator = (
      item as {
        user?: { id: string; name: string | null; email: string } | null;
      }
    ).user
      ? {
          id: (item as { user: { id: string } }).user.id,
          name:
            (item as { user: { name: string | null } }).user.name ?? undefined,
          email: (item as { user: { email: string } }).user.email,
        }
      : undefined;

    const productLocationSummary = (
      item as {
        productLocation?: {
          id: string;
          code: string;
          description: string | null;
        } | null;
      }
    ).productLocation
      ? {
          id: (item as { productLocation: { id: string } }).productLocation.id,
          code: (item as { productLocation: { code: string } }).productLocation
            .code,
          description:
            (item as { productLocation: { description: string | null } })
              .productLocation.description ?? undefined,
        }
      : undefined;

    return {
      product,
      detailedListings,
      recentStockChanges,
      scrapSummary,
      creator,
      productLocation: productLocationSummary,
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
          ? Array.isArray(data.compatibilities)
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
            : []
          : undefined;

      // Tenant guard do vínculo de sucata (espelha a guarda do create, linhas
      // ~877-893): scrapId novo só grava se a sucata pertencer ao MESMO
      // userId. Ausente (undefined) = não mexe; null = desvincula (sem guard).
      if (data.scrapId && userId) {
        const ownsScrap = await prisma.scrap.findFirst({
          where: { id: data.scrapId, userId },
          select: { id: true },
        });
        if (!ownsScrap) {
          throw new Error(
            "Vínculo de sucata inválido: sucata não encontrada para este usuário",
          );
        }
      }

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
        ...(data.scrapId !== undefined && { scrapId: data.scrapId }),
        ...(data.partNumber !== undefined && {
          partNumber: data.partNumber,
          partNumberNormalized: normalizeSku(data.partNumber),
        }),
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
        ...(data.magaluCategoryId !== undefined && {
          magaluCategoryId: data.magaluCategoryId,
        }),
        ...(data.magaluCategorySource !== undefined && {
          magaluCategorySource: data.magaluCategorySource,
        }),
        ...(data.magaluCategoryChosenAt !== undefined && {
          magaluCategoryChosenAt: data.magaluCategoryChosenAt as any,
        }),
        ...(data.heightCm !== undefined && { heightCm: data.heightCm }),
        ...(data.widthCm !== undefined && { widthCm: data.widthCm }),
        ...(data.lengthCm !== undefined && { lengthCm: data.lengthCm }),
        ...(data.weightKg !== undefined && { weightKg: data.weightKg }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
        ...(data.attributes !== undefined && {
          attributes:
            data.attributes === null
              ? Prisma.DbNull
              : (data.attributes as Prisma.InputJsonValue),
        }),
        ...(data.mlCatalogProductId !== undefined && {
          mlCatalogProductId: data.mlCatalogProductId,
        }),
        ...(data.mlCatalogSnapshot !== undefined && {
          mlCatalogSnapshot:
            data.mlCatalogSnapshot === null
              ? Prisma.DbNull
              : (data.mlCatalogSnapshot as Prisma.InputJsonValue),
        }),
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
      // Só produtos de origem humana entram na sequência. Anúncios auto-
      // detectados (createdFromMarketplace) trazem SKUs custom do vendedor que
      // não pertencem à numeração sequencial e inflariam o máximo.
      const rows = await prisma.product.findMany({
        where: {
          createdFromMarketplace: false,
          ...(userId ? { userId } : {}),
        },
        select: { sku: true },
      });
      return computeMaxNumericSku(rows.map((r) => r.sku));
    } catch {
      throw new Error("Erro ao buscar maior SKU");
    }
  }
}

// Limite de 6 dígitos (até 999.999): SKUs sequenciais criados pelo sistema
// nunca passam disso. Códigos longos (códigos de barra, part-numbers de
// fornecedor com 8+ dígitos) que entram via importação são ignorados para
// não inflarem a sequência automática.
const SEQUENTIAL_SKU_REGEX = /^(?:PROD-)?(\d{1,6})$/;

export function computeMaxNumericSku(
  skus: ReadonlyArray<string | null | undefined>,
): number {
  let max = 0;
  for (const sku of skus) {
    if (!sku) continue;
    const match = sku.match(SEQUENTIAL_SKU_REGEX);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (!Number.isSafeInteger(n)) continue;
    if (n > max) max = n;
  }
  return max;
}

export { ProductRepositoryPrisma };

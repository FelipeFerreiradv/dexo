import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProductUseCase } from "../usecases/product.usercase";
import {
  ProductCreate,
  ProductListFilters,
  ProductMarketplaceFilter,
  ProductPublicationStatus,
  ProductStockStatus,
  ProductUpdate,
  Quality,
} from "../interfaces/product.interface";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import {
  ListingDispatcher,
  ListingDispatchRequest,
} from "../marketplaces/services/listing-dispatcher.service";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import CategoryRepository from "../marketplaces/repositories/category.repository";
import { CategoryResolutionService } from "../marketplaces/services/category-resolution.service";
import { parseProductListingCategoryValue } from "../lib/product-listing-category";

const PUBLICATION_STATUS_VALUES = new Set<ProductPublicationStatus>([
  "ACTIVE",
  "PAUSED",
  "PENDING",
  "ERROR",
  "CLOSED",
  "NO_LISTING",
]);
const STOCK_STATUS_VALUES = new Set<ProductStockStatus>([
  "IN_STOCK",
  "OUT_OF_STOCK",
  "LOW_STOCK",
]);
const QUALITY_VALUES = new Set<Quality>([
  "SUCATA",
  "SEMINOVO",
  "NOVO",
  "RECONDICIONADO",
]);
const MARKETPLACE_VALUES = new Set<ProductMarketplaceFilter>([
  "MERCADO_LIVRE",
  "SHOPEE",
  "BOTH",
]);

function parsePositiveInteger(
  value: string | undefined,
  field: string,
  fallback: number,
) {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} inválido`);
  }

  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, field: string) {
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} inválido`);
  }

  return parsed;
}

function parseDateBoundary(
  value: string | undefined,
  field: string,
  endOfDay = false,
) {
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} inválido`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    parsed.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }

  return parsed;
}

function parseEnumValue<T extends string>(
  value: string | undefined,
  validValues: Set<T>,
  field: string,
): T | undefined {
  if (!value) return undefined;

  if (!validValues.has(value as T)) {
    throw new Error(`${field} inválido`);
  }

  return value as T;
}

export const productRoutes = async (fastify: FastifyInstance) => {
  const productUseCase = new ProductUseCase();

  /**
   * GET /products/next-sku
   * Retorna o próximo SKU disponível
   */
  fastify.get(
    "/next-sku",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const nextSku = await productUseCase.getNextSku(userId);
        return reply.status(200).send({ sku: nextSku });
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "Erro ao gerar SKU",
        });
      }
    },
  );

  fastify.get(
    "/filter-options",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const options = await productUseCase.getFilterOptions(userId);
        return reply.status(200).send(options);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao carregar opções de filtro",
        });
      }
    },
  );

  fastify.post<{ Body: ProductCreate }>(
    "/",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Body: ProductCreate }>,
      reply: FastifyReply,
    ) => {
      const {
        sku,
        name,
        description,
        stock,
        price,
        // Campos de autopeças
        costPrice,
        markup,
        brand,
        model,
        year,
        version,
        category,
        location,
        locationId,
        partNumber,
        quality,
        isSecurityItem,
        isTraceable,
        sourceVehicle,
        mlCategory,
        mlCategorySource,
        shopeeCategory,
        shopeeCategorySource,

        // Medidas / peso
        heightCm,
        widthCm,
        lengthCm,
        weightKg,

        imageUrl,
        imageUrls,
        // Sucata vinculada
        scrapId,
        // Opção para criar anúncio
        createListing,
        createListingCategoryId,
        listings,
        // Compatibilidades veiculares
        compatibilities,
      } = request.body as any;

      const user = (request as any).user;

      // Sanitize / coerce incoming numeric fields to expected types to avoid Prisma/runtime errors
      const sanitized = {
        sku: sku as string,
        name: name as string,
        description: description ?? undefined,
        stock: stock !== undefined ? Number(stock) : 0,
        price: price !== undefined ? Number(price) : 0,
        costPrice: costPrice !== undefined ? Number(costPrice) : undefined,
        markup: markup !== undefined ? Number(markup) : undefined,
        brand: brand ?? undefined,
        model: model ?? undefined,
        year: year ?? undefined,
        version: version ?? undefined,
        category: category ?? undefined,
        location: location ?? undefined,
        locationId: locationId ?? undefined,
        partNumber: partNumber ?? undefined,
        quality: quality ?? undefined,
        isSecurityItem: Boolean(isSecurityItem),
        isTraceable: Boolean(isTraceable),
        sourceVehicle: sourceVehicle ?? undefined,
        heightCm:
          heightCm !== undefined && heightCm !== null
            ? Number(heightCm)
            : undefined,
        widthCm:
          widthCm !== undefined && widthCm !== null
            ? Number(widthCm)
            : undefined,
        lengthCm:
          lengthCm !== undefined && lengthCm !== null
            ? Number(lengthCm)
            : undefined,
        weightKg:
          weightKg !== undefined && weightKg !== null
            ? Number(weightKg)
            : undefined,
        imageUrl: imageUrl ?? undefined,
        imageUrls: Array.isArray(imageUrls)
          ? imageUrls.filter((u: any) => typeof u === "string" && u.trim())
          : [],
        mlCategoryExternal: mlCategory ?? createListingCategoryId ?? undefined,
        mlCategorySource: mlCategorySource ?? undefined,
        shopeeCategory: shopeeCategory ?? undefined,
        shopeeCategorySource: shopeeCategorySource ?? undefined,
        createListing: Boolean(createListing),
        createListingCategoryId: createListingCategoryId ?? undefined,
        listings: Array.isArray(listings) ? listings : undefined,
        scrapId: typeof scrapId === "string" && scrapId ? scrapId : undefined,
        compatibilities: Array.isArray(compatibilities)
          ? compatibilities
              .filter(
                (c: any) =>
                  c &&
                  typeof c.brand === "string" &&
                  c.brand.trim() &&
                  typeof c.model === "string" &&
                  c.model.trim(),
              )
              .map((c: any) => ({
                brand: String(c.brand).trim(),
                model: String(c.model).trim(),
                yearFrom:
                  c.yearFrom === null || c.yearFrom === undefined
                    ? null
                    : Number(c.yearFrom) || null,
                yearTo:
                  c.yearTo === null || c.yearTo === undefined
                    ? null
                    : Number(c.yearTo) || null,
                version:
                  typeof c.version === "string" && c.version.trim()
                    ? c.version.trim()
                    : null,
              }))
          : undefined,
      } as const;

      // Server-side validation: reject clearly malformed requests before hitting usecase/DB
      if (!sanitized.sku || typeof sanitized.sku !== "string")
        return reply.status(400).send({ error: "SKU inválido" });
      if (!sanitized.name || typeof sanitized.name !== "string")
        return reply
          .status(400)
          .send({ error: "Nome do produto é obrigatório" });
      if (
        sanitized.price === undefined ||
        isNaN(Number(sanitized.price)) ||
        Number(sanitized.price) < 0
      )
        return reply.status(400).send({ error: "Preço inválido" });
      if (!Number.isInteger(Number(sanitized.stock)) || sanitized.stock < 0)
        return reply.status(400).send({ error: "Estoque inválido" });
      if (!sanitized.imageUrl || typeof sanitized.imageUrl !== "string")
        return reply
          .status(400)
          .send({ error: "Imagem do produto é obrigatória" });

      // Resolver categorias ML e Shopee em paralelo (OPT-5)
      let resolvedMlCategoryId: string | undefined;
      let resolvedMlCategoryPath: string | undefined;
      let resolvedMlCategorySource: "auto" | "manual" | "imported" | undefined;
      let resolvedMlCategoryChosenAt: Date | undefined;
      // Se vier categoria ML, resolver imediatamente; caso contrário, tentar extrair do payload de listings
      let mlCategoryExternalToResolve = sanitized.mlCategoryExternal;
      if (!mlCategoryExternalToResolve && sanitized.listings?.length) {
        const firstMlListing = sanitized.listings.find(
          (l) => l.platform === "MERCADO_LIVRE" && !!l.categoryId,
        );
        if (firstMlListing?.categoryId) {
          mlCategoryExternalToResolve = firstMlListing.categoryId;
        }
      }

      let resolvedShopeeCategoryId: string | undefined;
      let resolvedShopeeCategorySource:
        | "auto"
        | "manual"
        | "imported"
        | undefined;
      let resolvedShopeeCategoryChosenAt: Date | undefined;

      let shopeeCategoryExternalToResolve = sanitized.shopeeCategory;
      if (!shopeeCategoryExternalToResolve && sanitized.listings?.length) {
        const firstShopeeListing = sanitized.listings.find(
          (l: any) => l.platform === "SHOPEE" && !!l.categoryId,
        );
        if (firstShopeeListing?.categoryId) {
          shopeeCategoryExternalToResolve = firstShopeeListing.categoryId;
        }
      }

      // Run both category resolutions in parallel
      const [mlCatResult, shopeeCatResult] = await Promise.all([
        mlCategoryExternalToResolve
          ? (async () => {
              const resolved =
                await CategoryResolutionService.resolveMLCategory({
                  explicitCategoryId: mlCategoryExternalToResolve,
                  validateWithMLAPI: false,
                });
              const cat = await CategoryRepository.findByExternalId(
                resolved.externalId,
              );
              return { resolved, cat };
            })()
          : Promise.resolve(null),
        shopeeCategoryExternalToResolve
          ? (async () => {
              const externalId =
                shopeeCategoryExternalToResolve!.startsWith("SHP_")
                  ? shopeeCategoryExternalToResolve!
                  : `SHP_${shopeeCategoryExternalToResolve}`;
              const cat =
                await CategoryRepository.findByExternalId(externalId);
              return { externalId, cat };
            })()
          : Promise.resolve(null),
      ]);

      // Process ML result
      if (mlCatResult) {
        if (!mlCatResult.cat) {
          return reply.status(400).send({
            error:
              "Categoria do Mercado Livre não está sincronizada. Escolha outra ou sincronize as categorias.",
          });
        }
        resolvedMlCategoryId = mlCatResult.cat.id;
        resolvedMlCategoryPath =
          mlCatResult.resolved.fullPath ||
          mlCatResult.cat.fullPath ||
          mlCatResult.cat.name ||
          sanitized.category;
        const manualSelection = !!mlCategory;
        resolvedMlCategorySource =
          (sanitized.mlCategorySource as any) ||
          (manualSelection ? "manual" : "auto");
        resolvedMlCategoryChosenAt = new Date();
      }

      const requiresMlCategory =
        sanitized.createListing ||
        Boolean(
          sanitized.listings?.some((l) => l.platform === "MERCADO_LIVRE"),
        );
      if (requiresMlCategory && !resolvedMlCategoryId) {
        return reply.status(400).send({
          error:
            "Produto não possui categoria do Mercado Livre. Selecione uma categoria antes de criar o anúncio.",
        });
      }

      // Process Shopee result
      if (shopeeCatResult?.cat) {
        resolvedShopeeCategoryId = shopeeCatResult.externalId.replace(
          "SHP_",
          "",
        );
        resolvedShopeeCategorySource =
          (sanitized.shopeeCategorySource as any) ||
          (shopeeCategory ? "manual" : "auto");
        resolvedShopeeCategoryChosenAt = new Date();
      }

      const requiresShopeeCategory = Boolean(
        sanitized.listings?.some((l: any) => l.platform === "SHOPEE"),
      );
      if (requiresShopeeCategory && !resolvedShopeeCategoryId) {
        return reply.status(400).send({
          error:
            "Produto não possui categoria do Shopee. Selecione uma categoria antes de criar o anúncio.",
        });
      }

      try {
        const data = await productUseCase.create({
          sku: sanitized.sku,
          name: sanitized.name,
          description: sanitized.description,
          stock: sanitized.stock,
          price: sanitized.price,
          userId: user?.id,
          // Campos de autopeças
          costPrice: sanitized.costPrice,
          markup: sanitized.markup,
          brand: sanitized.brand,
          model: sanitized.model,
          year: sanitized.year,
          version: sanitized.version,
          category: resolvedMlCategoryPath || sanitized.category,
          location: sanitized.location,
          locationId: sanitized.locationId,
          partNumber: sanitized.partNumber,
          quality: sanitized.quality,
          isSecurityItem: sanitized.isSecurityItem,
          isTraceable: sanitized.isTraceable,
          sourceVehicle: sanitized.sourceVehicle,
          mlCategoryId: resolvedMlCategoryId,
          mlCategorySource: resolvedMlCategorySource,
          mlCategoryChosenAt: resolvedMlCategoryChosenAt,
          shopeeCategoryId: resolvedShopeeCategoryId,
          shopeeCategorySource: resolvedShopeeCategorySource,
          shopeeCategoryChosenAt: resolvedShopeeCategoryChosenAt,

          // Medidas / peso
          heightCm: sanitized.heightCm,
          widthCm: sanitized.widthCm,
          lengthCm: sanitized.lengthCm,
          weightKg: sanitized.weightKg,

          imageUrl: sanitized.imageUrl,
          imageUrls: sanitized.imageUrls,

          // Sucata vinculada
          scrapId: sanitized.scrapId,

          // Compatibilidades veiculares (persistidas transacionalmente pelo repositório)
          compatibilities: sanitized.compatibilities,
        });

        // Registrar log de criação do produto (fire-and-forget, non-blocking)
        const userForLog = (request as any).user;
        void SystemLogService.logProductCreate(userForLog?.id, data.id, {
          sku: data.sku,
          name: data.name,
          stock: data.stock,
          price: data.price,
        });

        // Responder imediatamente com o produto criado.
        // A criação de anúncios no ML é feita em background (fire-and-forget)
        // para não bloquear a UI do modal por 10-30 segundos.
        const wantsListing =
          (Array.isArray(listings) && listings.length > 0) ||
          (createListing && (!listings || listings.length === 0));

        if (wantsListing && user) {
          const bgListings = Array.isArray(listings) ? listings : [];
          const dispatchRequests: ListingDispatchRequest[] = [];

          for (const lst of bgListings) {
            const accounts = (lst.accountIds || []).length
              ? (lst.accountIds as (string | undefined)[])
              : [undefined];
            if (lst.platform === "MERCADO_LIVRE") {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "MERCADO_LIVRE",
                  accountId: accId,
                  categoryId: lst.categoryId || createListingCategoryId,
                  mlSettings: {
                    listingType: lst.listingType,
                    hasWarranty: lst.hasWarranty,
                    warrantyUnit: lst.warrantyUnit,
                    warrantyDuration: lst.warrantyDuration,
                    itemCondition: lst.itemCondition,
                    shippingMode: lst.shippingMode,
                    freeShipping: lst.freeShipping,
                    localPickup: lst.localPickup,
                    manufacturingTime: lst.manufacturingTime,
                  },
                });
              }
            } else if (lst.platform === "SHOPEE") {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "SHOPEE",
                  accountId: accId,
                  categoryId: lst.categoryId,
                });
              }
            }
          }

          if (createListing && dispatchRequests.length === 0) {
            dispatchRequests.push({
              platform: "MERCADO_LIVRE",
              categoryId: createListingCategoryId,
            });
          }

          if (dispatchRequests.length > 0) {
            ListingDispatcher.dispatch({
              userId: user.id as string,
              productId: data.id as string,
              requests: dispatchRequests,
            });
          }
        }

        return reply.status(201).send({
          ...data,
          listing: wantsListing
            ? {
                success: true,
                pending: true,
                message: "Anúncio sendo criado em segundo plano",
              }
            : null,
          listingsResults: [],
        });
      } catch (error: any) {
        // Log sanitized payload for debugging (non-sensitive fields only)
        try {
          console.error("[product:create] payload:", {
            sku: sanitized.sku,
            name: sanitized.name,
            price: sanitized.price,
            stock: sanitized.stock,
            category: sanitized.category,
            heightCm: sanitized.heightCm,
            widthCm: sanitized.widthCm,
            lengthCm: sanitized.lengthCm,
            weightKg: sanitized.weightKg,
          });
        } catch (logErr) {
          /* ignore */
        }

        console.error("Erro ao criar produto:", error);
        const msg = error instanceof Error ? error.message : String(error);

        // Mapear erros esperados para códigos HTTP apropriados
        if (msg.includes("Usuário não encontrado"))
          return reply.status(401).send({ error: msg });
        if (
          msg.includes("Produto com esse sku já existe") ||
          msg.includes("Unique constraint")
        )
          return reply.status(409).send({ error: msg });
        if (
          msg.match(/preço|estoque|altura|largura|comprimento|peso|inválido/i)
        )
          return reply.status(400).send({ error: msg });

        // Erro desconhecido — manter 500 mas incluir mensagem útil
        return reply
          .status(500)
          .send({ error: msg || "Erro ao criar produto" });
      }
    },
  );

  fastify.get<{
    Querystring: {
      search?: string;
      page?: string;
      limit?: string;
      createdFrom?: string;
      createdTo?: string;
      publicationStatus?: string;
      stockStatus?: string;
      priceMin?: string;
      priceMax?: string;
      listingCategory?: string;
      brand?: string;
      quality?: string;
      locationId?: string;
      marketplace?: string;
    };
  }>(
    "/",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{
        Querystring: {
          search?: string;
          page?: string;
          limit?: string;
          createdFrom?: string;
          createdTo?: string;
          publicationStatus?: string;
          stockStatus?: string;
          priceMin?: string;
          priceMax?: string;
          listingCategory?: string;
          brand?: string;
          quality?: string;
          locationId?: string;
          marketplace?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const {
          search,
          page,
          limit,
          createdFrom,
          createdTo,
          publicationStatus,
          stockStatus,
          priceMin,
          priceMax,
          listingCategory,
          brand,
          quality,
          locationId,
          marketplace,
        } = request.query;
        const userId = (request as any).user?.id as string;
        const parsedPage = parsePositiveInteger(page, "Página", 1);
        const parsedLimit = parsePositiveInteger(limit, "Limite", 10);
        const parsedCreatedFrom = parseDateBoundary(
          createdFrom,
          "Data inicial",
        );
        const parsedCreatedTo = parseDateBoundary(
          createdTo,
          "Data final",
          true,
        );
        const parsedPriceMin = parseNonNegativeNumber(priceMin, "Preço mínimo");
        const parsedPriceMax = parseNonNegativeNumber(priceMax, "Preço máximo");
        const parsedPublicationStatus = parseEnumValue(
          publicationStatus,
          PUBLICATION_STATUS_VALUES,
          "Status de publicação",
        );
        const parsedStockStatus = parseEnumValue(
          stockStatus,
          STOCK_STATUS_VALUES,
          "Status de estoque",
        );
        const parsedQuality = parseEnumValue(
          quality,
          QUALITY_VALUES,
          "Qualidade",
        );
        const parsedMarketplace = parseEnumValue(
          marketplace,
          MARKETPLACE_VALUES,
          "Marketplace",
        );
        const parsedListingCategory = parseProductListingCategoryValue(
          listingCategory,
        );

        if (listingCategory && !parsedListingCategory) {
          throw new Error("Categoria publicada invÃ¡lida");
        }

        if (
          parsedMarketplace &&
          parsedMarketplace !== "BOTH" &&
          parsedListingCategory &&
          parsedListingCategory.platform !== parsedMarketplace
        ) {
          return reply.status(400).send({
            error: "Categoria publicada nÃ£o pertence ao marketplace informado",
          });
        }

        if (
          parsedCreatedFrom &&
          parsedCreatedTo &&
          parsedCreatedFrom > parsedCreatedTo
        ) {
          return reply
            .status(400)
            .send({ error: "Data inicial deve ser menor ou igual à final" });
        }

        if (
          parsedPriceMin !== undefined &&
          parsedPriceMax !== undefined &&
          parsedPriceMin > parsedPriceMax
        ) {
          return reply
            .status(400)
            .send({ error: "Preço mínimo deve ser menor ou igual ao máximo" });
        }

        const filters: ProductListFilters & { userId: string } = {
          search: search?.trim() || "",
          page: parsedPage,
          limit: parsedLimit,
          createdFrom: parsedCreatedFrom,
          createdTo: parsedCreatedTo,
          publicationStatus: parsedPublicationStatus,
          stockStatus: parsedStockStatus,
          priceMin: parsedPriceMin,
          priceMax: parsedPriceMax,
          listingCategory: parsedListingCategory?.value,
          brand: brand?.trim() || undefined,
          quality: parsedQuality,
          locationId: locationId?.trim() || undefined,
          marketplace: parsedMarketplace,
          userId,
        };

        const data = await productUseCase.listProducts(filters);

        return reply.status(200).send({
          products: data.products,
          pagination: {
            page: parsedPage,
            limit: parsedLimit,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("inválido")
        ) {
          return reply.status(400).send({ error: error.message });
        }

        reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao listar produtos",
        });
      }
    },
  );

  /**
   * GET /products/:id
   * Retorna detalhe completo de um produto (listings enriquecidos, stock logs, sucata)
   */
  fastify.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params;
        const userId = (request as any).user?.id as string;
        const result = await productUseCase.getDetail(id, userId);

        if (!result) {
          return reply.status(404).send({ error: "Produto não encontrado" });
        }

        return reply.status(200).send(result);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar produto",
        });
      }
    },
  );

  fastify.delete(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        if (!id) {
          return reply
            .status(400)
            .send({ error: "ID do produto é obrigatório" });
        }

        const userId = (request as any).user?.id as string | undefined;
        const result = await productUseCase.delete(id, userId);

        if (!result.success) {
          return reply.status(500).send({
            error: "Erro ao excluir produto",
            message: result.message,
          });
        }

        // Registrar log de exclusão do produto (fire-and-forget, non-blocking)
        const user = (request as any).user;
        void SystemLogService.logProductDelete(user?.id, id, "Produto");

        return reply.status(200).send({
          message: result.message,
          listingResults: result.listingResults,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao excluir produto",
        });
      }
    },
  );

  fastify.put<{
    Params: { id: string };
    Body: ProductUpdate;
  }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: ProductUpdate;
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params;
        const {
          name,
          description,
          price,
          stock,
          // Campos de autopeças
          costPrice,
          markup,
          brand,
          model,
          year,
          version,
          category,
          location,
          locationId,
          partNumber,
          quality,
          isSecurityItem,
          isTraceable,
          sourceVehicle,
          mlCategory,
          mlCategorySource,
          shopeeCategory,
          shopeeCategorySource,

          // Medidas / peso
          heightCm,
          widthCm,
          lengthCm,
          weightKg,

          imageUrl,
          imageUrls,

          // Compatibilidades veiculares
          compatibilities,
        } = request.body as any;

        if (!id) {
          return reply
            .status(400)
            .send({ error: "ID do produto é obrigatório" });
        }

        if (price !== undefined && typeof price !== "number") {
          return reply.status(400).send({
            error: "Preço deve ser um número",
          });
        }

        if (stock !== undefined && !Number.isInteger(stock)) {
          return reply.status(400).send({
            error: "Estoque deve ser um número inteiro",
          });
        }

        const userId = (request as any).user?.id as string | undefined;
        // Resolver mlCategory se fornecida
        let resolvedMlCategoryId: string | undefined;
        let resolvedMlCategoryPath: string | undefined;
        let resolvedMlCategorySource:
          | "auto"
          | "manual"
          | "imported"
          | undefined;
        let resolvedMlCategoryChosenAt: Date | undefined;
        if (mlCategory) {
          const cat = await CategoryRepository.findByExternalId(mlCategory);
          if (!cat) {
            return reply.status(400).send({
              error:
                "Categoria do Mercado Livre não está sincronizada. Escolha outra ou sincronize as categorias.",
            });
          }

          // Barreira de domínio: produto veicular só pode receber categoria
          // sob a raiz 'Acessórios para Veículos' (MLB1747). Impede que
          // corrupções como mangueira → Gin voltem a ser persistidas.
          const normalizedSource = (mlCategorySource as any) || "manual";
          const hasVehicleSignals = !!(brand && model && year);
          if (
            hasVehicleSignals &&
            normalizedSource !== "imported"
          ) {
            const domainCheck =
              await CategoryResolutionService.assertWithinVehicleRoot(
                cat.externalId,
              );
            if (!domainCheck.ok && domainCheck.reason === "outside_root") {
              return reply.status(400).send({
                error: `Categoria '${cat.fullPath || cat.externalId}' está fora do nicho de autopeças. Escolha uma categoria sob 'Acessórios para Veículos'.`,
              });
            }
          }

          resolvedMlCategoryId = cat.id;
          resolvedMlCategoryPath = cat.fullPath || cat.name || category;
          resolvedMlCategorySource = normalizedSource;
          resolvedMlCategoryChosenAt = new Date();
        }

        // Resolver shopeeCategory se fornecida (paridade com fluxo de criação)
        let resolvedShopeeCategoryId: string | undefined;
        let resolvedShopeeCategorySource:
          | "auto"
          | "manual"
          | "imported"
          | undefined;
        let resolvedShopeeCategoryChosenAt: Date | undefined;
        if (shopeeCategory) {
          const externalId = shopeeCategory.startsWith("SHP_")
            ? shopeeCategory
            : `SHP_${shopeeCategory}`;
          const cat = await CategoryRepository.findByExternalId(externalId);
          if (cat) {
            resolvedShopeeCategoryId = externalId.replace("SHP_", "");
            resolvedShopeeCategorySource =
              (shopeeCategorySource as any) || "manual";
            resolvedShopeeCategoryChosenAt = new Date();
          }
        }

        const result = await productUseCase.update(
          id,
          {
            name,
            description,
            price,
            stock,
            // Campos de autopeças
            costPrice,
            markup,
            brand,
            model,
            year,
            version,
            category: resolvedMlCategoryPath || category,
            location,
            locationId,
            partNumber,
            quality,
            isSecurityItem,
            isTraceable,
            sourceVehicle,
            mlCategoryId: resolvedMlCategoryId,
            mlCategorySource: resolvedMlCategorySource,
            mlCategoryChosenAt: resolvedMlCategoryChosenAt,
            shopeeCategoryId: resolvedShopeeCategoryId,
            shopeeCategorySource: resolvedShopeeCategorySource,
            shopeeCategoryChosenAt: resolvedShopeeCategoryChosenAt,

            // Medidas / peso
            heightCm,
            widthCm,
            lengthCm,
            weightKg,

            imageUrl,
            imageUrls: Array.isArray(imageUrls) ? imageUrls : undefined,

            // Compatibilidades veiculares (persistidas atomicamente pelo repositório)
            compatibilities: Array.isArray(compatibilities)
              ? compatibilities
                  .filter(
                    (c: any) =>
                      c &&
                      typeof c.brand === "string" &&
                      c.brand.trim().length > 0 &&
                      typeof c.model === "string" &&
                      c.model.trim().length > 0,
                  )
                  .map((c: any) => ({
                    brand: c.brand.trim(),
                    model: c.model.trim(),
                    yearFrom:
                      c.yearFrom !== undefined && c.yearFrom !== null
                        ? Number(c.yearFrom)
                        : null,
                    yearTo:
                      c.yearTo !== undefined && c.yearTo !== null
                        ? Number(c.yearTo)
                        : null,
                    version:
                      typeof c.version === "string" && c.version.trim().length > 0
                        ? c.version.trim()
                        : null,
                  }))
              : undefined,
          },
          userId,
        );

        // Registrar log de atualização do produto (fire-and-forget, non-blocking)
        const user = (request as any).user;
        void SystemLogService.logProductUpdate(user?.id, id, {
          name: result.product.name,
          stock: result.product.stock,
          price: result.product.price,
        });

        return reply.status(200).send({
          ...result.product,
          syncResults: result.syncResults,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao atualizar produto",
        });
      }
    },
  );
};

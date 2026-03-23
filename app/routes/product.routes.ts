import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProductUseCase } from "../usecases/product.usercase";
import { ProductCreate, ProductUpdate } from "../interfaces/product.interface";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import { Platform } from "@prisma/client";
import CategoryRepository from "../marketplaces/repositories/category.repository";
import { CategoryResolutionService } from "../marketplaces/services/category-resolution.service";

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

        // Medidas / peso
        heightCm,
        widthCm,
        lengthCm,
        weightKg,

        imageUrl,
        imageUrls,
        // Opção para criar anúncio
        createListing,
        createListingCategoryId,
        listings,
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
        createListing: Boolean(createListing),
        createListingCategoryId: createListingCategoryId ?? undefined,
        listings: Array.isArray(listings) ? listings : undefined,
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

      // Resolver categoria do ML (externalId -> FK) de forma determinística
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

      if (mlCategoryExternalToResolve) {
        // Garante leaf e caminho completo usando ML API
        const resolved = await CategoryResolutionService.resolveMLCategory({
          explicitCategoryId: mlCategoryExternalToResolve,
          validateWithMLAPI: false,
        });

        const cat = await CategoryRepository.findByExternalId(
          resolved.externalId,
        );
        if (!cat) {
          return reply.status(400).send({
            error:
              "Categoria do Mercado Livre não está sincronizada. Escolha outra ou sincronize as categorias.",
          });
        }
        resolvedMlCategoryId = cat.id;
        resolvedMlCategoryPath =
          resolved.fullPath || cat.fullPath || cat.name || sanitized.category;
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

          // Medidas / peso
          heightCm: sanitized.heightCm,
          widthCm: sanitized.widthCm,
          lengthCm: sanitized.lengthCm,
          weightKg: sanitized.weightKg,

          imageUrl: sanitized.imageUrl,
          imageUrls: sanitized.imageUrls,
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

        // Dispara criação de listings em background (sem await)
        if (wantsListing && user) {
          const bgListings = Array.isArray(listings) ? listings : [];
          const bgCategoryId = createListingCategoryId;
          const bgUserId = user.id as string;
          const bgProductId = data.id as string;
          const bgCreateListing = createListing;

          // fire-and-forget — erros são logados mas não bloqueiam a resposta
          void (async () => {
            try {
              // Fluxo multi-contas
              if (bgListings.length > 0) {
                for (const lst of bgListings) {
                  if (lst.platform === "MERCADO_LIVRE") {
                    const accounts = (lst.accountIds || []).length
                      ? lst.accountIds
                      : [undefined];
                    for (const accId of accounts) {
                      try {
                        // Extrair configurações ML da listagem
                        const mlSettings =
                          lst.platform === "MERCADO_LIVRE"
                            ? {
                                listingType: lst.listingType,
                                hasWarranty: lst.hasWarranty,
                                warrantyUnit: lst.warrantyUnit,
                                warrantyDuration: lst.warrantyDuration,
                                itemCondition: lst.itemCondition,
                                shippingMode: lst.shippingMode,
                                freeShipping: lst.freeShipping,
                                localPickup: lst.localPickup,
                                manufacturingTime: lst.manufacturingTime,
                              }
                            : undefined;
                        await ListingUseCase.createMLListing(
                          bgUserId,
                          bgProductId,
                          lst.categoryId || bgCategoryId,
                          accId,
                          mlSettings,
                        );
                      } catch (e) {
                        console.error(
                          "[product:bg-listing] ML error:",
                          e instanceof Error ? e.message : e,
                        );
                      }
                    }
                  } else if (lst.platform === "SHOPEE") {
                    const accounts = (lst.accountIds || []).length
                      ? lst.accountIds
                      : [undefined];
                    for (const accId of accounts) {
                      try {
                        await ListingUseCase.createShopeeListing(
                          bgUserId,
                          bgProductId,
                          lst.categoryId,
                          accId,
                        );
                      } catch (e) {
                        console.error(
                          "[product:bg-listing] Shopee error:",
                          e instanceof Error ? e.message : e,
                        );
                      }
                    }
                  }
                }
              }

              // Fluxo legado
              if (bgCreateListing && bgListings.length === 0) {
                try {
                  await ListingUseCase.createMLListing(
                    bgUserId,
                    bgProductId,
                    bgCategoryId,
                  );
                } catch (e) {
                  console.error(
                    "[product:bg-listing] legacy ML error:",
                    e instanceof Error ? e.message : e,
                  );
                }
              }
            } catch (bgErr) {
              console.error("[product:bg-listing] unexpected error:", bgErr);
            }
          })();
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
    };
  }>(
    "/",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{
        Querystring: { search?: string; page?: string; limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { search, page, limit } = request.query;
        const userId = (request as any).user?.id as string;

        const data = await productUseCase.listProducts({
          search: search || "",
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 10,
          userId,
        });

        return reply.status(200).send({
          products: data.products,
          pagination: {
            page: request.query.page ? parseInt(page!) : 1,
            limit: request.query.limit ? parseInt(limit!) : 10,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao listar produtos",
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

          // Medidas / peso
          heightCm,
          widthCm,
          lengthCm,
          weightKg,

          imageUrl,
          imageUrls,
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
          resolvedMlCategoryId = cat.id;
          resolvedMlCategoryPath = cat.fullPath || cat.name || category;
          resolvedMlCategorySource = (mlCategorySource as any) || "manual";
          resolvedMlCategoryChosenAt = new Date();
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

            // Medidas / peso
            heightCm,
            widthCm,
            lengthCm,
            weightKg,

            imageUrl,
            imageUrls: Array.isArray(imageUrls) ? imageUrls : undefined,
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

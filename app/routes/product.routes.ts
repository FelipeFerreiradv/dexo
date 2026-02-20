import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProductUseCase } from "../usecases/product.usercase";
import { ProductCreate, ProductUpdate } from "../interfaces/product.interface";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { MarketplaceUseCase } from "../marketplaces/usecases/marketplace.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import { Platform } from "@prisma/client";

export const productRoutes = async (fastify: FastifyInstance) => {
  const productUseCase = new ProductUseCase();

  /**
   * GET /products/next-sku
   * Retorna o próximo SKU disponível
   */
  fastify.get(
    "/next-sku",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const nextSku = await productUseCase.getNextSku();
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
        partNumber,
        quality,
        isSecurityItem,
        isTraceable,
        sourceVehicle,

        // Medidas / peso
        heightCm,
        widthCm,
        lengthCm,
        weightKg,

        imageUrl,
        // Opção para criar anúncio
        createListing,
        createListingCategoryId,
      } = request.body;

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
        createListing: Boolean(createListing),
        createListingCategoryId: createListingCategoryId ?? undefined,
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
          category: sanitized.category,
          location: sanitized.location,
          partNumber: sanitized.partNumber,
          quality: sanitized.quality,
          isSecurityItem: sanitized.isSecurityItem,
          isTraceable: sanitized.isTraceable,
          sourceVehicle: sanitized.sourceVehicle,

          // Medidas / peso
          heightCm: sanitized.heightCm,
          widthCm: sanitized.widthCm,
          lengthCm: sanitized.lengthCm,
          weightKg: sanitized.weightKg,

          imageUrl: sanitized.imageUrl,
        });

        // Registrar log de criação do produto
        const userForLog = (request as any).user;
        await SystemLogService.logProductCreate(userForLog?.id, data.id, {
          sku: data.sku,
          name: data.name,
          stock: data.stock,
          price: data.price,
        });

        // Se solicitado, criar anúncio no ML
        let listingResult = null;
        if (createListing) {
          // Verificar se usuário está autenticado (necessário para criar anúncio)
          const userCheck = (request as any).user;
          if (!userCheck) {
            return reply.status(401).send({
              error: "Autenticação necessária",
              message: "Para criar anúncio, o usuário deve estar autenticado",
            });
          }

          try {
            // First attempt
            listingResult = await ListingUseCase.createMLListing(
              userCheck.id,
              data.id,
              createListingCategoryId,
            );

            // If attempt was skipped (e.g. account detected as vacation/restricted),
            // perform a capability re-check loop and retry a few times. This covers
            // short propagation delays when the user disables "modo férias" in Seller Center.
            if (listingResult?.skipped) {
              // If ML returned a policy-like restriction (e.g. restrictions_coliving)
              // treat as a policy issue and DO NOT perform the vacation recheck loop —
              // these require Seller Center / Mercado Livre intervention.
              const mlError =
                (listingResult as any).mlError ||
                String(listingResult.error || "");
              if (
                /restrictions_\w+/i.test(mlError) ||
                /restrictions_coliving/i.test(mlError)
              ) {
                console.debug(
                  "[product.routes] skipped due to ML policy restriction, not rechecking account:",
                  mlError,
                );
              } else {
                try {
                  const maxRechecks = 5;
                  for (
                    let attempt = 1;
                    attempt <= maxRechecks && listingResult?.skipped;
                    attempt++
                  ) {
                    try {
                      const status = await MarketplaceUseCase.getAccountStatus(
                        userCheck.id,
                        Platform.MERCADO_LIVRE,
                      );

                      console.debug(
                        `[product.routes] listing skipped — recheck ${attempt} status:`,
                        status,
                      );

                      // Retry when the account is connected and NOT restricted
                      if (status?.connected && !status?.restricted) {
                        listingResult = await ListingUseCase.createMLListing(
                          userCheck.id,
                          data.id,
                          createListingCategoryId,
                        );

                        // if create succeeded, break the loop
                        if (listingResult && listingResult.success) break;
                      }
                    } catch (recheckErr) {
                      console.debug(
                        `[product.routes] listing recheck ${attempt} failed:`,
                        recheckErr?.message || recheckErr,
                      );
                    }

                    // small backoff between rechecks
                    if (attempt < maxRechecks)
                      await new Promise((r) => setTimeout(r, attempt * 1000));
                  }
                } catch (err) {
                  console.debug(
                    "Listing retry loop failed:",
                    err?.message || err,
                  );
                }
              }
            }
          } catch (listingError) {
            console.error("Erro ao criar anúncio:", listingError);
            // Não falhar a criação do produto se o anúncio falhar
            listingResult = {
              success: false,
              error:
                listingError instanceof Error
                  ? listingError.message
                  : "Erro desconhecido",
            };
          }
        }

        return reply.status(201).send({
          ...data,
          listing: listingResult,
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
    async (
      request: FastifyRequest<{
        Querystring: { search?: string; page?: string; limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { search, page, limit } = request.query;

        const data = await productUseCase.listProducts({
          search: search || "",
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 10,
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

        const result = await productUseCase.delete(id);

        if (!result.success) {
          return reply.status(500).send({
            error: "Erro ao excluir produto",
            message: result.message,
          });
        }

        // Registrar log de exclusão do produto
        const user = (request as any).user;
        await SystemLogService.logProductDelete(user?.id, id, "Produto");

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
          partNumber,
          quality,
          isSecurityItem,
          isTraceable,
          sourceVehicle,

          // Medidas / peso
          heightCm,
          widthCm,
          lengthCm,
          weightKg,

          imageUrl,
        } = request.body;

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

        const result = await productUseCase.update(id, {
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
          partNumber,
          quality,
          isSecurityItem,
          isTraceable,
          sourceVehicle,

          // Medidas / peso
          heightCm,
          widthCm,
          lengthCm,
          weightKg,

          imageUrl,
        });

        // Registrar log de atualização do produto
        const user = (request as any).user;
        await SystemLogService.logProductUpdate(user?.id, id, {
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

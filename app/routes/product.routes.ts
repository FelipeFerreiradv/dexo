import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProductUseCase } from "../usecases/product.usercase";
import { ProductCreate, ProductUpdate } from "../interfaces/product.interface";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";

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
        imageUrl,
        // Opção para criar anúncio
        createListing,
        createListingCategoryId,
      } = request.body;
      try {
        const data = await productUseCase.create({
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
          imageUrl,
        });

        // Registrar log de criação do produto
        const user = (request as any).user;
        await SystemLogService.logProductCreate(user?.id, data.id, {
          sku: data.sku,
          name: data.name,
          stock: data.stock,
          price: data.price,
        });

        // Se solicitado, criar anúncio no ML
        let listingResult = null;
        if (createListing) {
          // Verificar se usuário está autenticado (necessário para criar anúncio)
          const user = (request as any).user;
          if (!user) {
            return reply.status(401).send({
              error: "Autenticação necessária",
              message: "Para criar anúncio, o usuário deve estar autenticado",
            });
          }

          try {
            listingResult = await ListingUseCase.createMLListing(
              user.id,
              data.id,
              createListingCategoryId,
            );
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
      } catch (error) {
        console.error("Erro ao criar produto:", error);
        throw new Error(
          error instanceof Error ? error.message : "Erro ao criar produto",
        );
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

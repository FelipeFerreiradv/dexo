import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProductUseCase } from "../usecases/product.usercase";
import { ProductCreate, ProductUpdate } from "../interfaces/product.interface";

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
        });
        return reply.status(201).send(data);
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
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        if (!id) {
          return reply
            .status(400)
            .send({ error: "ID do produto é obrigatório" });
        }

        await productUseCase.delete(id);

        return reply.status(204).send({
          message: "Produto excluído com sucesso",
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

        const data = await productUseCase.update(id, {
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
        });

        return reply.status(200).send(data);
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

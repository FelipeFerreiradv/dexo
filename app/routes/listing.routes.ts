import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";

export async function listingRoutes(app: FastifyInstance) {
  /**
   * POST /listings/ml
   * Cria um anúncio no Mercado Livre para um produto
   */
  app.post<{
    Body: {
      productId: string;
      categoryId?: string;
    };
  }>(
    "/ml",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
        const body = request.body as {
          productId: string;
          categoryId?: string;
        };

        // Validações básicas
        if (!body.productId) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "productId é obrigatório",
          });
        }

        const result = await ListingUseCase.createMLListing(
          userId,
          body.productId,
          body.categoryId,
        );

        if (!result.success) {
          // Registrar log de erro na criação de anúncio
          await SystemLogService.logSyncError(
            userId,
            "LISTING_CREATE",
            "MercadoLivre",
            result.error || "Erro desconhecido",
          );
          return reply.status(400).send({
            error: "Erro ao criar anúncio",
            message: result.error,
          });
        }

        // Registrar log de criação de anúncio
        if (result.listingId) {
          await SystemLogService.logListingCreate(
            userId,
            result.listingId,
            body.productId,
            "MercadoLivre",
          );
        }

        return reply.status(201).send({
          success: true,
          message: "Anúncio criado com sucesso",
          listingId: result.listingId,
          externalListingId: result.externalListingId,
        });
      } catch (error) {
        console.error("[Listing Routes] Error creating ML listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * PUT /listings/:id/stock
   * Atualiza o estoque de um anúncio no ML
   */
  app.put<{
    Params: { id: string };
    Body: { quantity: number };
  }>(
    "/:id/stock",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const { quantity } = request.body as { quantity: number };

        if (quantity < 0) {
          return reply.status(400).send({
            error: "Quantidade inválida",
            message: "A quantidade deve ser maior ou igual a zero",
          });
        }

        const result = await ListingUseCase.updateMLListingStock(id, quantity);

        if (!result.success) {
          return reply.status(400).send({
            error: "Erro ao atualizar estoque",
            message: result.error,
          });
        }

        return reply.status(200).send({
          success: true,
          message: "Estoque atualizado com sucesso",
        });
      } catch (error) {
        console.error("[Listing Routes] Error updating stock:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * DELETE /listings/:id
   * Remove um anúncio do ML
   */
  app.delete<{
    Params: { id: string };
  }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        const result = await ListingUseCase.removeMLListing(id);

        if (!result.success) {
          return reply.status(400).send({
            error: "Erro ao remover anúncio",
            message: result.error,
          });
        }

        return reply.status(200).send({
          success: true,
          message: "Anúncio removido com sucesso",
        });
      } catch (error) {
        console.error("[Listing Routes] Error removing listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );
}

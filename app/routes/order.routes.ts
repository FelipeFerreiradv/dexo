/**
 * Rotas para gerenciar pedidos (Orders)
 * Inclui importação do ML e listagem local
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OrderUseCase } from "../marketplaces/usecases/order.usercase";
import { orderRepository } from "../repositories/order.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";

export async function orderRoutes(app: FastifyInstance) {
  // ====================================================================
  // ROTAS DE IMPORTAÇÃO DO MERCADO LIVRE
  // ====================================================================

  /**
   * POST /orders/import
   * Importa pedidos recentes do Mercado Livre
   * Desconta estoque automaticamente para pedidos pagos
   */
  app.post<{
    Body: {
      days?: number;
      deductStock?: boolean;
    };
  }>(
    "/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
        const body = request.body as { days?: number; deductStock?: boolean };
        const days = body?.days ?? 7;
        const deductStock = body?.deductStock ?? true;

        console.log(
          `[Orders] Importing orders for user ${userId}, last ${days} days, deductStock: ${deductStock}`,
        );

        const result = await OrderUseCase.importRecentOrders(
          userId,
          days,
          deductStock,
        );

        // Registrar log de importação de pedidos (fire-and-forget, non-blocking)
        void SystemLogService.logSyncComplete(
          userId,
          "ORDER_IMPORT",
          "MercadoLivre",
          {
            imported: result.imported,
            alreadyExists: result.alreadyExists,
            errors: result.errors,
            days,
            deductStock,
          },
        );

        return reply.status(200).send({
          success: true,
          message: `Importação concluída: ${result.imported} novos pedidos`,
          ...result,
        });
      } catch (error) {
        console.error("[Orders] Import error:", error);
        return reply.status(500).send({
          error: "Erro ao importar pedidos",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  // ====================================================================
  // ROTAS DE LISTAGEM E DETALHES
  // ====================================================================

  /**
   * GET /orders
   * Lista pedidos importados do usuário
   * Suporta filtros e paginação
   */
  app.get<{
    Querystring: {
      status?: string;
      page?: string;
      limit?: string;
      search?: string;
    };
  }>(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
        const query = request.query as {
          status?: string;
          page?: string;
          limit?: string;
          search?: string;
        };

        const result = await OrderUseCase.getOrders(userId, {
          status: query.status,
          page: query.page ? parseInt(query.page, 10) : 1,
          limit: query.limit ? parseInt(query.limit, 10) : 10,
        });

        return reply.status(200).send({
          success: true,
          ...result,
        });
      } catch (error) {
        console.error("[Orders] List error:", error);
        return reply.status(500).send({
          error: "Erro ao listar pedidos",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /orders/:id
   * Obtém detalhes de um pedido específico
   */
  app.get<{
    Params: { id: string };
  }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        const order = await OrderUseCase.getOrderById(id);

        if (!order) {
          return reply.status(404).send({
            error: "Pedido não encontrado",
            message: `Pedido com ID ${id} não existe`,
          });
        }

        return reply.status(200).send({
          success: true,
          order,
        });
      } catch (error) {
        console.error("[Orders] Get by ID error:", error);
        return reply.status(500).send({
          error: "Erro ao buscar pedido",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * PATCH /orders/:id/status
   * Atualiza status de um pedido
   */
  app.patch<{
    Params: { id: string };
    Body: { status: string };
  }>(
    "/:id/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const { status } = request.body as { status: string };

        // Validar status
        const validStatuses = [
          "PENDING",
          "PAID",
          "SHIPPED",
          "DELIVERED",
          "CANCELLED",
        ];
        if (!validStatuses.includes(status)) {
          return reply.status(400).send({
            error: "Status inválido",
            message: `Status deve ser um dos seguintes: ${validStatuses.join(", ")}`,
          });
        }

        const order = await orderRepository.update(id, {
          status: status as any,
        });

        return reply.status(200).send({
          success: true,
          message: "Status atualizado com sucesso",
          order,
        });
      } catch (error) {
        console.error("[Orders] Update status error:", error);
        return reply.status(500).send({
          error: "Erro ao atualizar status",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  // ====================================================================
  // ROTAS DE ESTATÍSTICAS
  // ====================================================================

  /**
   * GET /orders/stats
   * Retorna estatísticas de pedidos do usuário
   */
  app.get(
    "/stats",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
        const prisma = (await import("../lib/prisma")).default;

        const baseWhere = { marketplaceAccount: { userId } };

        // Single groupBy + aggregate instead of 7 separate COUNT queries
        const [statusCounts, revenue] = await Promise.all([
          prisma.order.groupBy({
            by: ["status"],
            _count: { _all: true },
            where: baseWhere,
          }),
          prisma.order.aggregate({
            where: baseWhere,
            _sum: { totalAmount: true },
            _count: { _all: true },
          }),
        ]);

        const countMap: Record<string, number> = {};
        for (const row of statusCounts) {
          countMap[row.status] = row._count._all;
        }

        // Prisma returns Decimal for money fields; coerce to number safely
        const totalRevenue =
          (revenue._sum.totalAmount &&
          typeof (revenue._sum.totalAmount as any).toNumber === "function"
            ? (revenue._sum.totalAmount as any).toNumber()
            : Number(revenue._sum.totalAmount || 0)) || 0;

        return reply.status(200).send({
          success: true,
          stats: {
            total: revenue._count._all,
            pending: countMap["PENDING"] || 0,
            paid: countMap["PAID"] || 0,
            shipped: countMap["SHIPPED"] || 0,
            delivered: countMap["DELIVERED"] || 0,
            cancelled: countMap["CANCELLED"] || 0,
            totalRevenue,
          },
        });
      } catch (error) {
        console.error("[Orders] Stats error:", error);
        return reply.status(500).send({
          error: "Erro ao buscar estatísticas",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );
}

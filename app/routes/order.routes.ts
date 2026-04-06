/**
 * Rotas para gerenciar pedidos (Orders)
 * Inclui importação do ML/Shopee e listagem local
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OrderUseCase } from "../marketplaces/usecases/order.usercase";
import type { ImportOrdersResult } from "../marketplaces/usecases/order.usercase";
import { orderRepository } from "../repositories/order.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";

export async function orderRoutes(app: FastifyInstance) {
  // ====================================================================
  // ROTAS DE IMPORTAÇÃO DE PEDIDOS (ML + SHOPEE)
  // ====================================================================

  /**
   * POST /orders/import
   * Importa pedidos recentes dos marketplaces conectados
   * Aceita platform: "MERCADO_LIVRE", "SHOPEE" ou "ALL" (padrão: "ALL")
   * Desconta estoque automaticamente para pedidos pagos
   */
  app.post<{
    Body: {
      days?: number;
      deductStock?: boolean;
      platform?: string;
    };
  }>(
    "/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
        const body = request.body as {
          days?: number;
          deductStock?: boolean;
          platform?: string;
        };
        const days = body?.days ?? 7;
        const deductStock = body?.deductStock ?? true;
        const platform = (body?.platform ?? "ALL").toUpperCase();

        console.log(
          `[Orders] Importing orders for user ${userId}, platform: ${platform}, last ${days} days, deductStock: ${deductStock}`,
        );

        const importML = platform === "ALL" || platform === "MERCADO_LIVRE";
        const importShopee = platform === "ALL" || platform === "SHOPEE";

        const results: Array<{
          platform: string;
          result?: ImportOrdersResult;
          error?: string;
        }> = [];

        // Run ML and Shopee imports in parallel (independent external APIs)
        const importTasks: Array<Promise<void>> = [];

        if (importML) {
          importTasks.push(
            OrderUseCase.importRecentOrders(userId, days, deductStock)
              .then((mlResult) => {
                results.push({ platform: "MERCADO_LIVRE", result: mlResult });
                void SystemLogService.logSyncComplete(
                  userId,
                  "ORDER_IMPORT",
                  "MercadoLivre",
                  {
                    imported: mlResult.imported,
                    alreadyExists: mlResult.alreadyExists,
                    errors: mlResult.errors,
                    days,
                    deductStock,
                  },
                );
              })
              .catch((mlError) => {
                console.warn(
                  "[Orders] ML import error (non-blocking):",
                  mlError instanceof Error ? mlError.message : mlError,
                );
                results.push({
                  platform: "MERCADO_LIVRE",
                  error:
                    mlError instanceof Error
                      ? mlError.message
                      : "Erro ao importar do ML",
                });
              }),
          );
        }

        if (importShopee) {
          importTasks.push(
            OrderUseCase.importRecentShopeeOrders(
              userId,
              Math.min(days, 15), // Shopee API limita a 15 dias
              deductStock,
            )
              .then((shopeeResult) => {
                results.push({ platform: "SHOPEE", result: shopeeResult });
                void SystemLogService.logSyncComplete(
                  userId,
                  "ORDER_IMPORT",
                  "Shopee",
                  {
                    imported: shopeeResult.imported,
                    alreadyExists: shopeeResult.alreadyExists,
                    errors: shopeeResult.errors,
                    days,
                    deductStock,
                  },
                );
              })
              .catch((shopeeError) => {
                console.warn(
                  "[Orders] Shopee import error (non-blocking):",
                  shopeeError instanceof Error
                    ? shopeeError.message
                    : shopeeError,
                );
                results.push({
                  platform: "SHOPEE",
                  error:
                    shopeeError instanceof Error
                      ? shopeeError.message
                      : "Erro ao importar do Shopee",
                });
              }),
          );
        }

        await Promise.all(importTasks);

        let totalImported = 0;
        for (const r of results) {
          totalImported += r.result?.imported ?? 0;
        }

        // Agregar para manter compatibilidade com resposta anterior
        const totalOrders = results.reduce(
          (sum, r) => sum + (r.result?.totalOrders ?? 0),
          0,
        );
        const alreadyExists = results.reduce(
          (sum, r) => sum + (r.result?.alreadyExists ?? 0),
          0,
        );
        const errors = results.reduce(
          (sum, r) => sum + (r.result?.errors ?? 0),
          0,
        );

        return reply.status(200).send({
          success: true,
          message: `Importação concluída: ${totalImported} novos pedidos`,
          imported: totalImported,
          totalOrders,
          alreadyExists,
          errors,
          stockDeductions: results.reduce(
            (sum, r) => sum + (r.result?.stockDeductions ?? 0),
            0,
          ),
          results,
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
      platform?: string;
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
          platform?: string;
        };

        const result = await OrderUseCase.getOrders(userId, {
          status: query.status,
          platform: query.platform,
          search: query.search,
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
        const query = request.query as { platform?: string };
        const prisma = (await import("../lib/prisma")).default;

        const baseWhere: any = { marketplaceAccount: { userId } };
        if (query.platform) {
          baseWhere.marketplaceAccount.platform = query.platform;
        }

        // Single groupBy + aggregate instead of 7 separate COUNT queries
        const [statusCounts, revenue, platformCounts, userAccounts] = await Promise.all([
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
          // Per-platform breakdown (always unfiltered by platform)
          prisma.order.groupBy({
            by: ["marketplaceAccountId"],
            _count: { _all: true },
            _sum: { totalAmount: true },
            where: { marketplaceAccount: { userId } },
          }),
          // Fetch account→platform mapping in parallel
          prisma.marketplaceAccount.findMany({
            where: { userId },
            select: { id: true, platform: true },
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

        // Build per-platform breakdown using pre-fetched account map
        const accountPlatformMap: Record<string, string> = {};
        for (const acc of userAccounts) {
          accountPlatformMap[acc.id] = acc.platform;
        }

        const platformBreakdown: Record<string, { total: number; revenue: number }> = {};
        for (const row of platformCounts) {
          const platform = accountPlatformMap[row.marketplaceAccountId] || "UNKNOWN";
          if (!platformBreakdown[platform]) {
            platformBreakdown[platform] = { total: 0, revenue: 0 };
          }
          platformBreakdown[platform].total += row._count._all;
          const rev = row._sum.totalAmount
            ? (typeof (row._sum.totalAmount as any).toNumber === "function"
                ? (row._sum.totalAmount as any).toNumber()
                : Number(row._sum.totalAmount))
            : 0;
          platformBreakdown[platform].revenue += rev;
        }

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
            platformBreakdown,
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


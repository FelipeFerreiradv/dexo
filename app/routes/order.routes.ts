/**
 * Rotas para gerenciar pedidos (Orders)
 * Inclui importação do ML/Shopee e listagem local
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import prisma from "../lib/prisma";
import { OrderUseCase } from "../marketplaces/usecases/order.usercase";
import type { ImportOrdersResult } from "../marketplaces/usecases/order.usercase";
import { orderRepository } from "../repositories/order.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import { ShippingLabelUseCase } from "../marketplaces/usecases/shipping-label.usecase";
import {
  ShippingLabelError,
  type LabelSize,
} from "../marketplaces/shipping/shipping-label.types";

/** Mapeia o code de ShippingLabelError para um status HTTP legível. */
function shippingErrorStatus(code?: string): number {
  switch (code) {
    case "ORDER_NOT_FOUND":
      return 404;
    case "NFE_NOT_FOUND":
    case "NFE_HOMOLOGACAO":
    case "NFE_XML_MISSING":
    case "NOT_READY":
    case "SHIPMENT_NOT_FOUND":
      return 409;
    case "UNSUPPORTED_PLATFORM":
      return 400;
    case "PROVIDER_ERROR":
      return 502;
    default:
      return 500;
  }
}

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
        const userId = request.user!.dataOwnerId;
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
        const importMagalu = platform === "ALL" || platform === "MAGALU";

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

        if (importMagalu) {
          importTasks.push(
            OrderUseCase.importRecentMagaluOrders(userId, days, deductStock)
              .then((magaluResult) => {
                results.push({ platform: "MAGALU", result: magaluResult });
                void SystemLogService.logSyncComplete(
                  userId,
                  "ORDER_IMPORT",
                  "Magalu",
                  {
                    imported: magaluResult.imported,
                    alreadyExists: magaluResult.alreadyExists,
                    errors: magaluResult.errors,
                    // Descarte por status deixou de ser mudo: se a API mudar o
                    // vocabulario, e aqui que aparece antes de virar "sumiu
                    // uma venda".
                    skippedByStatus: magaluResult.skippedByStatus ?? 0,
                    skippedStatuses: magaluResult.skippedStatuses ?? [],
                    days,
                    deductStock,
                  },
                );
              })
              .catch((magaluError) => {
                console.warn(
                  "[Orders] Magalu import error (non-blocking):",
                  magaluError instanceof Error
                    ? magaluError.message
                    : magaluError,
                );
                results.push({
                  platform: "MAGALU",
                  error:
                    magaluError instanceof Error
                      ? magaluError.message
                      : "Erro ao importar da Magalu",
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
      dateFrom?: string;
      dateTo?: string;
      amountMin?: string;
      amountMax?: string;
    };
  }>(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const query = request.query as {
          status?: string;
          page?: string;
          limit?: string;
          search?: string;
          platform?: string;
          dateFrom?: string;
          dateTo?: string;
          amountMin?: string;
          amountMax?: string;
        };

        // Datas (YYYY-MM-DD) → início/fim do dia, inclusivo. Inválidas ⇒ ignoradas
        // (no-op). Parâmetro ausente mantém o comportamento de hoje.
        const parseDay = (value: string | undefined, endOfDay: boolean) => {
          if (!value) return undefined;
          const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
            ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`
            : value;
          const d = new Date(iso);
          return Number.isNaN(d.getTime()) ? undefined : d;
        };
        // Valores monetários (string) → number; NaN/vazio ⇒ ignorado (no-op).
        const parseAmount = (value: string | undefined) => {
          if (value === undefined || value === "") return undefined;
          const n = Number(value);
          return Number.isFinite(n) ? n : undefined;
        };

        const result = await OrderUseCase.getOrders(userId, {
          status: query.status,
          platform: query.platform,
          search: query.search,
          page: query.page ? parseInt(query.page, 10) : 1,
          limit: query.limit ? parseInt(query.limit, 10) : 10,
          dateFrom: parseDay(query.dateFrom, false),
          dateTo: parseDay(query.dateTo, true),
          amountMin: parseAmount(query.amountMin),
          amountMax: parseAmount(query.amountMax),
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
        const userId = request.user!.dataOwnerId;

        const order = await OrderUseCase.getOrderById(id, userId);

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
        const userId = request.user!.dataOwnerId;
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

        // ADITIVO (cancelamento/reativação): transições envolvendo CANCELLED
        // movem estoque e são feitas ATOMICAMENTE pelos handlers (claim de
        // status na MESMA tx do estorno/re-dedução) — aqui os handlers são os
        // ÚNICOS escritores de status; o update final roda SEM status (só
        // relê o pedido para a resposta, com a mesma checagem de posse e o
        // mesmo shape de hoje), para nunca atropelar uma transição
        // concorrente (webhook de cancelamento, outro PATCH). A transição
        // simples (sem CANCELLED de nenhum lado) vira write CONDICIONAL no
        // status sondado — corrida com cancelamento concorrente responde 409
        // em vez de sobrescrever o estorno. Handler com falha ⇒ 5xx SEM
        // escrever o status (rollback manteve estado consistente).
        // Kill-switch ORDER_CANCEL_RESTORE_DISABLED=1 restaura o caminho
        // atual byte-idêntico.
        let statusHandled = false;
        if (process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1") {
          const owned = await prisma.order.findFirst({
            where: { id, marketplaceAccount: { userId } },
            select: {
              status: true,
              externalOrderId: true,
              marketplaceAccountId: true,
              marketplaceAccount: { select: { platform: true } },
            },
          });
          if (owned) {
            const platformLabel =
              owned.marketplaceAccount.platform === "SHOPEE"
                ? ("Shopee" as const)
                : owned.marketplaceAccount.platform === "MAGALU"
                  ? ("Magalu" as const)
                  : ("ML" as const);

            if (status === "CANCELLED") {
              const cancel = await OrderUseCase.processOrderCancellation({
                marketplaceAccountId: owned.marketplaceAccountId,
                externalOrderId: owned.externalOrderId,
                platformLabel,
                logPrefix: "[Orders]",
              });
              if (!cancel.success) {
                // CANCELLED sem estorno seria estado terminal inconsistente.
                return reply.status(500).send({
                  error: "Erro ao atualizar status",
                  message:
                    cancel.message ??
                    "Falha ao estornar o estoque do pedido cancelado",
                });
              }
              statusHandled = true;
            } else if (owned.status === "CANCELLED") {
              // Un-cancel: re-deduz o que o cancelamento estornou.
              // CANCELLED→PENDING é bloqueado (PENDING por invariante não
              // tem baixa; write puro deixaria estoque inflado se depois
              // virasse PAID).
              if (status === "PENDING") {
                return reply.status(400).send({
                  error: "Transição inválida",
                  message:
                    "Pedido cancelado não pode voltar para PENDING. Reative-o para PAID para re-deduzir o estoque.",
                });
              }
              const uncancel = await OrderUseCase.processOrderUncancellation({
                marketplaceAccountId: owned.marketplaceAccountId,
                externalOrderId: owned.externalOrderId,
                platformLabel,
                targetStatus: status as "PAID" | "SHIPPED" | "DELIVERED",
                logPrefix: "[Orders]",
              });
              if (!uncancel.success) {
                return reply.status(500).send({
                  error: "Erro ao atualizar status",
                  message:
                    uncancel.message ??
                    "Falha ao re-deduzir o estoque do pedido reativado",
                });
              }
              statusHandled = true;
            } else {
              // Transição simples: write condicionado ao status sondado.
              const claimed = await prisma.order.updateMany({
                where: {
                  id,
                  status: owned.status,
                  marketplaceAccount: { userId },
                },
                data: { status: status as any },
              });
              if (claimed.count === 0) {
                return reply.status(409).send({
                  error: "Conflito de status",
                  message:
                    "O pedido mudou de status durante a atualização. Recarregue e tente novamente.",
                });
              }
              statusHandled = true;
            }
          }
        }

        const order = await orderRepository.update(
          id,
          statusHandled ? {} : { status: status as any },
          userId,
        );

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
        const userId = request.user!.dataOwnerId;
        const query = request.query as { platform?: string };
        const prisma = (await import("../lib/prisma")).default;

        const baseWhere: any = { marketplaceAccount: { userId } };
        if (query.platform) {
          baseWhere.marketplaceAccount.platform = query.platform;
        }

        // Single groupBy + aggregate instead of 7 separate COUNT queries
        const [statusCounts, revenue, platformCounts, userAccounts] =
          await Promise.all([
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

        const platformBreakdown: Record<
          string,
          { total: number; revenue: number }
        > = {};
        for (const row of platformCounts) {
          const platform =
            accountPlatformMap[row.marketplaceAccountId] || "UNKNOWN";
          if (!platformBreakdown[platform]) {
            platformBreakdown[platform] = { total: 0, revenue: 0 };
          }
          platformBreakdown[platform].total += row._count._all;
          const rev = row._sum.totalAmount
            ? typeof (row._sum.totalAmount as any).toNumber === "function"
              ? (row._sum.totalAmount as any).toNumber()
              : Number(row._sum.totalAmount)
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

  // ====================================================================
  // ROTAS DE ETIQUETA DE ENVIO (módulo aditivo — ML + Shopee)
  // ====================================================================

  /**
   * POST /orders/:id/shipping-label
   * Orquestra o fluxo: envia a NF-e ao marketplace → aguarda liberação →
   * gera/baixa a etiqueta. Idempotente (reaproveita etiqueta já gerada).
   * Body: { size?: "A4" | "THERMAL" } (default A4).
   */
  app.post<{
    Params: { id: string };
    Body: { size?: string };
  }>(
    "/:id/shipping-label",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const userId = request.user!.dataOwnerId;
        const body = request.body as { size?: string };
        const size: LabelSize = body?.size === "THERMAL" ? "THERMAL" : "A4";

        const result = await ShippingLabelUseCase.generateLabelForOrder(
          userId,
          id,
          size,
        );

        return reply.status(200).send({
          success: true,
          reused: result.reused,
          labelStatus: result.record.labelStatus,
          labelSize: result.record.labelSize,
          trackingNumber: result.record.trackingNumber,
          labelPdfUrl: `/orders/${id}/shipping-label`,
        });
      } catch (error) {
        if (error instanceof ShippingLabelError) {
          return reply.status(shippingErrorStatus(error.code)).send({
            error: "Não foi possível gerar a etiqueta",
            code: error.code,
            message: error.message,
          });
        }
        console.error("[Orders] Shipping label error:", error);
        return reply.status(500).send({
          error: "Erro ao gerar etiqueta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /orders/:id/shipping-label
   * Faz stream do PDF da etiqueta já gerada (application/pdf). 404 se não houver.
   */
  app.get<{
    Params: { id: string };
  }>(
    "/:id/shipping-label",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const userId = request.user!.dataOwnerId;

        const stored = await ShippingLabelUseCase.getStoredLabelPdf(userId, id);
        if (!stored) {
          return reply.status(404).send({
            error: "Etiqueta não encontrada",
            message: "Gere a etiqueta antes de baixar.",
          });
        }

        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `inline; filename="etiqueta-${id}.pdf"`,
          )
          .send(stored.pdf);
      } catch (error) {
        if (error instanceof ShippingLabelError) {
          return reply.status(shippingErrorStatus(error.code)).send({
            error: "Não foi possível baixar a etiqueta",
            code: error.code,
            message: error.message,
          });
        }
        console.error("[Orders] Shipping label download error:", error);
        return reply.status(500).send({
          error: "Erro ao baixar etiqueta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /orders/shipping-labels/batch
   * Gera as etiquetas de vários pedidos e devolve UM PDF combinado (base64).
   * Pedidos com erro voltam em `failures[]` sem derrubar o lote.
   * Body: { orderIds: string[], size?: "A4" | "THERMAL" }.
   */
  app.post<{
    Body: { orderIds?: string[]; size?: string };
  }>(
    "/shipping-labels/batch",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const body = request.body as { orderIds?: string[]; size?: string };
        const orderIds = Array.isArray(body?.orderIds)
          ? body.orderIds.filter((id) => typeof id === "string")
          : [];
        if (orderIds.length === 0) {
          return reply
            .status(400)
            .send({ error: "Nenhum pedido selecionado" });
        }
        const size: LabelSize = body?.size === "THERMAL" ? "THERMAL" : "A4";

        const result = await ShippingLabelUseCase.generateLabelsBatch(
          userId,
          orderIds,
          size,
        );

        if (!result.pdf || result.count === 0) {
          return reply.status(409).send({
            error: "Nenhuma etiqueta foi gerada",
            count: 0,
            failures: result.failures,
          });
        }

        return reply.status(200).send({
          success: true,
          count: result.count,
          failures: result.failures,
          pdfBase64: result.pdf.toString("base64"),
        });
      } catch (error) {
        console.error("[Orders] Shipping labels batch error:", error);
        return reply.status(500).send({
          error: "Erro ao gerar etiquetas em lote",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );
}

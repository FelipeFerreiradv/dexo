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
import { OrderIngestionReconcilerService } from "../marketplaces/services/order-ingestion-reconciler.service";
import {
  ShippingLabelError,
  type LabelSize,
} from "../marketplaces/shipping/shipping-label.types";

/** Mapeia o code de ShippingLabelError para um status HTTP legível. */
/**
 * Payload de erro do módulo de etiqueta.
 *
 * ADITIVO: `error` e `message` continuam exatamente onde estavam — o front
 * antigo segue funcionando. O que entra é `code` (já existia no POST), `step`,
 * `provider` e `correlationId`, para o suporte correlacionar com o log sem
 * pedir print de tela.
 */
function shippingErrorPayload(
  error: ShippingLabelError,
  correlationId: string,
  title = "Não foi possível gerar a etiqueta",
): Record<string, unknown> {
  return {
    error: title,
    code: error.code,
    message: error.message,
    correlationId,
  };
}

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

/**
 * Texto em português claro para o cliente. O `reason` é vocabulário interno;
 * quem lê a tela precisa saber O QUE fazer, não o nome do enum.
 */
function descreveMotivo(reason: string): string {
  switch (reason) {
    case "NO_LINKED_ITEMS":
      return "O anúncio vendido não está vinculado a nenhum produto do seu estoque.";
    case "PARTIAL_LINK":
      return "Parte dos itens deste pedido não está vinculada a produtos do seu estoque — esses itens não baixaram estoque.";
    case "PRODUCT_NOT_FOUND":
      return "O SKU do anúncio vendido não corresponde a nenhum produto do seu estoque.";
    case "ITEM_WITHOUT_SKU":
      return "O anúncio vendido está sem SKU no marketplace e não está vinculado a um produto.";
    case "STOCK_DEDUCTION_FAILED":
      return "O pedido entrou, mas a baixa de estoque falhou. Estamos tentando novamente.";
    case "FETCH_FAILED":
      return "Não conseguimos buscar este pedido no marketplace.";
    case "UNKNOWN_STATUS":
      return "Este pedido está num status que ainda não sabemos tratar.";
    case "INGEST_FAILED":
      return "Houve uma falha inesperada ao importar este pedido. Estamos tentando novamente.";
    default:
      return "Este pedido não pôde ser importado por completo.";
  }
}

/**
 * Texto em português claro para o operador. O `reason` é vocabulário interno;
 * quem lê a tela precisa saber O QUE decidir, não o nome do enum.
 */
function descreveMotivoDevolucao(reason: string): string {
  switch (reason) {
    case "PECA_COM_COMPRADOR":
      return "A peça foi ENTREGUE ao comprador e o pedido virou devolução ou reclamação. Ela só volta ao estoque quando chegar de volta ao pátio.";
    case "PECA_EM_TRANSITO":
      return "A peça saiu do pátio e não está com o comprador: em trânsito de volta, extraviada ou avariada.";
    case "DEVOLVIDA_CONFIRMADA_ML":
      return "O marketplace registrou a devolução como concluída. Confira a peça na prateleira e confirme o recebimento.";
    case "SHOPEE_TO_RETURN":
      return "O comprador abriu devolução na Shopee sobre um pedido já enviado. Confirme se a peça voltou.";
    case "ML_PARTIALLY_REFUNDED":
      return "Houve reembolso parcial neste pedido. Nada foi alterado no estoque — decida o que fazer com a peça.";
    default:
      return "A peça deste pedido não está no pátio. Confirme onde ela está.";
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

        // OLX and FACEBOOK have no order/checkout API in Brazil — reject explicit requests.
        if (platform === "OLX" || platform === "FACEBOOK") {
          return reply.status(400).send({
            success: false,
            error: "Plataforma sem API de pedidos",
            message: `${platform} não possui API de pedidos no Brasil. Pedidos dessas plataformas não podem ser importados.`,
            platform,
          });
        }

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
   * GET /orders/ingestion-issues
   * Pendências de importação ABERTAS do tenant.
   *
   * Existe porque um pedido que o Dexo não conseguiu ingerir por completo
   * precisa ser visível para quem pode resolver — antes ele sumia sem deixar
   * rastro na tela. Declarada antes de `/:id` por legibilidade (o roteador do
   * Fastify já prioriza segmento estático sobre parâmetro).
   */
  app.get(
    "/ingestion-issues",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;

        const filtro = {
          // NEEDS_ACTION entra junto: a pendencia saiu da fila de re-tentativa
          // automatica, mas NAO sai da tela — quem a fecha e o cliente
          // cadastrando o produto que falta.
          status: { in: ["OPEN", "NEEDS_ACTION"] },
          marketplaceAccount: { userId },
        };

        // `total` tem que ser o total REAL, não o tamanho da página: em produção
        // um tenant já apareceu com 57 pendências e outro com 26, e o aviso na
        // tela diria "100" para sempre a partir daí (auditoria 29/07/2026).
        const total = await (prisma as any).orderIngestionIssue.count({
          where: filtro,
        });

        const issues = await (prisma as any).orderIngestionIssue.findMany({
          where: filtro,
          // Mais ANTIGAS primeiro: são as que já esgotaram tentativas e
          // precisam de gente. Com `desc` e o teto de 100, as antigas eram
          // justamente as que sumiam da única tela onde o cliente as vê.
          orderBy: { createdAt: "asc" },
          take: 100,
          select: {
            id: true,
            platform: true,
            externalOrderId: true,
            reason: true,
            detail: true,
            attempts: true,
            nextRetryAt: true,
            createdAt: true,
            status: true,
            marketplaceAccount: { select: { accountName: true } },
          },
        });

        return reply.status(200).send({
          success: true,
          issues: issues.map((i: any) => ({
            id: i.id,
            platform: i.platform,
            externalOrderId: i.externalOrderId,
            reason: i.reason,
            motivo: descreveMotivo(i.reason),
            // `true` quando ja nao ha nada que o sistema possa fazer sozinho: a
            // tela precisa dizer isso, senao o cliente espera por uma
            // re-tentativa que nao vem mais.
            precisaAcao: i.status === "NEEDS_ACTION",
            detail: i.detail,
            attempts: i.attempts,
            nextRetryAt: i.nextRetryAt,
            createdAt: i.createdAt,
            accountName: i.marketplaceAccount?.accountName ?? null,
          })),
          total,
          // Sem isto a tela não teria como avisar que existem pendências fora
          // da página — silenciar o corte é o que o invariante proíbe.
          exibidas: issues.length,
        });
      } catch (error) {
        console.error("[Orders] Ingestion issues error:", error);
        return reply.status(500).send({
          error: "Erro ao buscar pendências de importação",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /orders/return-pendencies
   * Devoluções em que a peça saiu do pátio e o estoque ficou (corretamente)
   * sem voltar. Cada linha é uma pergunta para o operador: a peça voltou?
   *
   * Escopo de tenant pela conta de marketplace, igual à listagem irmã — nunca
   * por id cru. Mesma regra de `total` vs `exibidas`: silenciar o corte da
   * página é o que o invariante proíbe.
   */
  app.get(
    "/return-pendencies",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;

        const filtro = {
          status: { in: ["OPEN", "NEEDS_ACTION"] },
          marketplaceAccount: { userId },
        };

        const total = await (prisma as any).orderReturnPendency.count({
          where: filtro,
        });

        const pendencias = await (prisma as any).orderReturnPendency.findMany({
          where: filtro,
          // Mais ANTIGAS primeiro, mesmo motivo da listagem irmã: são as que
          // estão paradas há mais tempo e as que somem com um teto de página.
          orderBy: { createdAt: "asc" },
          take: 100,
          select: {
            id: true,
            platform: true,
            externalOrderId: true,
            reason: true,
            detail: true,
            status: true,
            createdAt: true,
            marketplaceAccount: { select: { accountName: true } },
          },
        });

        return reply.status(200).send({
          success: true,
          pendencies: pendencias.map((p: any) => ({
            id: p.id,
            platform: p.platform,
            externalOrderId: p.externalOrderId,
            reason: p.reason,
            motivo: descreveMotivoDevolucao(p.reason),
            detail: p.detail,
            precisaAcao: p.status === "NEEDS_ACTION",
            createdAt: p.createdAt,
            accountName: p.marketplaceAccount?.accountName ?? null,
          })),
          total,
          exibidas: pendencias.length,
        });
      } catch (error) {
        console.error("[Orders] Return pendencies error:", error);
        return reply.status(500).send({
          error: "Erro ao buscar devoluções pendentes",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /orders/return-pendencies/:id/resolve
   * O operador diz se a peça voltou. É o ÚNICO caminho pelo qual o estoque
   * volta depois de uma devolução.
   *
   * Escopa por tenant ANTES de agir (mesmo padrão do retry de ingestão): a
   * pendência é buscada com `marketplaceAccount: { userId }`, nunca por id cru.
   */
  app.post(
    "/return-pendencies/:id/resolve",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { id } = request.params as { id: string };
        const { outcome } = (request.body || {}) as { outcome?: string };

        if (outcome !== "RECEBIDA" && outcome !== "NAO_RECEBIDA") {
          return reply.status(400).send({
            error: "Desfecho inválido",
            message:
              "Informe se a peça voltou ao pátio: RECEBIDA ou NAO_RECEBIDA.",
          });
        }

        const pendencia = await (prisma as any).orderReturnPendency.findFirst({
          where: { id, marketplaceAccount: { userId } },
          select: { id: true, marketplaceAccountId: true, externalOrderId: true },
        });
        if (!pendencia) {
          return reply.status(404).send({
            error: "Devolução não encontrada",
            message: "A pendência não existe ou não pertence a esta conta.",
          });
        }

        const resultado = await OrderUseCase.resolveReturnPendency({
          marketplaceAccountId: pendencia.marketplaceAccountId,
          externalOrderId: pendencia.externalOrderId,
          outcome,
          userId,
          resolvedByUserId: request.user!.id,
          logPrefix: "[Orders]",
        });

        if (!resultado.success) {
          return reply.status(resultado.action === "not_found" ? 404 : 500).send({
            error: "Não foi possível registrar o desfecho",
            message: resultado.message ?? "Erro desconhecido",
          });
        }

        return reply.status(200).send({
          success: true,
          action: resultado.action,
          restoredItems: resultado.restoredItems,
        });
      } catch (error) {
        console.error("[Orders] Resolve return pendency error:", error);
        return reply.status(500).send({
          error: "Erro ao registrar o desfecho da devolução",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /orders/ingestion-issues/:id/retry
   * Re-tenta AGORA uma pendência específica, sem esperar o worker.
   */
  app.post<{ Params: { id: string } }>(
    "/ingestion-issues/:id/retry",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const userId = request.user!.dataOwnerId;

        // Escopo por tenant ANTES de agir: nunca re-tentar pendência alheia.
        const issue = await (prisma as any).orderIngestionIssue.findFirst({
          where: { id, marketplaceAccount: { userId } },
          select: { id: true },
        });

        if (!issue) {
          return reply.status(404).send({
            error: "Pendência não encontrada",
            message: `Pendência com ID ${id} não existe`,
          });
        }

        const { resolved } = await OrderIngestionReconcilerService.retryOne(id);

        return reply.status(200).send({
          success: true,
          resolved,
          message: resolved
            ? "Pedido importado com sucesso."
            : "Ainda não foi possível importar este pedido. Continuaremos tentando.",
        });
      } catch (error) {
        console.error("[Orders] Ingestion issue retry error:", error);
        return reply.status(500).send({
          error: "Erro ao re-tentar a importação",
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
                  : owned.marketplaceAccount.platform === "OLX"
                    ? ("OLX" as const)
                    : owned.marketplaceAccount.platform === "FACEBOOK"
                      ? ("FACEBOOK" as const)
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
          return reply
            .status(shippingErrorStatus(error.code))
            .send(shippingErrorPayload(error, request.id));
        }
        console.error("[Orders] Shipping label error:", error);
        return reply.status(500).send({
          error: "Erro ao gerar etiqueta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
          correlationId: request.id,
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
          return reply
            .status(shippingErrorStatus(error.code))
            .send(
              shippingErrorPayload(
                error,
                request.id,
                "Não foi possível baixar a etiqueta",
              ),
            );
        }
        console.error("[Orders] Shipping label download error:", error);
        return reply.status(500).send({
          error: "Erro ao baixar etiqueta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
          correlationId: request.id,
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
          return reply.status(400).send({ error: "Nenhum pedido selecionado" });
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

import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import {
  MLOrderWebhookPayload,
  MLItemWebhookPayload,
} from "../types/ml-order.types";
import { MLQuestionWebhookPayload } from "../types/ml-questions.types";
import { MagaluOrderWebhookPayload } from "../types/magalu-order.types";
import { OrderUseCase } from "./order.usercase";
import { MessagesUseCase } from "./messages.usecase";
import { ListingAutodetectUseCase } from "./listing-autodetect.usercase";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { SystemLogService } from "@/app/services/system-log.service";

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;

/**
 * Garante um accessToken ML válido para a conta, refrescando se estiver perto de
 * expirar. Mantida local (sem import cruzado) espelhando messages.usecase.ts.
 */
async function ensureFreshMLToken(account: {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}): Promise<string> {
  const expiresMs = new Date(account.expiresAt).getTime();
  if (
    Number.isFinite(expiresMs) &&
    expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
  await MarketplaceRepository.updateTokens(account.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
  });
  return refreshed.accessToken;
}

/**
 * Token Shopee fresco. Não expirado ⇒ token atual; expirado com refresh ⇒
 * renova+persiste (precisa do shopId); falha ⇒ null. Mantida local (sem
 * import cruzado) espelhando messages.usecase.ts.
 */
async function ensureFreshShopeeToken(account: {
  id: string;
  shopId: number | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}): Promise<string | null> {
  if (!account.accessToken || !account.shopId) return null;
  const expiresMs = account.expiresAt
    ? new Date(account.expiresAt).getTime()
    : 0;
  if (
    Number.isFinite(expiresMs) &&
    expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    return account.accessToken;
  }
  if (!account.refreshToken) return account.accessToken;
  try {
    const refreshed = await ShopeeOAuthService.refreshAccessToken(
      account.refreshToken,
      account.shopId,
    );
    await MarketplaceRepository.updateTokens(account.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
    });
    return refreshed.access_token;
  } catch (err) {
    console.warn(
      `[WebhookUseCase] Falha ao refrescar token Shopee da conta ${account.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Tenta registrar o evento no WebhookEventLog para garantir idempotência.
 * Retorna `true` se o evento é novo (deve ser processado),
 * `false` se já foi processado anteriormente (P2002 na unique key).
 */
async function claimWebhookEvent(
  source: string,
  externalId: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await (prisma as any).webhookEventLog.create({
      data: { source, externalId, payload: payload as any },
    });
    return true;
  } catch (err: any) {
    if (err?.code === "P2002") return false;
    throw err;
  }
}

/**
 * Use Case para processar webhooks do Mercado Livre e Shopee
 * Responsável por:
 * 1. Validar webhook payload
 * 2. Identificar usuário através da conta do marketplace
 * 3. Processar notificações de pedidos automaticamente
 */
export class WebhookUseCase {
  /**
   * Processa webhook de pedido do Mercado Livre
   * Identifica a conta ML via user_id e importa pedidos recentes da conta
   */
  static async processOrderWebhook(payload: MLOrderWebhookPayload): Promise<{
    success: boolean;
    userId?: string;
    orderId?: string;
    action?: string;
    error?: string;
  }> {
    try {
      // Extrair orderId do resource (formato: "/orders/123456789")
      const orderIdMatch = payload.resource.match(/^\/orders\/(\d+)$/);
      if (!orderIdMatch) {
        return {
          success: false,
          error: `Formato de resource inválido: ${payload.resource}`,
        };
      }

      const mlOrderId = orderIdMatch[1];

      // Idempotência: ignorar entregas duplicadas do mesmo evento ML.
      // Chave = resource + user_id + sent (ML reentrega com mesmo sent em retries).
      const dedupKey = `${payload.resource}:${payload.user_id}:${payload.sent}`;
      const isNew = await claimWebhookEvent("ML", dedupKey, payload);
      if (!isNew) {
        return {
          success: true,
          orderId: mlOrderId,
          action: "duplicate_ignored",
        };
      }

      const accounts = await MarketplaceRepository.findAllByExternalUserId(
        payload.user_id.toString(),
        Platform.MERCADO_LIVRE,
        true,
      );

      if (accounts.length === 0) {
        void SystemLogService.logWarning(
          "WEBHOOK_ACCOUNT_NOT_FOUND",
          `Webhook ML ignorado: conta não encontrada para user_id=${payload.user_id}. Pedidos podem estar sendo perdidos.`,
          {
            resource: "MarketplaceAccount",
            details: {
              externalUserId: payload.user_id.toString(),
              platform: "MERCADO_LIVRE",
              mlOrderId,
            },
          },
        ).catch(() => {});
        return {
          success: false,
          error: `Conta do Mercado Livre não encontrada para user_id: ${payload.user_id}`,
        };
      }

      if (accounts.length > 1) {
        return {
          success: false,
          error: `Múltiplas contas ativas do Mercado Livre encontradas para user_id: ${payload.user_id}. Resolva a duplicidade antes de processar webhooks.`,
        };
      }

      const [account] = accounts;

      if (account.status !== "ACTIVE") {
        return {
          success: false,
          error: `Conta do Mercado Livre não está ativa (status: ${account.status})`,
        };
      }

      const importResult = await OrderUseCase.importRecentOrdersForAccount(
        account.id,
        1,
        true,
      );

      // ADITIVO (cancelamento): o payload ML não traz status (só o resource);
      // a verdade é o fetch da API. Best-effort em try/catch próprio — falha
      // aqui não altera o retorno do webhook. Gates de custo: pedido recém-
      // importado NESTE re-poll acabou de vir da API como paid ⇒ não está
      // cancelado, pula o fetch; pedido inexistente ou já CANCELLED idem.
      // O poll ML filtra status=paid, então cancelamento nunca chega pelo
      // re-poll acima — este fetch pontual é o único detector ML.
      if (process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1") {
        try {
          const justImported = importResult.results.some(
            (r) => r.externalOrderId === mlOrderId && r.status === "imported",
          );
          const localOrder = justImported
            ? null
            : await prisma.order.findFirst({
                where: {
                  marketplaceAccountId: account.id,
                  externalOrderId: mlOrderId,
                },
                select: { id: true, status: true },
              });
          if (localOrder && localOrder.status !== "CANCELLED") {
            // Reler a conta: o re-poll acima pode ter refrescado e ROTACIONADO
            // os tokens (refresh token ML é single-use). Usar o snapshot stale
            // dispararia um segundo refresh com token já consumido →
            // invalid_grant → circuit breaker marcaria a conta como ERROR e a
            // importação de pedidos PARARIA até reconexão manual.
            // EGRESS: select mínimo — só os campos que o refresh precisa.
            const freshAccount = await prisma.marketplaceAccount.findUnique({
              where: { id: account.id },
              select: {
                id: true,
                accessToken: true,
                refreshToken: true,
                expiresAt: true,
              },
            });
            const accessToken = await ensureFreshMLToken(
              freshAccount ?? account,
            );
            const mlOrder = await MLApiService.getOrderDetails(
              accessToken,
              mlOrderId,
            );
            if (mlOrder.status === "cancelled") {
              await OrderUseCase.processOrderCancellation({
                marketplaceAccountId: account.id,
                externalOrderId: mlOrderId,
                platformLabel: "ML",
                logPrefix: "[WebhookUseCase]",
              });
            }
          }
        } catch (err) {
          console.error(
            "[WebhookUseCase] Falha na checagem de cancelamento ML (best-effort):",
            err,
          );
        }
      }

      if (importResult.errors > 0) {
        return {
          success: false,
          userId: account.userId,
          orderId: mlOrderId,
          error: `Erro ao importar pedidos: ${importResult.errors} erros`,
        };
      }

      if (importResult.imported === 0) {
        return {
          success: true,
          userId: account.userId,
          orderId: mlOrderId,
          action: "no_new_orders",
        };
      }

      return {
        success: true,
        userId: account.userId,
        orderId: mlOrderId,
        action: `imported_${importResult.imported}_orders`,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido no processamento do webhook",
      };
    }
  }

  /**
   * Processa webhook de pedido da Shopee
   * Identifica a conta Shopee via shop_id e importa pedidos recentes
   */
  static async processShopeeOrderWebhook(payload: {
    shop_id: number;
    code: number;
    timestamp: number;
    data?: { ordersn?: string; status?: string };
  }): Promise<{
    success: boolean;
    accountId?: string;
    action?: string;
    error?: string;
  }> {
    try {
      // Idempotência: chave = shop_id + code + ordersn + timestamp.
      const ordersn = payload.data?.ordersn ?? "";
      const dedupKey = `${payload.shop_id}:${payload.code}:${ordersn}:${payload.timestamp}`;
      const isNew = await claimWebhookEvent("SHOPEE", dedupKey, payload);
      if (!isNew) {
        return { success: true, action: "duplicate_ignored" };
      }

      const accounts = await MarketplaceRepository.findAllShopeeByShopId(
        payload.shop_id,
        true,
      );

      if (accounts.length === 0) {
        void SystemLogService.logWarning(
          "WEBHOOK_ACCOUNT_NOT_FOUND",
          `Webhook Shopee ignorado: conta não encontrada para shop_id=${payload.shop_id}. Pedidos podem estar sendo perdidos.`,
          {
            resource: "MarketplaceAccount",
            details: {
              shopId: payload.shop_id,
              platform: "SHOPEE",
              ordersn: payload.data?.ordersn,
            },
          },
        ).catch(() => {});
        return {
          success: false,
          error: `Conta Shopee não encontrada para shop_id: ${payload.shop_id}`,
        };
      }

      if (accounts.length > 1) {
        return {
          success: false,
          error: `Múltiplas contas Shopee ativas encontradas para shop_id: ${payload.shop_id}. Resolva a duplicidade antes de processar webhooks.`,
        };
      }

      const [account] = accounts;

      if (account.status !== "ACTIVE") {
        return {
          success: false,
          error: `Conta Shopee não está ativa (status: ${account.status})`,
        };
      }

      const importResult =
        await OrderUseCase.importRecentShopeeOrdersForAccount(
          account.id,
          1,
          true,
        );

      // ADITIVO (cancelamento): o push traz data.status como HINT — a verdade
      // é o fetch da API. Estorna SOMENTE se order_status raw === "CANCELLED"
      // (IN_CANCEL é cancelamento em andamento, o vendedor pode rejeitar —
      // não tocar o pedido). O fetch Shopee do re-poll filtra pós-venda,
      // então cancelamento nunca chega pelo importador. Best-effort.
      const pushStatus = payload.data?.status ?? "";
      if (
        process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1" &&
        ordersn &&
        (pushStatus === "CANCELLED" || pushStatus === "IN_CANCEL")
      ) {
        try {
          const localOrder = await prisma.order.findFirst({
            where: {
              marketplaceAccountId: account.id,
              externalOrderId: ordersn,
            },
            select: { id: true, status: true },
          });
          if (localOrder && localOrder.status !== "CANCELLED") {
            // Reler a conta: o re-poll acima pode ter refrescado e rotacionado
            // os tokens Shopee — o snapshot stale faria um refresh fadado a
            // falhar (refresh token consumido) e a checagem seria pulada.
            // EGRESS: select mínimo — só os campos que o refresh precisa.
            const freshAccount = await prisma.marketplaceAccount.findUnique({
              where: { id: account.id },
              select: {
                id: true,
                shopId: true,
                accessToken: true,
                refreshToken: true,
                expiresAt: true,
              },
            });
            const accessToken = await ensureFreshShopeeToken(
              freshAccount ?? account,
            );
            if (accessToken && account.shopId) {
              const [detail] = await ShopeeApiService.getOrderDetails(
                accessToken,
                account.shopId,
                [ordersn],
              );
              if (detail?.order_status === "CANCELLED") {
                await OrderUseCase.processOrderCancellation({
                  marketplaceAccountId: account.id,
                  externalOrderId: ordersn,
                  platformLabel: "Shopee",
                  logPrefix: "[WebhookUseCase]",
                });
              }
            }
          }
        } catch (err) {
          console.error(
            "[WebhookUseCase] Falha na checagem de cancelamento Shopee (best-effort):",
            err,
          );
        }
      }

      if (importResult.errors > 0) {
        return {
          success: false,
          accountId: account.id,
          error: `Erro ao importar pedidos Shopee: ${importResult.errors} erros`,
        };
      }

      return {
        success: true,
        accountId: account.id,
        action:
          importResult.imported > 0
            ? `imported_${importResult.imported}_orders`
            : "no_new_orders",
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido no processamento do webhook Shopee",
      };
    }
  }

  /**
   * Processa webhook nativo de pedido da Magalu (tópicos orders_order /
   * orders_delivery). Resolve a conta por tenant_id e dispara a importação
   * recente da conta (que faz a baixa de estoque), espelhando ML/Shopee.
   *
   * A validação de assinatura HMAC acontece na rota (precisa dos headers e do
   * corpo) — aqui assumimos um payload já autenticado.
   */
  static async processMagaluOrderWebhook(
    payload: MagaluOrderWebhookPayload,
  ): Promise<{
    success: boolean;
    accountId?: string;
    action?: string;
    error?: string;
  }> {
    try {
      const tenantId = payload.tenant_id;
      const topic = payload.topic ?? "";
      const resourceId = payload.data?.params?.id ?? "";
      const status = payload.data?.status ?? "";

      if (!tenantId) {
        return { success: false, error: "Webhook Magalu sem tenant_id" };
      }

      const dedupKey = `${tenantId}:${topic}:${resourceId}:${status}`;
      const isNew = await claimWebhookEvent("MAGALU", dedupKey, payload);
      if (!isNew) {
        return { success: true, action: "duplicate_ignored" };
      }

      const accounts = await MarketplaceRepository.findAllByExternalUserId(
        tenantId,
        Platform.MAGALU,
        true,
      );

      if (accounts.length === 0) {
        void SystemLogService.logWarning(
          "WEBHOOK_ACCOUNT_NOT_FOUND",
          `Webhook Magalu ignorado: conta não encontrada para tenant_id=${tenantId}. Pedidos podem estar sendo perdidos.`,
          {
            resource: "MarketplaceAccount",
            details: { tenantId, platform: "MAGALU", topic, resourceId },
          },
        ).catch(() => {});
        return {
          success: false,
          error: `Conta Magalu não encontrada para tenant_id: ${tenantId}`,
        };
      }

      if (accounts.length > 1) {
        return {
          success: false,
          error: `Múltiplas contas Magalu ativas encontradas para tenant_id: ${tenantId}. Resolva a duplicidade antes de processar webhooks.`,
        };
      }

      const [account] = accounts;
      if (account.status !== "ACTIVE") {
        return {
          success: false,
          error: `Conta Magalu não está ativa (status: ${account.status})`,
        };
      }

      // Janela curta (2 dias) — cobre o pedido recém-atualizado + borda de fuso.
      const importResult =
        await OrderUseCase.importRecentMagaluOrdersForAccount(
          account.id,
          2,
          true,
        );

      if (importResult.errors > 0) {
        return {
          success: false,
          accountId: account.id,
          error: `Erro ao importar pedidos Magalu: ${importResult.errors} erros`,
        };
      }

      return {
        success: true,
        accountId: account.id,
        action:
          importResult.imported > 0
            ? `imported_${importResult.imported}_orders`
            : "no_new_orders",
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido no processamento do webhook Magalu",
      };
    }
  }

  /**
   * Processa webhook de pergunta (topic="questions") do Mercado Livre.
   * Delegamos para MessagesUseCase para manter este arquivo focado em roteamento.
   */
  static async processQuestionWebhook(payload: MLQuestionWebhookPayload) {
    return MessagesUseCase.syncQuestionFromWebhook(payload);
  }

  /**
   * Valida payload de webhook de pergunta. Aceita topic="questions" e
   * resource no formato "/questions/{id}". Mantido separado de
   * validateWebhookPayload (orders) para não alterar comportamento existente.
   */
  static validateQuestionWebhookPayload(
    payload: any,
  ): payload is MLQuestionWebhookPayload {
    if (!payload || typeof payload !== "object") return false;
    if (
      !payload.resource ||
      !payload.user_id ||
      !payload.topic ||
      !payload.application_id ||
      typeof payload.attempts !== "number" ||
      !payload.sent ||
      !payload.received
    ) {
      return false;
    }
    if (payload.topic !== "questions") return false;
    if (!/^\/questions\/\d+$/.test(payload.resource)) return false;
    return true;
  }

  /**
   * Valida se o payload do webhook ML é válido
   */
  static validateWebhookPayload(
    payload: any,
  ): payload is MLOrderWebhookPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    if (
      !payload.resource ||
      !payload.user_id ||
      !payload.topic ||
      !payload.application_id ||
      typeof payload.attempts !== "number" ||
      !payload.sent ||
      !payload.received
    ) {
      return false;
    }

    if (payload.topic !== "orders_v2") {
      return false;
    }

    if (!/^\/orders\/\d+$/.test(payload.resource)) {
      return false;
    }

    return true;
  }

  /**
   * Valida payload de webhook de item. Aceita topic="items" e resource no
   * formato "/items/{MLBxxxx}". Mantido separado dos demais validadores para
   * não alterar o roteamento existente (pedidos/perguntas).
   */
  static validateItemWebhookPayload(
    payload: any,
  ): payload is MLItemWebhookPayload {
    if (!payload || typeof payload !== "object") return false;
    if (
      !payload.resource ||
      !payload.user_id ||
      !payload.topic ||
      !payload.application_id ||
      typeof payload.attempts !== "number" ||
      !payload.sent ||
      !payload.received
    ) {
      return false;
    }
    if (payload.topic !== "items") return false;
    if (!/^\/items\/[A-Za-z0-9]+$/.test(payload.resource)) return false;
    return true;
  }

  /**
   * Processa webhook de item (topic="items") do Mercado Livre.
   *
   * Detecta anúncios criados direto no painel do ML e cria na Dexo o Product
   * vinculado (ProductListing) com flag de origem. Só age sobre anúncios NOVOS
   * (date_created >= autoImportListingsSince da conta): o tópico "items" dispara
   * a cada edição, então sem esse gate importaríamos anúncios antigos. Idempotente
   * por (claimWebhookEvent + upsert do listing): reentrega/edição nunca duplica.
   * Espelha processOrderWebhook; não toca o caminho de pedidos.
   */
  static async processItemWebhook(payload: MLItemWebhookPayload): Promise<{
    success: boolean;
    userId?: string;
    itemId?: string;
    action?: string;
    productId?: string;
    error?: string;
  }> {
    try {
      const itemIdMatch = payload.resource.match(/^\/items\/([A-Za-z0-9]+)$/);
      if (!itemIdMatch) {
        return {
          success: false,
          error: `Formato de resource inválido: ${payload.resource}`,
        };
      }

      const mlItemId = itemIdMatch[1];

      // Idempotência: ignorar reentregas exatas do mesmo evento (mesmo `sent`).
      const dedupKey = `${payload.resource}:${payload.user_id}:${payload.sent}`;
      const isNew = await claimWebhookEvent("ML", dedupKey, payload);
      if (!isNew) {
        return { success: true, itemId: mlItemId, action: "duplicate_ignored" };
      }

      const accounts = await MarketplaceRepository.findAllByExternalUserId(
        payload.user_id.toString(),
        Platform.MERCADO_LIVRE,
        true,
      );

      if (accounts.length === 0) {
        return {
          success: false,
          error: `Conta do Mercado Livre não encontrada para user_id: ${payload.user_id}`,
        };
      }

      if (accounts.length > 1) {
        return {
          success: false,
          error: `Múltiplas contas ativas do Mercado Livre encontradas para user_id: ${payload.user_id}. Resolva a duplicidade antes de processar webhooks.`,
        };
      }

      const [account] = accounts;

      if (account.status !== "ACTIVE") {
        return {
          success: false,
          error: `Conta do Mercado Livre não está ativa (status: ${account.status})`,
        };
      }

      // Baseline "só novos": sem baseline a conta não importa nada (fail-safe).
      if (!account.autoImportListingsSince) {
        return {
          success: true,
          userId: account.userId,
          itemId: mlItemId,
          action: "no_baseline_skipped",
        };
      }

      const accessToken = await ensureFreshMLToken(account);
      const item = await MLApiService.getItemDetails(accessToken, mlItemId);

      // Só anúncios novos: date_created < baseline = edição de anúncio antigo.
      const createdAt = new Date(item.date_created);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt < account.autoImportListingsSince
      ) {
        return {
          success: true,
          userId: account.userId,
          itemId: mlItemId,
          action: "not_new_ignored",
        };
      }

      // Alinha com importMLItems: só itens ativos viram produto.
      if (item.status !== "active") {
        return {
          success: true,
          userId: account.userId,
          itemId: mlItemId,
          action: "inactive_ignored",
        };
      }

      const normalized = ListingAutodetectUseCase.normalizeMLItem(
        { id: account.id, userId: account.userId },
        item,
      );
      const result =
        await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
          normalized,
        );

      return {
        success: true,
        userId: account.userId,
        itemId: mlItemId,
        action: result.action,
        productId: result.productId ?? undefined,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido no processamento do webhook de item",
      };
    }
  }
}

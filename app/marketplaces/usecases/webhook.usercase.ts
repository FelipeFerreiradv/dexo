import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import {
  MLOrderWebhookPayload,
  MLItemWebhookPayload,
} from "../types/ml-order.types";
import { MLQuestionWebhookPayload } from "../types/ml-questions.types";
import { OrderUseCase } from "./order.usercase";
import { MessagesUseCase } from "./messages.usecase";
import { ListingAutodetectUseCase } from "./listing-autodetect.usercase";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
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

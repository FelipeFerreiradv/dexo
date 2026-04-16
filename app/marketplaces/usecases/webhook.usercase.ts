import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { MLOrderWebhookPayload } from "../types/ml-order.types";
import { OrderUseCase } from "./order.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

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
}

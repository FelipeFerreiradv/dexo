import { Platform } from "@prisma/client";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { MLOrderWebhookPayload } from "../types/ml-order.types";
import { OrderUseCase } from "./order.usercase";

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

      // Encontrar conta do ML através do user_id do webhook
      const account = await MarketplaceRepository.findByExternalUserId(
        payload.user_id.toString(),
        Platform.MERCADO_LIVRE,
      );

      if (!account) {
        return {
          success: false,
          error: `Conta do Mercado Livre não encontrada para user_id: ${payload.user_id}`,
        };
      }

      // Verificar se a conta está ativa
      if (account.status !== "ACTIVE") {
        return {
          success: false,
          error: `Conta do Mercado Livre não está ativa (status: ${account.status})`,
        };
      }

      // Importar pedidos recentes da conta específica (1 dia, com desconto de estoque)
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
      const account = await MarketplaceRepository.findByShopId(payload.shop_id);

      if (!account) {
        return {
          success: false,
          error: `Conta Shopee não encontrada para shop_id: ${payload.shop_id}`,
        };
      }

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

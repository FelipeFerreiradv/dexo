import { Platform } from "@prisma/client";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { MLOrderWebhookPayload } from "../types/ml-order.types";
import { OrderUseCase } from "./order.usercase";

/**
 * Use Case para processar webhooks do Mercado Livre
 * Responsável por:
 * 1. Validar webhook payload
 * 2. Identificar usuário através da conta ML
 * 3. Processar notificações de pedidos automaticamente
 */
export class WebhookUseCase {
  /**
   * Processa webhook de pedido do Mercado Livre
   * Identifica o usuário através do user_id do ML e importa/sync pedidos automaticamente
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

      // Importar pedido automaticamente
      const importResult = await OrderUseCase.importRecentOrders(
        account.userId,
        1,
        true,
      ); // 1 dia, com desconto de estoque

      // Verificar se houve erros na importação
      if (importResult.errors > 0) {
        return {
          success: false,
          userId: account.userId,
          orderId: mlOrderId,
          error: `Erro ao importar pedidos: ${importResult.errors} erros`,
        };
      }

      // Verificar se algum pedido foi importado
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
   * Valida se o payload do webhook é válido
   */
  static validateWebhookPayload(
    payload: any,
  ): payload is MLOrderWebhookPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    // Verificar campos obrigatórios
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

    // Verificar se é um webhook de orders_v2
    if (payload.topic !== "orders_v2") {
      return false;
    }

    // Verificar formato do resource
    if (!/^\/orders\/\d+$/.test(payload.resource)) {
      return false;
    }

    return true;
  }
}

/**
 * OrderUseCase - Orquestração de importação e gestão de pedidos
 *
 * Responsabilidades:
 * - Importar pedidos do Mercado Livre
 * - Vincular itens do pedido aos produtos locais (por SKU)
 * - Descontar estoque automaticamente ao importar pedidos pagos
 * - Registrar logs de estoque e sincronização
 */

import prisma from "@/app/lib/prisma";
import { Platform, SyncType, SyncStatus } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { orderRepository } from "@/app/repositories/order.repository";
import type { MLOrderDetails, MLOrderItem } from "../types/ml-order.types";
import type {
  OrderCreate,
  OrderItemCreate,
  Order,
} from "@/app/interfaces/order.interface";

// ====================================================================
// TIPOS PARA RESULTADOS
// ====================================================================

export interface ImportOrderResult {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  status: "imported" | "already_exists" | "no_products" | "error";
  message: string;
  stockDeducted: boolean;
  itemsLinked: number;
  itemsTotal: number;
}

export interface ImportOrdersResult {
  totalOrders: number;
  imported: number;
  alreadyExists: number;
  noProducts: number;
  errors: number;
  stockDeductions: number;
  results: ImportOrderResult[];
}

export interface OrderStockDeduction {
  productId: string;
  productName: string;
  previousStock: number;
  newStock: number;
  quantity: number;
}

// ====================================================================
// USE CASE
// ====================================================================

export class OrderUseCase {
  /**
   * Importa pedidos recentes do Mercado Livre
   * @param userId ID do usuário
   * @param days Número de dias para trás (padrão: 7)
   * @param deductStock Se deve descontar estoque automaticamente (padrão: true)
   */
  static async importRecentOrders(
    userId: string,
    days: number = 7,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const result: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    // 1. Buscar conta do marketplace
    const account = await MarketplaceRepository.findByUserIdAndPlatform(
      userId,
      Platform.MERCADO_LIVRE,
    );

    if (!account || !account.accessToken || !account.externalUserId) {
      throw new Error(
        "Conta do Mercado Livre não conectada ou sem credenciais",
      );
    }

    // 2. Buscar pedidos pagos do ML
    console.log(`[OrderUseCase] Fetching recent orders for user ${userId}`);
    const mlOrders = await MLApiService.getRecentOrders(
      account.accessToken,
      account.externalUserId,
      days,
      "paid", // Apenas pedidos pagos
    );

    result.totalOrders = mlOrders.length;
    console.log(`[OrderUseCase] Found ${mlOrders.length} paid orders`);

    // 3. Processar cada pedido
    for (const mlOrder of mlOrders) {
      const importResult = await this.processOrder(
        mlOrder,
        account.id,
        deductStock,
      );
      result.results.push(importResult);

      // Contabilizar resultados
      switch (importResult.status) {
        case "imported":
          result.imported++;
          if (importResult.stockDeducted) {
            result.stockDeductions++;
          }
          break;
        case "already_exists":
          result.alreadyExists++;
          break;
        case "no_products":
          result.noProducts++;
          break;
        case "error":
          result.errors++;
          break;
      }
    }

    // 4. Registrar log de sincronização
    await this.logSync(
      account.id,
      SyncType.ORDER_IMPORT,
      result.errors === 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Importados ${result.imported} de ${result.totalOrders} pedidos. Estoque descontado: ${result.stockDeductions}`,
      {
        totalOrders: result.totalOrders,
        imported: result.imported,
        alreadyExists: result.alreadyExists,
        errors: result.errors,
      },
    );

    return result;
  }

  /**
   * Processa um único pedido do ML
   */
  private static async processOrder(
    mlOrder: MLOrderDetails,
    marketplaceAccountId: string,
    deductStock: boolean,
  ): Promise<ImportOrderResult> {
    const externalOrderId = mlOrder.id.toString();

    try {
      // Verificar se pedido já foi importado
      const exists = await orderRepository.exists(externalOrderId);
      if (exists) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          status: "already_exists",
          message: "Pedido já importado anteriormente",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        };
      }

      // Mapear itens do pedido para produtos locais
      const { items, linkedCount } = await this.mapOrderItems(
        mlOrder.order_items,
      );

      // Se nenhum item foi vinculado, não importar
      if (items.length === 0) {
        return {
          success: false,
          orderId: null,
          externalOrderId,
          status: "no_products",
          message: "Nenhum item do pedido pôde ser vinculado a produtos locais",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        };
      }

      // Criar pedido no banco
      const orderData: OrderCreate = {
        marketplaceAccountId,
        externalOrderId,
        status: this.mapMLStatusToLocal(mlOrder.status),
        totalAmount: mlOrder.total_amount,
        customerName: this.extractCustomerName(mlOrder),
        customerEmail: undefined, // ML não fornece email diretamente
        items,
      };

      const order = await orderRepository.create(orderData);

      // Descontar estoque se solicitado e pedido está pago
      let stockDeducted = false;
      if (deductStock && mlOrder.status === "paid") {
        await this.deductStockForOrder(order, `Venda ML #${externalOrderId}`);
        stockDeducted = true;
      }

      return {
        success: true,
        orderId: order.id,
        externalOrderId,
        status: "imported",
        message: `Pedido importado com ${linkedCount} itens vinculados`,
        stockDeducted,
        itemsLinked: linkedCount,
        itemsTotal: mlOrder.order_items.length,
      };
    } catch (error) {
      console.error(
        `[OrderUseCase] Error processing order ${externalOrderId}:`,
        error,
      );
      return {
        success: false,
        orderId: null,
        externalOrderId,
        status: "error",
        message: error instanceof Error ? error.message : "Erro desconhecido",
        stockDeducted: false,
        itemsLinked: 0,
        itemsTotal: mlOrder.order_items.length,
      };
    }
  }

  /**
   * Mapeia itens do pedido ML para produtos locais (por SKU)
   */
  private static async mapOrderItems(
    mlItems: MLOrderItem[],
  ): Promise<{ items: OrderItemCreate[]; linkedCount: number }> {
    const items: OrderItemCreate[] = [];
    let linkedCount = 0;

    for (const mlItem of mlItems) {
      // Extrair SKU do item
      const sku = this.extractSku(mlItem);

      if (!sku) {
        console.log(`[OrderUseCase] Item ${mlItem.item.id} sem SKU, pulando`);
        continue;
      }

      // Buscar produto pelo SKU
      const product = await prisma.product.findUnique({
        where: { sku },
      });

      if (!product) {
        console.log(`[OrderUseCase] Produto com SKU "${sku}" não encontrado`);
        continue;
      }

      items.push({
        productId: product.id,
        quantity: mlItem.quantity,
        unitPrice: mlItem.unit_price,
      });
      linkedCount++;
    }

    return { items, linkedCount };
  }

  /**
   * Extrai SKU de um item do pedido ML
   */
  private static extractSku(mlItem: MLOrderItem): string | null {
    // Tentar seller_custom_field primeiro
    if (mlItem.item.seller_custom_field) {
      return mlItem.item.seller_custom_field;
    }

    // Depois, seller_sku
    if (mlItem.item.seller_sku) {
      return mlItem.item.seller_sku;
    }

    return null;
  }

  /**
   * Desconta estoque dos produtos de um pedido
   */
  private static async deductStockForOrder(
    order: Order,
    reason: string,
  ): Promise<OrderStockDeduction[]> {
    const deductions: OrderStockDeduction[] = [];

    if (!order.items) return deductions;

    for (const item of order.items) {
      try {
        // Buscar produto atual
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
        });

        if (!product) continue;

        const previousStock = product.stock;
        const newStock = Math.max(0, previousStock - item.quantity);

        // Atualizar estoque
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: newStock },
        });

        // Registrar log de estoque
        await prisma.stockLog.create({
          data: {
            productId: item.productId,
            change: -item.quantity,
            reason,
            previousStock,
            newStock,
          },
        });

        deductions.push({
          productId: item.productId,
          productName: product.name,
          previousStock,
          newStock,
          quantity: item.quantity,
        });

        console.log(
          `[OrderUseCase] Stock deducted: ${product.name} (${previousStock} → ${newStock})`,
        );
      } catch (error) {
        console.error(
          `[OrderUseCase] Error deducting stock for product ${item.productId}:`,
          error,
        );
      }
    }

    return deductions;
  }

  /**
   * Mapeia status do ML para status local
   */
  private static mapMLStatusToLocal(
    mlStatus: string,
  ): "PENDING" | "PAID" | "SHIPPED" | "DELIVERED" | "CANCELLED" {
    switch (mlStatus) {
      case "paid":
        return "PAID";
      case "shipped":
        return "SHIPPED";
      case "delivered":
        return "DELIVERED";
      case "cancelled":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }

  /**
   * Extrai nome do cliente do pedido ML
   */
  private static extractCustomerName(
    mlOrder: MLOrderDetails,
  ): string | undefined {
    const buyer = mlOrder.buyer;
    if (buyer.first_name && buyer.last_name) {
      return `${buyer.first_name} ${buyer.last_name}`;
    }
    if (buyer.nickname) {
      return buyer.nickname;
    }
    return undefined;
  }

  /**
   * Registra log de sincronização
   */
  private static async logSync(
    marketplaceAccountId: string,
    type: SyncType,
    status: SyncStatus,
    message: string,
    payload?: object,
  ): Promise<void> {
    await prisma.syncLog.create({
      data: {
        marketplaceAccountId,
        type,
        status,
        message,
        payload: payload as object | undefined,
      },
    });
  }

  /**
   * Busca pedidos importados de um usuário
   */
  static async getOrders(
    userId: string,
    options?: {
      status?: string;
      page?: number;
      limit?: number;
    },
  ) {
    // Buscar conta do marketplace
    const account = await MarketplaceRepository.findByUserIdAndPlatform(
      userId,
      Platform.MERCADO_LIVRE,
    );

    if (!account) {
      throw new Error("Conta do Mercado Livre não encontrada");
    }

    return orderRepository.findAll({
      marketplaceAccountId: account.id,
      status: options?.status as any,
      page: options?.page,
      limit: options?.limit,
    });
  }

  /**
   * Busca detalhes de um pedido
   */
  static async getOrderById(orderId: string): Promise<Order | null> {
    return orderRepository.findById(orderId);
  }
}

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
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SyncUseCase } from "./sync.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import type { MLOrderDetails, MLOrderItem } from "../types/ml-order.types";
import type {
  ShopeeOrderDetail,
  ShopeeOrderItem,
} from "../types/shopee-api.types";
import type {
  OrderCreate,
  OrderItemCreate,
  Order,
  OrderStatus,
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
    const aggregated: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    const accounts =
      await MarketplaceRepository.findAllByUserIdAndPlatform(
        userId,
        Platform.MERCADO_LIVRE,
      );

    const validAccounts =
      accounts?.filter((acc) => acc.accessToken && acc.externalUserId) ?? [];

    if (validAccounts.length === 0) {
      throw new Error(
        "Conta do Mercado Livre não conectada ou sem credenciais",
      );
    }

    for (const account of validAccounts) {
      try {
        const result = await this.importRecentOrdersForAccount(
          account.id,
          days,
          deductStock,
        );

        aggregated.totalOrders += result.totalOrders;
        aggregated.imported += result.imported;
        aggregated.alreadyExists += result.alreadyExists;
        aggregated.noProducts += result.noProducts;
        aggregated.errors += result.errors;
        aggregated.stockDeductions += result.stockDeductions;
        aggregated.results.push(...result.results);
      } catch (error) {
        aggregated.errors += 1;
        aggregated.results.push({
          success: false,
          orderId: null,
          externalOrderId: `ACCOUNT_${account.id}`,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao importar conta Mercado Livre",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: 0,
        });
      }
    }

    return aggregated;
  }

  /**
   * Importa pedidos recentes do Mercado Livre para uma conta específica
   */
  static async importRecentOrdersForAccount(
    marketplaceAccountId: string,
    days: number = 7,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const account = await MarketplaceRepository.findById(marketplaceAccountId);
    if (!account || !account.accessToken || !account.externalUserId) {
      throw new Error(
        "Conta do Mercado Livre não conectada ou sem credenciais",
      );
    }

    const result: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    const mlOrders = await this.getRecentMLOrdersWithRefresh(account, days);

    result.totalOrders = mlOrders.length;

    // Batch check + prefetch (same optimization as importRecentOrders)
    const externalIds = mlOrders.map((o) => o.id.toString());
    const existingOrders = await prisma.order.findMany({
      where: { externalOrderId: { in: externalIds } },
      select: { externalOrderId: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.externalOrderId));

    const accountListings = await prisma.productListing.findMany({
      where: { marketplaceAccountId: account.id },
      include: { product: true },
    });
    const listingMap = new Map(
      accountListings.map((l) => [
        `${l.marketplaceAccountId}_${l.externalListingId}`,
        l,
      ]),
    );

    for (const mlOrder of mlOrders) {
      const extId = mlOrder.id.toString();
      if (existingSet.has(extId)) {
        result.alreadyExists++;
        result.results.push({
          success: true,
          orderId: null,
          externalOrderId: extId,
          status: "already_exists",
          message: "Pedido já importado anteriormente",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        });
        continue;
      }

      const importResult = await this.processOrder(
        mlOrder,
        account.id,
        deductStock,
        listingMap,
        account.userId,
      );
      result.results.push(importResult);

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

    await this.logSync(
      account.id,
      SyncType.ORDER_IMPORT,
      result.errors === 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Importados ${result.imported} de ${result.totalOrders} pedidos do ML (account import)`,
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
   * Importa pedidos recentes do Shopee (todas as contas ativas do usuário)
   */
  static async importRecentShopeeOrders(
    userId: string,
    days: number = 3,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const accounts =
      await MarketplaceRepository.findAllByUserIdAndPlatform(
        userId,
        Platform.SHOPEE,
      );

    const validAccounts =
      accounts?.filter((acc) => acc.accessToken && acc.shopId) ?? [];

    if (validAccounts.length === 0) {
      throw new Error("Conta do Shopee não conectada ou sem credenciais");
    }

    const aggregated: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    // Executa sequencialmente para evitar estouro de rate limit
    for (const account of validAccounts) {
      try {
        const result = await this.importRecentShopeeOrdersForAccount(
          account.id,
          days,
          deductStock,
        );

        aggregated.totalOrders += result.totalOrders;
        aggregated.imported += result.imported;
        aggregated.alreadyExists += result.alreadyExists;
        aggregated.noProducts += result.noProducts;
        aggregated.errors += result.errors;
        aggregated.stockDeductions += result.stockDeductions;
        aggregated.results.push(...result.results);
      } catch (error) {
        aggregated.errors += 1;
        aggregated.results.push({
          success: false,
          orderId: null,
          externalOrderId: `ACCOUNT_${account.id}`,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao importar conta Shopee",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: 0,
        });
      }
    }

    return aggregated;
  }

  /**
   * Importa pedidos recentes do Shopee para uma conta específica
   */
  static async importRecentShopeeOrdersForAccount(
    marketplaceAccountId: string,
    days: number = 3,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const account = await MarketplaceRepository.findById(marketplaceAccountId);
    if (!account || !account.accessToken || !account.shopId) {
      throw new Error("Conta Shopee não encontrada ou sem credenciais");
    }

    const result: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    const shopeeOrders = await this.getRecentShopeeOrdersWithRefresh(
      account,
      days,
    );

    result.totalOrders = shopeeOrders.length;

    // Batch check + prefetch (same optimization as ML imports)
    const externalIds = (shopeeOrders as ShopeeOrderDetail[]).map(
      (o) => o.order_sn,
    );
    const existingOrders = await prisma.order.findMany({
      where: { externalOrderId: { in: externalIds } },
      select: { externalOrderId: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.externalOrderId));

    const accountListings = await prisma.productListing.findMany({
      where: { marketplaceAccountId: account.id },
      include: { product: true },
    });
    const listingMap = new Map(
      accountListings.map((l) => [
        `${l.marketplaceAccountId}_${l.externalListingId}`,
        l,
      ]),
    );

    for (const shopeeOrder of shopeeOrders as ShopeeOrderDetail[]) {
      const externalOrderId = shopeeOrder.order_sn;
      try {
        if (existingSet.has(externalOrderId)) {
          result.results.push({
            success: true,
            orderId: null,
            externalOrderId,
            status: "already_exists",
            message: "Pedido já importado anteriormente",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: shopeeOrder.item_list.length,
          });
          result.alreadyExists++;
          continue;
        }

        const { items, linkedCount } = await this.mapShopeeOrderItems(
          shopeeOrder.item_list,
          account.userId,
          marketplaceAccountId,
          listingMap,
        );

        if (items.length === 0) {
          result.results.push({
            success: false,
            orderId: null,
            externalOrderId,
            status: "no_products",
            message: "Nenhum item do pedido Shopee pôde ser vinculado",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: shopeeOrder.item_list.length,
          });
          result.noProducts++;
          continue;
        }

        const totalAmount =
          typeof shopeeOrder.total_amount === "number"
            ? Number(shopeeOrder.total_amount)
            : items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

        const orderData: OrderCreate = {
          marketplaceAccountId,
          externalOrderId,
          status: this.mapShopeeStatus(shopeeOrder.order_status),
          totalAmount,
          customerName: shopeeOrder.buyer_username ?? undefined,
          items,
        };

        const created = await orderRepository.create(orderData);

        let stockDeducted = false;
        // getRecentOrders() já retorna apenas pedidos em estados pós-venda.
        // Não repetir a decisão de baixa com base no status local mapeado.
        if (deductStock) {
          await this.deductStockForOrder(created, "Importação Shopee");
          stockDeducted = true;
        }

        result.imported++;
        result.stockDeductions += stockDeducted ? 1 : 0;
        result.results.push({
          success: true,
          orderId: created.id,
          externalOrderId,
          status: "imported",
          message: "Pedido Shopee importado com sucesso",
          stockDeducted,
          itemsLinked: linkedCount,
          itemsTotal: shopeeOrder.item_list.length,
        });
      } catch (error) {
        // Handle concurrent duplicate (P2002) gracefully as "already_exists"
        const isPrismaUniqueError =
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as any).code === "P2002";
        if (isPrismaUniqueError) {
          result.alreadyExists++;
          result.results.push({
            success: true,
            orderId: null,
            externalOrderId,
            status: "already_exists",
            message: "Pedido já importado (concurrent)",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: shopeeOrder.item_list.length,
          });
          continue;
        }
        console.error("[OrderUseCase] Erro ao importar pedido Shopee:", error);
        result.errors++;
        result.results.push({
          success: false,
          orderId: null,
          externalOrderId,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro desconhecido ao importar pedido Shopee",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: shopeeOrder.item_list.length,
        });
      }
    }

    await this.logSync(
      marketplaceAccountId,
      SyncType.ORDER_IMPORT,
      result.errors === 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Importados ${result.imported} de ${result.totalOrders} pedidos do Shopee`,
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
    listingMap?: Map<string, any>,
    userId?: string,
  ): Promise<ImportOrderResult> {
    const externalOrderId = mlOrder.id.toString();

    try {
      // Verificar se pedido já foi importado (fallback for direct calls without batch check)
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
        userId,
        marketplaceAccountId,
        listingMap,
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
      // Handle concurrent duplicate (P2002) gracefully as "already_exists"
      const isPrismaUniqueError =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as any).code === "P2002";
      if (isPrismaUniqueError) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          status: "already_exists",
          message: "Pedido já importado (concurrent)",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        };
      }
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
   * Mapeia itens do pedido ML priorizando o anúncio vinculado e faz fallback por SKU.
   */
  private static async mapOrderItems(
    mlItems: MLOrderItem[],
    userId: string | undefined,
    marketplaceAccountId: string,
    listingMap?: Map<string, any>,
  ): Promise<{ items: OrderItemCreate[]; linkedCount: number }> {
    const items: OrderItemCreate[] = [];
    let linkedCount = 0;

    for (const mlItem of mlItems) {
      // 1) Tentar vincular pelo ID do anúncio no marketplace
      const externalListingId = mlItem.item.id;
      const cacheKey = `${marketplaceAccountId}_${externalListingId}`;

      // Use prefetched map if available, otherwise fallback to DB query
      const listing = listingMap
        ? listingMap.get(cacheKey)
        : await prisma.productListing.findUnique({
            where: {
              marketplaceAccountId_externalListingId: {
                marketplaceAccountId,
                externalListingId,
              },
            },
            include: { product: true },
          });

      if (listing && listing.product) {
        items.push({
          productId: listing.productId,
          listingId: listing.id,
          quantity: mlItem.quantity,
          unitPrice: mlItem.unit_price,
        });
        linkedCount++;
        continue;
      }

      // 2) Fallback: vincular por SKU
      const sku = this.extractSku(mlItem);

      if (!sku) {
        console.log(
          `[OrderUseCase] Item ${mlItem.item.id} sem SKU e sem listing vinculado, pulando`,
        );
        continue;
      }

      // Buscar produto pelo SKU
      const product = await prisma.product.findFirst({
        where: userId ? { sku, userId } : { sku },
      });

      if (!product) {
        console.log(`[OrderUseCase] Produto com SKU "${sku}" não encontrado`);
        continue;
      }

      items.push({
        productId: product.id,
        listingId: null,
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
   * Mapeia itens do pedido Shopee priorizando o anúncio vinculado e faz fallback por SKU.
   */
  private static async mapShopeeOrderItems(
    items: ShopeeOrderItem[],
    userId: string | undefined,
    marketplaceAccountId: string,
    listingMap?: Map<string, any>,
  ): Promise<{ items: OrderItemCreate[]; linkedCount: number }> {
    const result: OrderItemCreate[] = [];
    let linkedCount = 0;

    for (const item of items) {
      const externalListingId = item.item_id.toString();
      const cacheKey = `${marketplaceAccountId}_${externalListingId}`;

      // Use prefetched map if available, otherwise fallback to DB query
      const listing = listingMap
        ? listingMap.get(cacheKey)
        : await prisma.productListing.findUnique({
            where: {
              marketplaceAccountId_externalListingId: {
                marketplaceAccountId,
                externalListingId,
              },
            },
            include: { product: true },
          });

      if (listing && listing.product) {
        result.push({
          productId: listing.productId,
          listingId: listing.id,
          quantity: item.model_quantity_purchased,
          unitPrice: Number(item.model_original_price ?? 0),
        });
        linkedCount++;
        continue;
      }

      const sku = this.extractSkuFromShopee(item);
      if (!sku) {
        console.log(
          `[OrderUseCase] Item Shopee ${externalListingId} sem SKU e sem listing vinculado, pulando`,
        );
        continue;
      }

      const product = await prisma.product.findFirst({
        where: userId ? { sku, userId } : { sku },
      });

      if (!product) {
        console.log(
          `[OrderUseCase] Produto com SKU "${sku}" (Shopee) não encontrado`,
        );
        continue;
      }

      result.push({
        productId: product.id,
        listingId: null,
        quantity: item.model_quantity_purchased,
        unitPrice: Number(item.model_original_price ?? 0),
      });
      linkedCount++;
    }

    return { items: result, linkedCount };
  }

  private static extractSkuFromShopee(item: ShopeeOrderItem): string | null {
    if (item.model_sku) return item.model_sku;
    if (item.item_sku) return item.item_sku;
    return null;
  }

  private static mapShopeeStatus(status: string): OrderStatus {
    switch (status) {
      case "COMPLETED":
        return "DELIVERED";
      case "READY_TO_SHIP":
      case "PROCESSED":
      case "SHIPPED":
        return "SHIPPED";
      case "CANCELLED":
      case "IN_CANCEL":
        return "CANCELLED";
      case "UNPAID":
      default:
        return "PENDING";
    }
  }

  private static async getRecentMLOrdersWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string;
      externalUserId: string;
    },
    days: number,
  ): Promise<MLOrderDetails[]> {
    try {
      return await MLApiService.getRecentOrders(
        account.accessToken,
        account.externalUserId,
        days,
        "paid",
      );
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await MLOAuthService.refreshAccessToken(
        account.refreshToken,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });

      return MLApiService.getRecentOrders(
        refreshed.accessToken,
        account.externalUserId,
        days,
        "paid",
      );
    }
  }

  private static async getRecentShopeeOrdersWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
      shopId: number;
    },
    days: number,
  ): Promise<ShopeeOrderDetail[]> {
    try {
      return await ShopeeApiService.getRecentOrders(
        account.accessToken,
        account.shopId,
        days,
      );
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await ShopeeOAuthService.refreshAccessToken(
        account.refreshToken,
        account.shopId,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
      });

      return ShopeeApiService.getRecentOrders(
        refreshed.access_token,
        account.shopId,
        days,
      );
    }
  }

  private static isMarketplaceAuthError(error: unknown): boolean {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as any).status === "number"
        ? (error as any).status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 401 || status === 403) {
      return true;
    }
    return /unauthorized|invalid access token|token expired|forbidden/i.test(
      message,
    );
  }

  /**
   * Desconta estoque dos produtos de um pedido
   */
  private static async deductStockForOrder(
    order: Order,
    reason: string,
  ): Promise<OrderStockDeduction[]> {
    const deductions: OrderStockDeduction[] = [];

    if (!order.items || order.items.length === 0) return deductions;

    // Batch fetch all products in one query
    const productIds = order.items.map((item) => item.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, stock: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const syncedProductIds = new Set<string>();

    // Build transaction operations for all items at once
    const txOps: Parameters<typeof prisma.$transaction>[0] = [];

    for (const item of order.items) {
      const product = productMap.get(item.productId);
      if (!product) continue;

      const previousStock = product.stock;
      const newStock = Math.max(0, previousStock - item.quantity);

      txOps.push(
        prisma.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: Math.min(item.quantity, previousStock) } },
        }),
      );
      txOps.push(
        prisma.stockLog.create({
          data: {
            productId: item.productId,
            change: -item.quantity,
            reason,
            previousStock,
            newStock,
          },
        }),
      );

      deductions.push({
        productId: item.productId,
        productName: product.name,
        previousStock,
        newStock,
        quantity: item.quantity,
      });
      syncedProductIds.add(item.productId);

      console.log(
        `[OrderUseCase] Stock deducted: ${product.name} (${previousStock} → ${newStock})`,
      );
    }

    let stockUpdated = false;
    if (txOps.length > 0) {
      try {
        await prisma.$transaction(txOps);
        stockUpdated = true;
      } catch (error) {
        console.error(
          `[OrderUseCase] Error in stock deduction transaction:`,
          error,
        );
      }
    }

    if (stockUpdated && syncedProductIds.size > 0) {
      await this.syncMarketplaceStockForProducts([...syncedProductIds]);
    }

    return deductions;
  }

  private static async syncMarketplaceStockForProducts(
    productIds: string[],
  ): Promise<void> {
    const uniqueProductIds = [...new Set(productIds.filter(Boolean))];
    if (uniqueProductIds.length === 0) return;

    const syncResults = await Promise.allSettled(
      uniqueProductIds.map((productId) => SyncUseCase.syncProductStock(productId)),
    );

    syncResults.forEach((result, index) => {
      const productId = uniqueProductIds[index];
      if (result.status === "rejected") {
        console.error(
          `[OrderUseCase] Error syncing marketplace stock for product ${productId}:`,
          result.reason,
        );
        return;
      }

      const failedListings = result.value.filter((entry) => !entry.success).length;
      if (failedListings > 0) {
        console.warn(
          `[OrderUseCase] Marketplace stock sync finished with ${failedListings} failed listing(s) for product ${productId}`,
        );
      }
    });
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
      platform?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    return orderRepository.findAll({
      userId,
      status: options?.status as any,
      platform: options?.platform,
      search: options?.search,
      page: options?.page,
      limit: options?.limit,
      includeItems: true,
    });
  }

  /**
   * Busca detalhes de um pedido
   */
  static async getOrderById(orderId: string): Promise<Order | null> {
    return orderRepository.findById(orderId);
  }
}


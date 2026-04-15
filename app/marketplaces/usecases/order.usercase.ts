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
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SyncUseCase } from "./sync.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import { normalizeSku } from "@/app/lib/sku";
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
import { SystemLogService } from "@/app/services/system-log.service";

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

interface SyncLogContext {
  orderId?: string;
  platform?: string | null;
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

    const mlOrders = await this.getRecentMLOrdersWithRefresh(
      {
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        externalUserId: account.externalUserId,
      },
      days,
    );

    result.totalOrders = mlOrders.length;

    // Batch check + prefetch (same optimization as importRecentOrders).
    // Escopado por marketplaceAccountId — o unique é composto, não global.
    const externalIds = mlOrders.map((o) => o.id.toString());
    const existingOrders = await prisma.order.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalOrderId: { in: externalIds },
      },
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
      {
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        shopId: account.shopId,
      },
      days,
    );

    result.totalOrders = shopeeOrders.length;

    // Batch check + prefetch (same optimization as ML imports).
    // Escopado por marketplaceAccountId — o unique é composto, não global.
    const externalIds = (shopeeOrders as ShopeeOrderDetail[]).map(
      (o) => o.order_sn,
    );
    const existingOrders = await prisma.order.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalOrderId: { in: externalIds },
      },
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
      const exists = await orderRepository.exists(
        marketplaceAccountId,
        externalOrderId,
      );
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
      const product = await this.findProductByFallbackSku(sku, userId);

      if (!product) {
        console.log(`[OrderUseCase] Produto com SKU "${sku}" não encontrado`);
        continue;
      }

      const fallbackListing = await this.upsertFallbackListing({
        productId: product.id,
        marketplaceAccountId,
        externalListingId,
        externalSku: sku,
      });

      items.push({
        productId: product.id,
        listingId: fallbackListing?.id ?? null,
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

  private static async findProductByFallbackSku(
    sku: string | null,
    userId?: string,
  ) {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) {
      return null;
    }

    return prisma.product.findFirst({
      where: userId
        ? { skuNormalized: normalizedSku, userId }
        : { skuNormalized: normalizedSku },
    });
  }

  private static async upsertFallbackListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
  }) {
    try {
      return await ListingRepository.upsertFromOrderFallback({
        ...data,
        status: "active",
      });
    } catch (error) {
      console.error(
        `[OrderUseCase] Erro ao materializar listing via fallback para ${data.marketplaceAccountId}/${data.externalListingId}:`,
        error,
      );
      return null;
    }
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

      const product = await this.findProductByFallbackSku(sku, userId);

      if (!product) {
        console.log(
          `[OrderUseCase] Produto com SKU "${sku}" (Shopee) não encontrado`,
        );
        continue;
      }

      const fallbackListing = await this.upsertFallbackListing({
        productId: product.id,
        marketplaceAccountId,
        externalListingId,
        externalSku: sku,
      });

      result.push({
        productId: product.id,
        listingId: fallbackListing?.id ?? null,
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

      const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
        account.id,
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
   * Desconta estoque dos produtos de um pedido de forma atômica.
   *
   * Garante serialização via `SELECT ... FOR UPDATE` por produto, evitando
   * TOCTOU entre webhooks concorrentes de marketplaces diferentes.
   * Enfileira jobs duráveis de sincronização cross-marketplace dentro da
   * mesma transação, garantindo que nenhum decremento fique sem propagação.
   */
  private static async deductStockForOrder(
    order: Order,
    reason: string,
  ): Promise<OrderStockDeduction[]> {
    const deductions: OrderStockDeduction[] = [];

    const orderItems = order.items;
    if (!orderItems || orderItems.length === 0) return deductions;

    const oversellAlerts: Array<{
      productId: string;
      productName: string;
      requested: number;
      available: number;
    }> = [];

    try {
      await prisma.$transaction(async (tx) => {
        for (const item of orderItems) {
          // Lock da linha do produto até o fim da transação.
          const locked = await tx.$queryRaw<
            { id: string; name: string; stock: number }[]
          >`SELECT id, name, stock FROM "Product" WHERE id = ${item.productId} FOR UPDATE`;

          const product = locked[0];
          if (!product) continue;

          const previousStock = product.stock;
          const decrementBy = Math.min(item.quantity, Math.max(0, previousStock));
          const newStock = previousStock - decrementBy;

          await tx.product.update({
            where: { id: item.productId },
            data: { stock: newStock },
          });

          await tx.stockLog.create({
            data: {
              productId: item.productId,
              change: -decrementBy,
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

          if (decrementBy < item.quantity) {
            oversellAlerts.push({
              productId: item.productId,
              productName: product.name,
              requested: item.quantity,
              available: previousStock,
            });
          }

          console.log(
            `[OrderUseCase] Stock deducted: ${product.name} (${previousStock} → ${newStock})`,
          );

          // Enfileira sync durável para cada listing vinculado ao produto.
          const listings = await tx.productListing.findMany({
            where: { productId: item.productId },
            include: { marketplaceAccount: { select: { platform: true } } },
          });

          for (const listing of listings) {
            // Serializa com StockReconciliationService pelo mesmo listing para
            // evitar P2002 no upsert não-atômico do Prisma: ambos lados pegam
            // o mesmo advisory lock antes de SELECT/INSERT.
            await tx.$queryRaw<
              unknown[]
            >`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;

            await tx.stockSyncJob.upsert({
              where: {
                listingId_status: {
                  listingId: listing.id,
                  status: "PENDING",
                },
              },
              create: {
                productId: item.productId,
                listingId: listing.id,
                platform: listing.marketplaceAccount.platform,
                targetStock: newStock,
                orderId: order.id,
                status: "PENDING",
              },
              update: {
                targetStock: newStock,
                attempts: 0,
                nextRunAt: new Date(),
                lastError: null,
                orderId: order.id,
              },
            });
          }
        }
      });
    } catch (error) {
      console.error(
        `[OrderUseCase] Error in stock deduction transaction:`,
        error,
      );
      return deductions;
    }

    // Dispara processamento imediato dos jobs recém-enfileirados (best-effort;
    // se falhar, o interval do service pegará no próximo ciclo).
    if (deductions.length > 0) {
      setImmediate(() => {
        void import("../services/stock-sync-retry.service")
          .then(({ StockSyncRetryService }) => StockSyncRetryService.runOnce())
          .catch((err) =>
            console.error(
              "[OrderUseCase] Falha ao disparar StockSyncRetryService.runOnce:",
              err,
            ),
          );
      });
    }

    if (oversellAlerts.length > 0) {
      try {
        await SystemLogService.logWarning(
          "OVERSELL_DETECTED",
          `Oversell detectado no pedido ${order.id}: ${oversellAlerts.length} item(ns) com quantidade maior que estoque disponível`,
          {
            resource: "Order",
            resourceId: order.id,
            details: {
              orderId: order.id,
              platform: order.marketplaceAccount?.platform ?? null,
              items: oversellAlerts,
              reason,
            },
          },
        );
      } catch (logError) {
        console.error(
          "[OrderUseCase] Falha ao registrar OVERSELL_DETECTED:",
          logError,
        );
      }
    }

    return deductions;
  }

  private static async syncMarketplaceStockForProducts(
    productIds: string[],
    context: SyncLogContext = {},
  ): Promise<void> {
    const uniqueProductIds = [...new Set(productIds.filter(Boolean))];
    if (uniqueProductIds.length === 0) return;

    const syncResults = await Promise.allSettled(
      uniqueProductIds.map((productId) => SyncUseCase.syncProductStock(productId)),
    );

    let totalListings = 0;
    let successCount = 0;
    let failureCount = 0;
    const failedPlatforms = new Set<string>();

    syncResults.forEach((result, index) => {
      const productId = uniqueProductIds[index];
      if (result.status === "rejected") {
        failureCount++;
        failedPlatforms.add("UNKNOWN");
        console.error(
          `[OrderUseCase] Error syncing marketplace stock for product ${productId}:`,
          result.reason,
        );
        return;
      }

      totalListings += result.value.length;
      successCount += result.value.filter((entry) => entry.success).length;
      const failedListings = result.value.filter((entry) => !entry.success).length;
      failureCount += failedListings;

      result.value
        .filter((entry) => !entry.success)
        .forEach((entry) => failedPlatforms.add(entry.platform ?? "UNKNOWN"));

      if (failedListings > 0) {
        console.warn(
          `[OrderUseCase] Marketplace stock sync finished with ${failedListings} failed listing(s) for product ${productId}`,
        );
      }
    });

    const details = {
      orderId: context.orderId ?? null,
      platform: context.platform ?? "UNKNOWN",
      totalListings,
      successCount,
      failureCount,
      failedPlatforms: [...failedPlatforms],
      productIds: uniqueProductIds,
    };

    const message =
      failureCount > 0
        ? `Sincronização cross-marketplace do pedido ${context.orderId ?? "sem-id"} finalizada com falhas parciais`
        : `Sincronização cross-marketplace do pedido ${context.orderId ?? "sem-id"} concluída`;

    try {
      if (failureCount > 0) {
        await SystemLogService.logWarning("SYNC_STOCK", message, {
          resource: "Order",
          resourceId: context.orderId,
          details,
        });
      } else {
        await SystemLogService.logInfo("SYNC_STOCK", message, {
          resource: "Order",
          resourceId: context.orderId,
          details,
        });
      }
    } catch (error) {
      console.error(
        "[OrderUseCase] Falha ao registrar log agregado de sincronização:",
        error,
      );
    }
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


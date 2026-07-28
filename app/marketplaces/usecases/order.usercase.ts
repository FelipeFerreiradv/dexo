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
import { MagaluApiService } from "../services/magalu-api.service";
import { MagaluOAuthService } from "../services/magalu-oauth.service";
import {
  StockDeductionService,
  type StockDeductionResult,
  type StockOversellAlert,
} from "../services/stock-deduction.service";
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { OrderCustomerService } from "../services/order-customer.service";
import { SyncUseCase } from "./sync.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import { normalizeSku } from "@/app/lib/sku";
import type { MLOrderDetails, MLOrderItem } from "../types/ml-order.types";
import type {
  ShopeeOrderDetail,
  ShopeeOrderItem,
} from "../types/shopee-api.types";
import type {
  MagaluOrder,
  MagaluOrderItem,
} from "../types/magalu-order.types";
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

export interface OrderCancellationResult {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  action:
    | "disabled"
    | "not_found"
    | "already_cancelled"
    | "cancelled_restored"
    | "cancelled_no_restore"
    | "error";
  restoredItems: number;
  message?: string;
}

export interface OrderUncancellationResult {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  action:
    | "disabled"
    | "not_found"
    | "not_cancelled"
    | "reactivated_rededucted"
    | "reactivated_no_deduct"
    | "error";
  deductedItems: number;
  message?: string;
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

    const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
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
    maxOrders: number = 500,
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
      maxOrders,
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

    // EGRESS: o listingMap só é consumido por processOrder, que só roda para
    // pedidos NOVOS. Em regime estável (nenhum pedido novo no ciclo) NÃO relemos
    // todos os anúncios da conta (com product) — antes isso era feito a cada
    // ciclo de 15 min por conta, relendo o catálogo inteiro = grosso do egress.
    // Comportamento idêntico: quando há pedido novo, o mapa é montado igual.
    const hasNewOrders = mlOrders.some(
      (o) => !existingSet.has(o.id.toString()),
    );
    const listingMap = new Map<string, any>();
    if (hasNewOrders) {
      const accountListings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        // EGRESS: select mínimo. mapOrderItems/mapShopeeOrderItems usam APENAS
        // listing.id, listing.productId e checam se listing.product EXISTE —
        // nenhum campo do product é lido. Antes o include puxava o product
        // inteiro (name/description/imageUrl/...) de TODOS os anúncios.
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          externalListingId: true,
          product: { select: { id: true } },
        },
      });
      for (const l of accountListings) {
        listingMap.set(`${l.marketplaceAccountId}_${l.externalListingId}`, l);
      }
    }

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
          // ADITIVO (auto-cliente): best-effort, nunca afeta o import.
          // Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho
          // atual byte-idêntico. Sequencial (await) para o 2º pedido do mesmo
          // comprador no batch deduplicar contra o 1º.
          if (importResult.orderId) {
            try {
              await OrderCustomerService.ensureCustomerForOrder({
                platform: "MERCADO_LIVRE",
                marketplaceAccountId: account.id,
                orderId: importResult.orderId,
                externalOrderId: importResult.externalOrderId,
                fallbackName: this.extractCustomerName(mlOrder) ?? null,
              });
            } catch {
              /* nunca propaga — um throw aqui abortaria o batch inteiro */
            }
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
    const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
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

    // EGRESS: idem ML — só relê todos os anúncios da conta (com product) se
    // houver pedido novo no ciclo (listingMap só é usado em pedidos novos).
    const hasNewOrders = (shopeeOrders as ShopeeOrderDetail[]).some(
      (o) => !existingSet.has(o.order_sn),
    );
    const listingMap = new Map<string, any>();
    if (hasNewOrders) {
      const accountListings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        // EGRESS: select mínimo. mapOrderItems/mapShopeeOrderItems usam APENAS
        // listing.id, listing.productId e checam se listing.product EXISTE —
        // nenhum campo do product é lido. Antes o include puxava o product
        // inteiro (name/description/imageUrl/...) de TODOS os anúncios.
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          externalListingId: true,
          product: { select: { id: true } },
        },
      });
      for (const l of accountListings) {
        listingMap.set(`${l.marketplaceAccountId}_${l.externalListingId}`, l);
      }
    }

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
          try {
            await this.deductStockForOrder(
              created,
              `Venda Shopee #${externalOrderId}`,
            );
            stockDeducted = true;
          } catch (err) {
            console.error(
              `[OrderUseCase] Falha ao descontar estoque para pedido Shopee #${externalOrderId} (order=${created.id}). Estoque NÃO foi descontado.`,
              err,
            );
          }
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

        // ADITIVO (auto-cliente): best-effort, nunca afeta o import.
        // Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho atual
        // byte-idêntico. Try/catch próprio: um throw vazado cairia no catch
        // externo e empurraria um segundo result para o mesmo pedido.
        try {
          await OrderCustomerService.ensureCustomerForOrder({
            platform: "SHOPEE",
            marketplaceAccountId,
            orderId: created.id,
            externalOrderId,
            fallbackName: shopeeOrder.buyer_username ?? null,
          });
        } catch {
          /* nunca propaga */
        }
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
        try {
          await this.deductStockForOrder(order, `Venda ML #${externalOrderId}`);
          stockDeducted = true;
        } catch (err) {
          console.error(
            `[OrderUseCase] Falha ao descontar estoque para pedido ML #${externalOrderId} (order=${order.id}). Estoque NÃO foi descontado.`,
            err,
          );
        }
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
  // ====================================================================
  // MAGALU — importação de pedidos + baixa automática (espelha Shopee)
  // ====================================================================

  /**
   * Importa pedidos recentes da Magalu de todas as contas ativas do usuário.
   */
  static async importRecentMagaluOrders(
    userId: string,
    days: number = 7,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
      userId,
      Platform.MAGALU,
    );

    const validAccounts =
      accounts?.filter((acc) => acc.accessToken && acc.externalUserId) ?? [];

    if (validAccounts.length === 0) {
      throw new Error("Conta da Magalu não conectada ou sem credenciais");
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

    for (const account of validAccounts) {
      try {
        const result = await this.importRecentMagaluOrdersForAccount(
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
              : "Erro ao importar conta Magalu",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: 0,
        });
      }
    }

    return aggregated;
  }

  /**
   * Importa pedidos recentes da Magalu para uma conta específica.
   */
  static async importRecentMagaluOrdersForAccount(
    marketplaceAccountId: string,
    days: number = 7,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const account = await MarketplaceRepository.findById(marketplaceAccountId);
    if (!account || !account.accessToken || !account.externalUserId) {
      throw new Error("Conta Magalu não encontrada ou sem credenciais");
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

    const magaluOrders = await this.getRecentMagaluOrdersWithRefresh(
      {
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
      },
      days,
    );

    result.totalOrders = magaluOrders.length;

    const extractExternalOrderId = (o: MagaluOrder): string =>
      String(o.id ?? o.code ?? o.order_id ?? "");

    const externalIds = magaluOrders
      .map((o) => extractExternalOrderId(o))
      .filter(Boolean);
    const existingOrders = await prisma.order.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalOrderId: { in: externalIds },
      },
      // EGRESS: status junto no select já existente (bytes desprezíveis) —
      // permite o gate de cancelamento abaixo pular o handler para pedidos
      // já CANCELLED localmente, zerando o custo recorrente por ciclo.
      select: { externalOrderId: true, status: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.externalOrderId));
    const existingStatusByExtId = new Map(
      existingOrders.map((o) => [o.externalOrderId, o.status]),
    );

    // EGRESS: idem ML/Shopee — só relê os anúncios da conta se houver pedido novo.
    const hasNewOrders = magaluOrders.some(
      (o) => !existingSet.has(extractExternalOrderId(o)),
    );
    const listingMap = new Map<string, any>();
    if (hasNewOrders) {
      const accountListings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          externalListingId: true,
          product: { select: { id: true } },
        },
      });
      for (const l of accountListings) {
        listingMap.set(`${l.marketplaceAccountId}_${l.externalListingId}`, l);
      }
    }

    for (const magaluOrder of magaluOrders) {
      const externalOrderId = extractExternalOrderId(magaluOrder);
      const itemList = magaluOrder.items ?? [];
      try {
        if (!externalOrderId) {
          result.errors++;
          continue;
        }

        if (existingSet.has(externalOrderId)) {
          result.results.push({
            success: true,
            orderId: null,
            externalOrderId,
            status: "already_exists",
            message: "Pedido já importado anteriormente",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: itemList.length,
          });
          result.alreadyExists++;
          // ADITIVO (cancelamento): pedido já importado que aparece cancelado
          // no poll da API Magalu → estorno via handler idempotente (fast-path
          // barato quando já está CANCELLED). Best-effort: o handler nunca
          // lança e nada aqui toca contadores/results do import.
          // Gate pelo status RAW, não pelo mapeado: "unavailable" também
          // mapeia para CANCELLED, mas é cancelamento por INDISPONIBILIDADE
          // (o vendedor declarou que a peça não existe) — estornar criaria
          // estoque fantasma e oversell cross-channel. Não tocar.
          const rawMagaluStatus = String(
            magaluOrder.status ?? "",
          ).toLowerCase();
          if (
            process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1" &&
            (rawMagaluStatus === "cancelled" ||
              rawMagaluStatus === "canceled") &&
            // EGRESS: já CANCELLED local (snapshot deste ciclo) ⇒ o handler
            // seria fast-path no-op — pular poupa 1 query por cancelado por
            // ciclo, para sempre. Snapshot stale ⇒ no pior caso o handler
            // idempotente roda uma vez a mais (inofensivo).
            existingStatusByExtId.get(externalOrderId) !== "CANCELLED"
          ) {
            const cancelResult = await this.processOrderCancellation({
              marketplaceAccountId,
              externalOrderId,
              platformLabel: "Magalu",
            });
            // Loga só na transição real (evita re-logar o mesmo cancelado a
            // cada ciclo de poll enquanto ele estiver na janela).
            if (
              cancelResult.action === "cancelled_restored" ||
              cancelResult.action === "cancelled_no_restore"
            ) {
              void SystemLogService.logInfo(
                "MAGALU_CANCEL_DETECTED",
                `Pedido Magalu #${externalOrderId} consta cancelado no marketplace (${cancelResult.action})`,
                {
                  resource: "Order",
                  details: {
                    externalOrderId,
                    marketplaceAccountId,
                    rawStatus: magaluOrder.status ?? null,
                    action: cancelResult.action,
                    restoredItems: cancelResult.restoredItems,
                  },
                },
              ).catch(() => {});
            }
          }
          continue;
        }

        // Só importa/deduz pedidos em VENDA CONFIRMADA (PAID/SHIPPED/DELIVERED).
        // Espelha ML (getRecentOrders status="paid") e Shopee (API já devolve só
        // pós-venda); como o getRecentOrders da Magalu NÃO filtra por status,
        // pulamos PENDING/CANCELLED aqui — quando virarem pagos, o próximo ciclo
        // (poll/webhook) reimporta e desconta uma única vez. Evita baixar estoque
        // de pedido ainda não pago / depois cancelado.
        const mappedStatus = this.mapMagaluStatus(magaluOrder.status);
        if (
          mappedStatus !== "PAID" &&
          mappedStatus !== "SHIPPED" &&
          mappedStatus !== "DELIVERED"
        ) {
          continue;
        }

        const { items, linkedCount } = await this.mapMagaluOrderItems(
          itemList,
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
            message: "Nenhum item do pedido Magalu pôde ser vinculado",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: itemList.length,
          });
          result.noProducts++;
          continue;
        }

        const rawTotal =
          magaluOrder.total ?? magaluOrder.total_amount ?? magaluOrder.amount;
        const totalAmount =
          typeof rawTotal === "number" && Number.isFinite(rawTotal)
            ? Number(rawTotal)
            : items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

        const orderData: OrderCreate = {
          marketplaceAccountId,
          externalOrderId,
          status: mappedStatus,
          totalAmount,
          customerName:
            magaluOrder.customer_name ??
            magaluOrder.buyer?.name ??
            undefined,
          items,
        };

        const created = await orderRepository.create(orderData);

        let stockDeducted = false;
        if (deductStock) {
          try {
            await this.deductStockForOrder(
              created,
              `Venda Magalu #${externalOrderId}`,
            );
            stockDeducted = true;
          } catch (err) {
            console.error(
              `[OrderUseCase] Falha ao descontar estoque para pedido Magalu #${externalOrderId} (order=${created.id}). Estoque NÃO foi descontado.`,
              err,
            );
          }
        }

        result.imported++;
        result.stockDeductions += stockDeducted ? 1 : 0;
        result.results.push({
          success: true,
          orderId: created.id,
          externalOrderId,
          status: "imported",
          message: "Pedido Magalu importado com sucesso",
          stockDeducted,
          itemsLinked: linkedCount,
          itemsTotal: itemList.length,
        });

        // ADITIVO (auto-cliente): best-effort, nunca afeta o import.
        // Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho atual
        // byte-idêntico. Try/catch próprio: um throw vazado cairia no catch
        // externo e empurraria um segundo result para o mesmo pedido.
        try {
          await OrderCustomerService.ensureCustomerForOrder({
            platform: "MAGALU",
            marketplaceAccountId,
            orderId: created.id,
            externalOrderId,
            fallbackName:
              magaluOrder.customer_name ?? magaluOrder.buyer?.name ?? null,
          });
        } catch {
          /* nunca propaga */
        }
      } catch (error) {
        const isPrismaUniqueError =
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as any).code === "P2002";
        if (isPrismaUniqueError) {
          result.results.push({
            success: true,
            orderId: null,
            externalOrderId,
            status: "already_exists",
            message: "Pedido já importado (corrida concorrente)",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: itemList.length,
          });
          result.alreadyExists++;
          continue;
        }
        result.errors++;
        result.results.push({
          success: false,
          orderId: null,
          externalOrderId,
          status: "error",
          message:
            error instanceof Error ? error.message : "Erro ao importar pedido",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: itemList.length,
        });
      }
    }

    return result;
  }

  private static async mapMagaluOrderItems(
    items: MagaluOrderItem[],
    userId: string | undefined,
    marketplaceAccountId: string,
    listingMap?: Map<string, any>,
  ): Promise<{ items: OrderItemCreate[]; linkedCount: number }> {
    const result: OrderItemCreate[] = [];
    let linkedCount = 0;

    for (const item of items) {
      const externalListingId = String(
        item.product_id ?? item.sku ?? item.seller_sku ?? "",
      );
      const quantity = Number(item.quantity ?? item.qty ?? 0) || 0;
      const unitPrice = Number(item.unit_price ?? item.price ?? 0) || 0;

      // A Magalu é o único mapper cuja quantidade cai para 0 quando o campo
      // real do payload tem outro nome (o tipo MagaluOrderItem é declaradamente
      // não-validado). Quantidade 0 faz `deductWithinTx` descontar zero em
      // silêncio — e SEM alerta de oversell, porque o alerta só dispara com
      // quantity > estoque. Este log é o único sinal de que a venda entrou sem
      // baixar estoque.
      if (quantity <= 0) {
        console.warn(
          JSON.stringify({
            event: "magalu.order.item_quantity_missing",
            externalListingId: externalListingId || null,
            marketplaceAccountId,
            itemKeys: Object.keys(item ?? {}),
          }),
        );
      }

      const cacheKey = `${marketplaceAccountId}_${externalListingId}`;
      const listing =
        externalListingId && listingMap
          ? listingMap.get(cacheKey)
          : externalListingId
            ? await prisma.productListing.findUnique({
                where: {
                  marketplaceAccountId_externalListingId: {
                    marketplaceAccountId,
                    externalListingId,
                  },
                },
                include: { product: true },
              })
            : null;

      if (listing && listing.product) {
        result.push({
          productId: listing.productId,
          listingId: listing.id,
          quantity,
          unitPrice,
        });
        linkedCount++;
        continue;
      }

      const sku = this.extractSkuFromMagalu(item);
      if (!sku) {
        console.log(
          `[OrderUseCase] Item Magalu ${externalListingId || "(sem id)"} sem SKU e sem listing vinculado, pulando`,
        );
        continue;
      }

      const product = await this.findProductByFallbackSku(sku, userId);
      if (!product) {
        console.log(
          `[OrderUseCase] Produto com SKU "${sku}" (Magalu) não encontrado`,
        );
        continue;
      }

      const fallbackListing = await this.upsertFallbackListing({
        productId: product.id,
        marketplaceAccountId,
        externalListingId: externalListingId || sku,
        externalSku: sku,
      });

      result.push({
        productId: product.id,
        listingId: fallbackListing?.id ?? null,
        quantity,
        unitPrice,
      });
      linkedCount++;
    }

    return { items: result, linkedCount };
  }

  private static extractSkuFromMagalu(item: MagaluOrderItem): string | null {
    return (
      (item.seller_sku as string) ||
      (item.sku as string) ||
      (item.product_sku as string) ||
      null
    );
  }

  private static mapMagaluStatus(status?: string): OrderStatus {
    switch ((status ?? "").toLowerCase()) {
      case "delivered":
        return "DELIVERED";
      case "shipped":
        return "SHIPPED";
      case "approved":
      case "processing":
      case "invoiced":
        return "PAID";
      case "cancelled":
      case "canceled":
      case "unavailable":
        return "CANCELLED";
      case "new":
      default:
        return "PENDING";
    }
  }

  private static async getRecentMagaluOrdersWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
    },
    days: number,
  ): Promise<MagaluOrder[]> {
    try {
      return await MagaluApiService.getRecentOrders(account.accessToken, days);
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });

      return MagaluApiService.getRecentOrders(refreshed.accessToken, days);
    }
  }

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
    maxOrders: number = 500,
  ): Promise<MLOrderDetails[]> {
    try {
      return await MLApiService.getRecentOrders(
        account.accessToken,
        account.externalUserId,
        days,
        "paid",
        maxOrders,
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
        maxOrders,
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
   * Wrapper fino sobre `StockDeductionService` (Fase 3 do plano venda-balcão).
   * O núcleo in-transação (FOR UPDATE → stockLog → advisory lock → upsert do
   * StockSyncJob) e o efeito pós-commit (setImmediate runOnce) vivem no
   * service compartilhado e são reutilizados pelo `FinanceUseCase.markPaid`.
   *
   * Comportamento preservado byte-idêntico: mesmos opts de tx
   * ({ timeout: 60_000, maxWait: 20_000 }), mesmo `logPrefix "[OrderUseCase]"`,
   * mesmo log de oversell ("Oversell detectado no pedido ${order.id}..."),
   * mesmo retorno `OrderStockDeduction[]`. `pauseOnZero` NÃO é passado —
   * Order não pausa anúncios ao zerar (opt-in apenas para venda balcão).
   */
  private static async deductStockForOrder(
    order: Order,
    reason: string,
  ): Promise<OrderStockDeduction[]> {
    const orderItems = order.items;
    if (!orderItems || orderItems.length === 0) return [];

    let deductions: OrderStockDeduction[] = [];
    let oversellAlerts: StockOversellAlert[] = [];

    try {
      await prisma.$transaction(
        async (tx) => {
          // ADITIVO (cancelamento): nunca baixar estoque de pedido já
          // CANCELLED. O SELECT FOR UPDATE na linha do Order serializa com o
          // claim do processOrderCancellation (updateMany na mesma linha):
          // se o cancelamento está em voo, esperamos o commit dele e lemos
          // CANCELLED ⇒ pulamos a baixa; se a baixa vence, o cancelamento
          // espera e o net do StockLog enxerga a baixa commitada ⇒ estorna.
          // Ordem de locks (Order → Products) idêntica nos dois lados ⇒ sem
          // deadlock. Fora do fluxo de cancelamento o status nunca é
          // CANCELLED neste ponto (pedido recém-criado) ⇒ comportamento
          // idêntico ao atual. Kill-switch restaura o caminho byte-idêntico.
          if (process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1") {
            const fresh = await tx.$queryRaw<
              { status: string }[]
            >`SELECT status FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
            if (fresh[0]?.status === "CANCELLED") {
              console.log(
                `[OrderUseCase] Pedido ${order.id} já cancelado — baixa de estoque pulada (${reason}).`,
              );
              return;
            }
          }
          const result = await StockDeductionService.deductWithinTx(tx, {
            items: orderItems.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
            })),
            reason,
            orderId: order.id,
            logPrefix: "[OrderUseCase]",
          });
          deductions = result.deductions;
          oversellAlerts = result.oversellAlerts;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    } catch (error) {
      console.error(
        `[OrderUseCase] Error in stock deduction transaction (order=${order.id}):`,
        error,
      );
      throw error;
    }

    StockDeductionService.firePostEffects({
      deductions,
      logPrefix: "[OrderUseCase]",
      reason,
      // NÃO passamos pauseOnZero → Order não pausa anúncios ao zerar.
    });

    // Log de oversell preservado byte-idêntico (mesma message + details).
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

  /**
   * Cancela um pedido JÁ IMPORTADO devolvendo ao estoque exatamente o que
   * foi baixado na importação e reabrindo anúncios cujos produtos saíram de
   * zero (`firePostEffects.reopenOnRefill` — paused→active nas 3 plataformas).
   *
   * Idempotência (webhooks repetem; chamadas concorrem):
   *  1. Claim atômico por transição de status na MESMA tx do estorno —
   *     qualquer status ≠ CANCELLED → CANCELLED via updateMany; quem não
   *     vence o claim não estorna. Já CANCELLED → no-op sem abrir tx.
   *     PENDING também entra no claim: existem pedidos PENDING COM baixa
   *     (ex.: Shopee TO_CONFIRM_RECEIVE mapeia para PENDING e o importador
   *     Shopee deduz incondicionalmente) — o net do StockLog decide se há
   *     algo a estornar (pedido sem baixa ⇒ net 0 ⇒ só status).
   *  2. Quantidades pelo "net" do StockLog (baixa − estornos anteriores, com
   *     teto na quantidade do pedido) — estorna só o que foi de fato baixado
   *     (cobre baixa clampada por oversell, pedido sem baixa e flip-flop de
   *     status via PATCH manual).
   *
   * NUNCA lança: os callers são setImmediate fire-and-forget (webhooks) e o
   * loop de poll — erro vira `{ action: "error" }` + SystemLog, e o rollback
   * da tx deixa o estado consistente para a próxima entrega/poll.
   * Kill-switch: ORDER_CANCEL_RESTORE_DISABLED=1 desliga tudo.
   */
  static async processOrderCancellation(params: {
    marketplaceAccountId: string;
    externalOrderId: string;
    platformLabel: "ML" | "Shopee" | "Magalu";
    logPrefix?: string;
  }): Promise<OrderCancellationResult> {
    const { marketplaceAccountId, externalOrderId, platformLabel } = params;
    const logPrefix = params.logPrefix ?? "[OrderUseCase]";
    try {
      if (process.env.ORDER_CANCEL_RESTORE_DISABLED === "1") {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "disabled",
          restoredItems: 0,
        };
      }

      const order = await prisma.order.findFirst({
        where: { marketplaceAccountId, externalOrderId },
        select: {
          id: true,
          status: true,
          items: { select: { productId: true, quantity: true } },
          marketplaceAccount: { select: { userId: true } },
        },
      });
      if (!order) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "not_found",
          restoredItems: 0,
        };
      }
      if (order.status === "CANCELLED") {
        return {
          success: true,
          orderId: order.id,
          externalOrderId,
          action: "already_cancelled",
          restoredItems: 0,
        };
      }

      // Reasons determinísticas: a da baixa é a string EXATA escrita na
      // importação; estorno e reativação (un-cancel) entram no mesmo net
      // (repetição ⇒ net 0; alternância cancel/un-cancel converge).
      const deductionReason = `Venda ${platformLabel} #${externalOrderId}`;
      const restoreReason = `Estorno venda ${platformLabel} #${externalOrderId}`;
      const reactivateReason = `Reativação venda ${platformLabel} #${externalOrderId}`;

      // Teto do estorno por produto (agrega itens repetidos do mesmo produto).
      const orderedQty = new Map<string, number>();
      for (const item of order.items) {
        orderedQty.set(
          item.productId,
          (orderedQty.get(item.productId) ?? 0) + item.quantity,
        );
      }
      const productIds = [...orderedQty.keys()];

      let restorations: StockDeductionResult[] = [];
      let action: OrderCancellationResult["action"] = "already_cancelled";

      await prisma.$transaction(
        async (tx) => {
          // 1. Claim atômico: só quem transiciona o status estorna
          //    (concorrente bloqueia no row-lock e reavalia ⇒ count 0).
          //    PENDING incluso — o net do StockLog decide o estorno.
          const claimed = await tx.order.updateMany({
            where: {
              id: order.id,
              status: { in: ["PENDING", "PAID", "SHIPPED", "DELIVERED"] },
            },
            data: { status: "CANCELLED" },
          });
          if (claimed.count === 0) {
            action = "already_cancelled";
            return;
          }

          if (productIds.length === 0) {
            action = "cancelled_no_restore";
            return;
          }

          // 2. Lock dos produtos (mesma ordem de lock do motor de estoque)
          //    ANTES do net — serializa com uma baixa em voo do importador.
          for (const productId of productIds) {
            await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
          }

          // 3. Net do StockLog: baixa + re-deduções de reativação (change<0)
          //    e estornos anteriores (change>0) ⇒ a estornar = max(0, -Σ),
          //    com teto no pedido.
          const grouped = await tx.stockLog.groupBy({
            by: ["productId"],
            where: {
              productId: { in: productIds },
              reason: {
                in: [deductionReason, restoreReason, reactivateReason],
              },
            },
            _sum: { change: true },
          });
          const netByProduct = new Map(
            grouped.map((g) => [g.productId, g._sum.change ?? 0]),
          );
          const items = productIds
            .map((productId) => ({
              productId,
              quantity: Math.min(
                Math.max(0, -(netByProduct.get(productId) ?? 0)),
                orderedQty.get(productId)!,
              ),
            }))
            .filter((i) => i.quantity > 0);

          if (items.length === 0) {
            action = "cancelled_no_restore";
            return;
          }

          const result = await StockDeductionService.restoreWithinTx(tx, {
            items,
            reason: restoreReason,
            orderId: order.id,
            logPrefix,
          });
          restorations = result.deductions;
          action = "cancelled_restored";
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      // Pós-commit: sync de estoque + reabertura de anúncios que saíram de
      // zero. Best-effort, fora da tx (espelha FinanceUseCase.reverse).
      // SEM pauseOnZero — pedido não pausa anúncios. force: quando o estoque
      // zera por venda de marketplace, o sync pausa o item ML só REMOTAMENTE
      // (status local segue "active") — sem force, o fast-path alreadyInState
      // do updateListingStatus faria no-op e o anúncio ficaria pausado para
      // sempre apesar do estoque restaurado.
      if (restorations.length > 0) {
        StockDeductionService.firePostEffects({
          deductions: restorations,
          logPrefix,
          reopenOnRefill: {
            userId: order.marketplaceAccount.userId,
            force: true,
          },
        });
      }

      void SystemLogService.logInfo(
        "ORDER_CANCEL_RESTORE",
        `Pedido ${platformLabel} #${externalOrderId} cancelado (${action})`,
        {
          resource: "Order",
          resourceId: order.id,
          details: {
            action,
            marketplaceAccountId,
            externalOrderId,
            restored: restorations.map((r) => ({
              productId: r.productId,
              quantity: r.quantity,
              previousStock: r.previousStock,
              newStock: r.newStock,
            })),
          },
        },
      ).catch(() => {});

      return {
        success: true,
        orderId: order.id,
        externalOrderId,
        action,
        restoredItems: restorations.length,
      };
    } catch (error) {
      console.error(
        `${logPrefix} Falha no cancelamento ${platformLabel} #${externalOrderId}:`,
        error,
      );
      void SystemLogService.logError(
        "ORDER_CANCEL_RESTORE_FAILED",
        `Falha ao processar cancelamento do pedido ${platformLabel} #${externalOrderId}`,
        {
          resource: "Order",
          details: {
            marketplaceAccountId,
            externalOrderId,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ).catch(() => {});
      return {
        success: false,
        orderId: null,
        externalOrderId,
        action: "error",
        restoredItems: 0,
        message: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  /**
   * Reativa um pedido CANCELLED (un-cancel via PATCH manual) re-deduzindo o
   * estoque que o cancelamento estornou — simétrico ao
   * `processOrderCancellation`, mesmo claim atômico e mesma ordem de locks
   * (Order → Products).
   *
   * Net separável por reason: a re-dedução escreve com reason PRÓPRIA
   * ("Reativação venda <Label> #<extId>") — a deduzir =
   * max(0, Σ[estorno, reativação]) com teto na quantidade do pedido.
   * Repetição ⇒ 0; pedido cujo cancelamento nada estornou ⇒ 0 (nunca deduz
   * estoque "novo"); alternância cancel/un-cancel converge porque o net do
   * cancelamento também soma a reason de reativação.
   *
   * Se a peça foi vendida em outro canal nesse meio-tempo, o clamp do
   * `deductWithinTx` deduz o disponível e o oversell é alertado (mesmo
   * mecanismo da importação).
   *
   * NUNCA lança — o caller (rota PATCH) decide o HTTP pelo retorno.
   * Kill-switch: ORDER_CANCEL_RESTORE_DISABLED=1 desliga tudo.
   */
  static async processOrderUncancellation(params: {
    marketplaceAccountId: string;
    externalOrderId: string;
    platformLabel: "ML" | "Shopee" | "Magalu";
    targetStatus: "PAID" | "SHIPPED" | "DELIVERED";
    logPrefix?: string;
  }): Promise<OrderUncancellationResult> {
    const { marketplaceAccountId, externalOrderId, platformLabel } = params;
    const logPrefix = params.logPrefix ?? "[OrderUseCase]";
    try {
      if (process.env.ORDER_CANCEL_RESTORE_DISABLED === "1") {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "disabled",
          deductedItems: 0,
        };
      }

      const order = await prisma.order.findFirst({
        where: { marketplaceAccountId, externalOrderId },
        select: {
          id: true,
          status: true,
          items: { select: { productId: true, quantity: true } },
          marketplaceAccount: { select: { platform: true } },
        },
      });
      if (!order) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "not_found",
          deductedItems: 0,
        };
      }
      if (order.status !== "CANCELLED") {
        return {
          success: true,
          orderId: order.id,
          externalOrderId,
          action: "not_cancelled",
          deductedItems: 0,
        };
      }

      const restoreReason = `Estorno venda ${platformLabel} #${externalOrderId}`;
      const reactivateReason = `Reativação venda ${platformLabel} #${externalOrderId}`;

      const orderedQty = new Map<string, number>();
      for (const item of order.items) {
        orderedQty.set(
          item.productId,
          (orderedQty.get(item.productId) ?? 0) + item.quantity,
        );
      }
      const productIds = [...orderedQty.keys()];

      let deductions: StockDeductionResult[] = [];
      let oversellAlerts: StockOversellAlert[] = [];
      let action: OrderUncancellationResult["action"] = "not_cancelled";

      await prisma.$transaction(
        async (tx) => {
          // 1. Claim atômico CANCELLED → targetStatus (concorrente ⇒ count 0).
          const claimed = await tx.order.updateMany({
            where: { id: order.id, status: "CANCELLED" },
            data: { status: params.targetStatus },
          });
          if (claimed.count === 0) {
            action = "not_cancelled";
            return;
          }

          if (productIds.length === 0) {
            action = "reactivated_no_deduct";
            return;
          }

          // 2. Lock dos produtos (mesma ordem do motor) antes do net.
          for (const productId of productIds) {
            await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
          }

          // 3. Net dos estornos: estornos (+) − reativações anteriores (−)
          //    ⇒ a re-deduzir = max(0, Σ), com teto no pedido. Só desfaz o
          //    que o cancelamento fez — nunca cria dedução "nova".
          const grouped = await tx.stockLog.groupBy({
            by: ["productId"],
            where: {
              productId: { in: productIds },
              reason: { in: [restoreReason, reactivateReason] },
            },
            _sum: { change: true },
          });
          const netByProduct = new Map(
            grouped.map((g) => [g.productId, g._sum.change ?? 0]),
          );
          const items = productIds
            .map((productId) => ({
              productId,
              quantity: Math.min(
                Math.max(0, netByProduct.get(productId) ?? 0),
                orderedQty.get(productId)!,
              ),
            }))
            .filter((i) => i.quantity > 0);

          if (items.length === 0) {
            action = "reactivated_no_deduct";
            return;
          }

          const result = await StockDeductionService.deductWithinTx(tx, {
            items,
            reason: reactivateReason,
            orderId: order.id,
            logPrefix,
          });
          deductions = result.deductions;
          oversellAlerts = result.oversellAlerts;
          action = "reactivated_rededucted";
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      // Pós-commit: propaga o estoque re-deduzido aos marketplaces.
      // SEM pauseOnZero (pedido não pausa anúncios — o sync remoto pausa o
      // ML quando a quantidade chega a 0, como na importação).
      if (deductions.length > 0) {
        StockDeductionService.firePostEffects({
          deductions,
          logPrefix,
        });
      }

      // Peça vendida em outro canal enquanto o pedido esteve cancelado —
      // mesmo alerta de oversell da importação.
      if (oversellAlerts.length > 0) {
        try {
          await SystemLogService.logWarning(
            "OVERSELL_DETECTED",
            `Oversell detectado ao reativar o pedido ${order.id}: ${oversellAlerts.length} item(ns) com quantidade maior que estoque disponível`,
            {
              resource: "Order",
              resourceId: order.id,
              details: {
                orderId: order.id,
                platform: order.marketplaceAccount?.platform ?? null,
                items: oversellAlerts,
                reason: reactivateReason,
              },
            },
          );
        } catch (logError) {
          console.error(
            `${logPrefix} Falha ao registrar OVERSELL_DETECTED (reativação):`,
            logError,
          );
        }
      }

      void SystemLogService.logInfo(
        "ORDER_UNCANCEL_REDEDUCT",
        `Pedido ${platformLabel} #${externalOrderId} reativado para ${params.targetStatus} (${action})`,
        {
          resource: "Order",
          resourceId: order.id,
          details: {
            action,
            marketplaceAccountId,
            externalOrderId,
            targetStatus: params.targetStatus,
            deducted: deductions.map((d) => ({
              productId: d.productId,
              quantity: d.quantity,
              previousStock: d.previousStock,
              newStock: d.newStock,
            })),
          },
        },
      ).catch(() => {});

      return {
        success: true,
        orderId: order.id,
        externalOrderId,
        action,
        deductedItems: deductions.length,
      };
    } catch (error) {
      console.error(
        `${logPrefix} Falha na reativação ${platformLabel} #${externalOrderId}:`,
        error,
      );
      void SystemLogService.logError(
        "ORDER_UNCANCEL_REDEDUCT",
        `Falha ao reativar o pedido ${platformLabel} #${externalOrderId}`,
        {
          resource: "Order",
          details: {
            marketplaceAccountId,
            externalOrderId,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ).catch(() => {});
      return {
        success: false,
        orderId: null,
        externalOrderId,
        action: "error",
        deductedItems: 0,
        message: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  private static async syncMarketplaceStockForProducts(
    productIds: string[],
    context: SyncLogContext = {},
  ): Promise<void> {
    const uniqueProductIds = [...new Set(productIds.filter(Boolean))];
    if (uniqueProductIds.length === 0) return;

    const syncResults = await Promise.allSettled(
      uniqueProductIds.map((productId) =>
        SyncUseCase.syncProductStock(productId),
      ),
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
      const failedListings = result.value.filter(
        (entry) => !entry.success,
      ).length;
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
      dateFrom?: Date;
      dateTo?: Date;
      amountMin?: number;
      amountMax?: number;
    },
  ) {
    // EGRESS: a lista de pedidos NÃO traz o grafo de itens — só uma miniatura
    // leve do 1º item (`thumbnail`) + a contagem (`itemCount`). O sheet recarrega
    // o pedido completo via GET /orders/:id ao abrir. `findAllForList` também
    // aplica os filtros de período (data) e faixa de valor (preço).
    return orderRepository.findAllForList({
      userId,
      status: options?.status as any,
      platform: options?.platform,
      search: options?.search,
      page: options?.page,
      limit: options?.limit,
      dateFrom: options?.dateFrom,
      dateTo: options?.dateTo,
      amountMin: options?.amountMin,
      amountMax: options?.amountMax,
    });
  }

  /**
   * Busca detalhes de um pedido (escopado pelo dono quando `userId` informado).
   */
  static async getOrderById(
    orderId: string,
    userId?: string,
  ): Promise<Order | null> {
    return orderRepository.findById(orderId, userId);
  }
}

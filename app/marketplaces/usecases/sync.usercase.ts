/**
 * SyncUseCase - OrquestraÃ§Ã£o de sincronizaÃ§Ã£o entre estoque local e Mercado Livre
 *
 * Responsabilidades:
 * - Importar itens do ML e vincular automaticamente por SKU
 * - Sincronizar estoque do sistema central para o ML
 * - Registrar logs de sincronizaÃ§Ã£o
 */

import prisma from "@/app/lib/prisma";
import { Platform, SyncType, SyncStatus } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import CategoryRepository from "../repositories/category.repository";
import { ML_CATALOG } from "../../lib/product-parser";
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import type { MLItemDetails } from "../types/ml-api.types";
import type { MLItemUpdatePayload } from "../types/ml-api.types";
import type { ShopeeItem } from "../types/shopee-api.types";

// Tipos para resultados de sincronizaÃ§Ã£o
export interface ImportResult {
  totalItems: number;
  linkedItems: number;
  unlinkedItems: number;
  errors: string[];
  items: {
    externalListingId: string;
    title: string;
    sku: string | null;
    linkedProductId: string | null;
    status: "linked" | "unlinked" | "error";
  }[];
}

export interface SyncResult {
  success: boolean;
  productId: string;
  externalListingId: string;
  previousStock?: number;
  newStock?: number;
  previousPrice?: number;
  newPrice?: number;
  error?: string;
}

export interface SyncAllResult {
  total: number;
  successful: number;
  failed: number;
  results: SyncResult[];
}

export class SyncUseCase {
  /**
   * Importa todos os itens do Mercado Livre e tenta vincular automaticamente por SKU
   * Nota: Apenas cria listings para itens que podem ser vinculados a produtos existentes
   */
  static async importMLItems(userId: string, accountId?: string): Promise<ImportResult> {
    const result: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      errors: [],
      items: [],
    };

    // 1. Buscar conta do marketplace
    const account = accountId
      ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
      : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        );

    if (!account || !account.accessToken || !account.externalUserId) {
      throw new Error(
        "Conta do Mercado Livre nÃ£o conectada ou sem credenciais",
      );
    }

    // 2. Buscar todos os IDs de itens ATIVOS do vendedor
    const itemIds = await MLApiService.getSellerItemIds(
      account.accessToken,
      account.externalUserId,
      "active", // Apenas itens ativos (podem ser atualizados)
    );

    if (itemIds.length === 0) {
      return result;
    }

    // 3. Buscar detalhes dos itens em lotes
    const itemsDetails = await MLApiService.getItemsDetails(
      account.accessToken,
      itemIds,
    );

    result.totalItems = itemsDetails.length;
    console.log(`[IMPORT] Starting to process ${result.totalItems} items...`);

    // 4. Preparar dados para processamento otimizado
    const externalItemIds = itemsDetails.map((item) => item.id);
    const skus = itemsDetails
      .map((item) => this.extractSku(item))
      .filter(Boolean) as string[];

    // Buscar listings existentes em lote
    const existingListings = await prisma.productListing.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalListingId: { in: externalItemIds },
      },
    });
    const existingListingsMap = new Map(
      existingListings.map((listing) => [listing.externalListingId, listing]),
    );

    // Buscar produtos por SKU em lote
    const products =
      skus.length > 0
        ? await prisma.product.findMany({
            where: { sku: { in: skus } },
          })
        : [];
    const productsMap = new Map(
      products.map((product) => [product.sku, product]),
    );

    console.log(
      `[IMPORT] Found ${existingListings.length} existing listings and ${products.length} matching products`,
    );

    // 5. Processar cada item
    let processedCount = 0;
    for (const item of itemsDetails) {
      try {
        const sku = this.extractSku(item);
        const existingListing = existingListingsMap.get(item.id);
        const product = sku ? productsMap.get(sku) : null;

        let processedItem: ImportResult["items"][0];

        if (existingListing) {
          // JÃ¡ existe, atualizar status/permalink se necessÃ¡rio
          const needsStatusUpdate = existingListing.status !== item.status;
          const needsPermalinkUpdate =
            !existingListing.permalink && !!item.permalink;

          if (needsStatusUpdate || needsPermalinkUpdate) {
            await ListingRepository.updateListing(existingListing.id, {
              status: needsStatusUpdate ? item.status : undefined,
              permalink: needsPermalinkUpdate ? item.permalink || null : undefined,
            });
          }

          processedItem = {
            externalListingId: item.id,
            title: item.title,
            sku,
            linkedProductId: existingListing.productId,
            status: "linked",
          };
        } else {
          // Tentar vincular por SKU se disponÃ­vel
          const linkedProductId = product ? product.id : null;

          // Se encontrou produto, criar listing
          if (linkedProductId) {
            await ListingRepository.createListing({
              productId: linkedProductId,
              marketplaceAccountId: account.id,
              externalListingId: item.id,
              externalSku: sku || undefined,
              permalink: item.permalink || null,
              status: item.status,
            });
          }

          processedItem = {
            externalListingId: item.id,
            title: item.title,
            sku,
            linkedProductId,
            status: linkedProductId ? "linked" : "unlinked",
          };
        }

        result.items.push(processedItem);

        if (processedItem.status === "linked") {
          result.linkedItems++;
        } else {
          result.unlinkedItems++;
        }

        processedCount++;
        if (processedCount % 100 === 0) {
          console.log(
            `[IMPORT] Processed ${processedCount}/${result.totalItems} items (${result.linkedItems} linked, ${result.unlinkedItems} unlinked)`,
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        result.errors.push(`Item ${item.id}: ${errorMessage}`);
        result.items.push({
          externalListingId: item.id,
          title: item.title,
          sku: this.extractSku(item),
          linkedProductId: null,
          status: "error",
        });
        processedCount++;
      }
    }

    console.log(
      `[IMPORT] Completed processing ${processedCount} items. Final: ${result.linkedItems} linked, ${result.unlinkedItems} unlinked, ${result.errors.length} errors`,
    );

    // 5. Registrar log da importaÃ§Ã£o
    await this.logSync(
      account.id,
      SyncType.PRODUCT_SYNC,
      result.linkedItems > 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Importados ${result.totalItems} itens, ${result.linkedItems} vinculados`,
      { totalItems: result.totalItems, linkedItems: result.linkedItems },
    );

    return result;
  }

  /**
   * Importa todos os itens do Shopee e tenta vincular automaticamente por SKU
   */
  static async importShopeeItems(userId: string, accountId?: string): Promise<ImportResult> {
    const result: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      errors: [],
      items: [],
    };

    // 1. Buscar conta do marketplace
    const account = accountId
      ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
      : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
          userId,
          Platform.SHOPEE,
        );

    if (!account || !account.accessToken || !account.shopId) {
      throw new Error("Conta do Shopee nÃ£o conectada ou sem credenciais");
    }

    // 2. Buscar todos os itens da loja
    const itemList = await ShopeeApiService.getItemList(
      account.accessToken,
      account.shopId,
      { offset: 0, page_size: 100, item_status: ["NORMAL"] }, // Apenas itens normais/ativos
    );

    if (itemList.item.length === 0) {
      return result;
    }

    result.totalItems = itemList.item.length;
    console.log(
      `[IMPORT] Starting to process ${result.totalItems} Shopee items...`,
    );

    // 3. Buscar detalhes dos itens
    const itemDetails: ShopeeItem[] = [];
    for (const item of itemList.item) {
      try {
        const detail = await ShopeeApiService.getItemDetail(
          account.accessToken,
          account.shopId,
          item.item_id,
        );
        itemDetails.push(detail);
      } catch (error) {
        console.error(
          `Erro ao buscar detalhes do item ${item.item_id}:`,
          error,
        );
      }
    }

    // 4. Preparar dados para processamento otimizado
    const externalItemIds = itemDetails.map((item) => item.item_id.toString());
    const skus = itemDetails
      .map((item) => item.item_sku)
      .filter(Boolean) as string[];

    // Buscar listings existentes
    const existingListings = await prisma.productListing.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalListingId: { in: externalItemIds },
      },
    });
    const existingListingsMap = new Map(
      existingListings.map((listing) => [listing.externalListingId, listing]),
    );

    // Buscar produtos por SKU
    const products =
      skus.length > 0
        ? await prisma.product.findMany({
            where: { sku: { in: skus } },
          })
        : [];
    const productsMap = new Map(
      products.map((product) => [product.sku, product]),
    );

    console.log(
      `[IMPORT] Found ${existingListings.length} existing listings and ${products.length} matching products`,
    );

    // 5. Processar cada item
    let processedCount = 0;
    for (const item of itemDetails) {
      try {
        const sku = item.item_sku;
        const externalId = item.item_id.toString();
        const existingListing = existingListingsMap.get(externalId);
        const product = sku ? productsMap.get(sku) : null;

        let processedItem: ImportResult["items"][0];

        if (existingListing) {
          // JÃ¡ existe, atualizar status se necessÃ¡rio
          const newStatus =
            item.status === "NORMAL" ? "active" : item.status.toLowerCase();
          if (existingListing.status !== newStatus) {
            await ListingRepository.updateStatus(existingListing.id, newStatus);
          }

          processedItem = {
            externalListingId: externalId,
            title: item.item_name,
            sku,
            linkedProductId: existingListing.productId,
            status: "linked",
          };
        } else {
          // Tentar vincular por SKU se disponÃ­vel
          const linkedProductId = product ? product.id : null;

          // Se encontrou produto, criar listing
          if (linkedProductId) {
            await ListingRepository.createListing({
              productId: linkedProductId,
              marketplaceAccountId: account.id,
              externalListingId: externalId,
              externalSku: sku || undefined,
              status:
                item.status === "NORMAL" ? "active" : item.status.toLowerCase(),
            });
          }

          processedItem = {
            externalListingId: externalId,
            title: item.item_name,
            sku,
            linkedProductId,
            status: linkedProductId ? "linked" : "unlinked",
          };
        }

        result.items.push(processedItem);

        if (processedItem.status === "linked") {
          result.linkedItems++;
        } else {
          result.unlinkedItems++;
        }

        processedCount++;
        if (processedCount % 50 === 0) {
          console.log(
            `[IMPORT] Processed ${processedCount}/${result.totalItems} Shopee items (${result.linkedItems} linked, ${result.unlinkedItems} unlinked)`,
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        result.errors.push(`Item ${item.item_id}: ${errorMessage}`);
        result.items.push({
          externalListingId: item.item_id.toString(),
          title: item.item_name,
          sku: item.item_sku,
          linkedProductId: null,
          status: "error",
        });
        processedCount++;
      }
    }

    console.log(
      `[IMPORT] Completed processing ${processedCount} Shopee items. Final: ${result.linkedItems} linked, ${result.unlinkedItems} unlinked, ${result.errors.length} errors`,
    );

    // Registrar log da importaÃ§Ã£o
    await this.logSync(
      account.id,
      SyncType.PRODUCT_SYNC,
      result.linkedItems > 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Importados ${result.totalItems} itens do Shopee, ${result.linkedItems} vinculados`,
      { totalItems: result.totalItems, linkedItems: result.linkedItems },
    );

    return result;
  }

  // Sincroniza categorias do Mercado Livre para DB (siteId ex: "MLB")
  static async syncMLCategories(
    userId: string,
    siteId: string = "MLB",
    accountId?: string,
  ) {
    const account = accountId
      ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
      : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        );

    try {
      let cats: { id: string; name: string }[] | null = null;
      try {
        cats = await MLApiService.getSiteCategories(siteId);
        console.log(
          `[SYNC] Fetched ${cats.length} site categories for ${siteId}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          "[SYNC] Could not fetch site categories from ML API, falling back to static ML_CATALOG:",
          msg,
        );
      }

      const entries: any[] = [];
      let processed = 0;

      if (cats && cats.length > 0) {
        for (const c of cats) {
          try {
            const data = await MLApiService.getCategory(c.id);
            const path = data.path_from_root || [];
            const fullPath = path.map((p: any) => p.name).join(" > ");
            const parent = path.length > 1 ? path[path.length - 2].id : null;

            entries.push({
              externalId: c.id,
              siteId,
              name: c.name,
              fullPath,
              pathFromRoot: path,
              parentExternalId: parent,
              keywords: null,
            });

            processed++;
            if (processed % 20 === 0)
              await new Promise((r) => setTimeout(r, 100));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[SYNC] Failed to fetch category ${c.id}:`, msg);
          }
        }
      } else {
        // Fallback: use static ML_CATALOG defined in product-parser
        for (const parent of ML_CATALOG) {
          // Insert parent entry
          entries.push({
            externalId: parent.id,
            siteId,
            name: parent.value,
            fullPath: parent.value,
            pathFromRoot: [{ id: parent.id, name: parent.value }],
            parentExternalId: null,
            keywords: parent.keywords?.join(",") || null,
          });

          if (parent.children && parent.children.length > 0) {
            for (const child of parent.children) {
              entries.push({
                externalId: child.id,
                siteId,
                name: child.value.split(" > ").slice(-1)[0],
                fullPath: child.value,
                pathFromRoot: [
                  { id: parent.id, name: parent.value },
                  { id: child.id, name: child.value.split(" > ").slice(-1)[0] },
                ],
                parentExternalId: parent.id,
                keywords: child.keywords?.join(",") || null,
              });
            }
          }
        }
      }

      if (entries.length > 0) {
        await CategoryRepository.upsertMany(entries as any[]);
      }

      // Registro de log: se tivermos conta ML, registrar via logSync (SyncLog), caso contrÃ¡rio usar SystemLogService
      if (accountId) {
        await this.logSync(
          accountId,
          SyncType.PRODUCT_SYNC,
          SyncStatus.SUCCESS,
          `Categorias ML sincronizadas (${entries.length}) for ${siteId}`,
          { siteId, count: entries.length },
        );
      } else {
        await (
          await import("@/app/services/system-log.service")
        ).SystemLogService.logSyncComplete(
          userId,
          "CATEGORY_SYNC",
          "MercadoLivre",
          { siteId, count: entries.length },
        );
      }

      return { success: true, categories: entries.length };
    } catch (error) {
      if (accountId) {
        await this.logSync(
          accountId,
          SyncType.PRODUCT_SYNC,
          SyncStatus.FAILURE,
          `Erro ao sincronizar categorias ML: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        await (
          await import("@/app/services/system-log.service")
        ).SystemLogService.logSyncError(
          userId,
          "CATEGORY_SYNC",
          "MercadoLivre",
          `Erro ao sincronizar categorias ML: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  /**
   * Extrai o SKU de um item do ML (pode estar em diferentes lugares)
   */
  private static extractSku(item: MLItemDetails): string | null {
    // Primeiro, verificar seller_custom_field
    if (item.seller_custom_field) {
      return item.seller_custom_field;
    }

    // Depois, procurar nos atributos
    if (item.attributes) {
      const skuAttr = item.attributes.find(
        (attr) =>
          attr.id === "SELLER_SKU" ||
          attr.id === "SKU" ||
          attr.id.toLowerCase().includes("sku"),
      );
      if (skuAttr?.value_name) {
        return skuAttr.value_name;
      }
    }

    return null;
  }

  /**
   * Sincroniza o estoque de um produto especÃ­fico para todos os marketplaces conectados
   */
  static async syncProductStock(productId: string): Promise<SyncResult[]> {
    // 1. Buscar produto com seus listings
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        listings: {
          include: {
            marketplaceAccount: true,
          },
        },
      },
    });

    if (!product) {
      return [
        {
          success: false,
          productId,
          externalListingId: "",
          error: "Produto nÃ£o encontrado",
        },
      ];
    }

    if (product.listings.length === 0) {
      return [
        {
          success: false,
          productId,
          externalListingId: "",
          error: "Produto nÃ£o vinculado a nenhum marketplace",
        },
      ];
    }

    // 2. Sincronizar cada listing baseado na plataforma
    const results: SyncResult[] = [];

    for (const listing of product.listings) {
      const account = listing.marketplaceAccount;

      try {
        let result: SyncResult;

        switch (account.platform) {
          case Platform.MERCADO_LIVRE:
            result = await this.syncMLProductStock(listing, product);
            break;
          case Platform.SHOPEE:
            result = await this.syncShopeeProductStock(listing, product);
            break;
          default:
            result = {
              success: false,
              productId,
              externalListingId: listing.externalListingId,
              error: `Plataforma ${account.platform} nÃ£o suportada`,
            };
        }

        results.push(result);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        results.push({
          success: false,
          productId,
          externalListingId: listing.externalListingId,
          error: errorMessage,
        });
      }
    }

    return results;
  }

  /**
   * Sincroniza estoque de um produto para Mercado Livre
   */
  private static async syncMLProductStock(
    listing: any,
    product: any,
  ): Promise<SyncResult> {
    const account = listing.marketplaceAccount;

    if (!account.accessToken) {
      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error: "Conta sem token de acesso",
      };
    }

    // Skip syncing for local placeholder listings (created when ML refused/paused)
    if (
      listing.externalListingId &&
      String(listing.externalListingId).startsWith("PENDING_")
    ) {
      try {
        await this.logSync(
          account.id,
          SyncType.STOCK_UPDATE,
          SyncStatus.WARNING,
          `AnÃºncio local (placeholder) â€” nÃ£o existe no Mercado Livre: ${listing.externalListingId}`,
          {
            productId: product.id,
            externalListingId: listing.externalListingId,
          },
        );
      } catch (e) {
        /* ignore logging failures */
      }

      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error:
          "AnÃºncio local (placeholder) â€” nÃ£o existe no Mercado Livre. SincronizaÃ§Ã£o ignorada.",
      };
    }

    try {
      // Buscar estoque atual no ML para log
      const currentItem = await MLApiService.getItemDetails(
        account.accessToken,
        listing.externalListingId,
      );

      const previousStock = currentItem?.available_quantity ?? 0;

      // Atualizar estoque no ML
      await MLApiService.updateItemStock(
        account.accessToken,
        listing.externalListingId,
        product.stock,
      );

      // Registrar log
      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.SUCCESS,
        `Estoque do produto ${product.name} atualizado: ${previousStock} â†’ ${product.stock}`,
        {
          productId: product.id,
          externalListingId: listing.externalListingId,
          previousStock,
          newStock: product.stock,
        },
      );

      return {
        success: true,
        productId: product.id,
        externalListingId: listing.externalListingId,
        previousStock,
        newStock: product.stock,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Erro desconhecido";

      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.FAILURE,
        `Erro ao atualizar estoque: ${errorMessage}`,
        {
          productId: product.id,
          externalListingId: listing.externalListingId,
          error: errorMessage,
        },
      );

      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error: errorMessage,
      };
    }
  }

  /**
   * Sincroniza estoque de um produto para Shopee
   */
  private static async syncShopeeProductStock(
    listing: any,
    product: any,
  ): Promise<SyncResult> {
    const account = listing.marketplaceAccount;

    if (!account.accessToken || !account.shopId) {
      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error: "Conta sem token de acesso ou shopId",
      };
    }

    try {
      // Buscar item atual no Shopee para log
      const currentItem = await ShopeeApiService.getItemDetail(
        account.accessToken,
        account.shopId,
        parseInt(listing.externalListingId),
      );

      const previousStock = currentItem.stock_info[0]?.stock_quantity ?? 0;

      // Atualizar estoque no Shopee
      await ShopeeApiService.updateItemStock(
        account.accessToken,
        account.shopId,
        parseInt(listing.externalListingId),
        product.stock,
      );

      // Registrar log
      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.SUCCESS,
        `Estoque do produto ${product.name} atualizado: ${previousStock} â†’ ${product.stock}`,
        {
          productId: product.id,
          externalListingId: listing.externalListingId,
          previousStock,
          newStock: product.stock,
        },
      );

      return {
        success: true,
        productId: product.id,
        externalListingId: listing.externalListingId,
        previousStock,
        newStock: product.stock,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Erro desconhecido";

      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.FAILURE,
        `Erro ao atualizar estoque: ${errorMessage}`,
        {
          productId: product.id,
          externalListingId: listing.externalListingId,
          error: errorMessage,
        },
      );

      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error: errorMessage,
      };
    }
  }

  /**
   * Sincroniza o estoque de todos os produtos vinculados a um marketplace especÃ­fico
   */
  static async syncAllStock(
    userId: string,
    platform: Platform,
    accountIds?: string[],
  ): Promise<SyncAllResult> {
    const result: SyncAllResult = {
      total: 0,
      successful: 0,
      failed: 0,
      results: [],
    };

    // 1. Buscar contas do marketplace (multi-contas)
    const accounts =
      accountIds && accountIds.length > 0
        ? await prisma.marketplaceAccount.findMany({
            where: { id: { in: accountIds }, userId, platform },
            orderBy: { createdAt: "asc" },
          })
        : await MarketplaceRepository.findAllByUserIdAndPlatform(
            userId,
            platform,
          );

    if (!accounts || accounts.length === 0) {
      throw new Error(`Conta do ${platform} nÃ£o encontrada`);
    }

    // 2. Para cada conta, buscar listings e sincronizar
    for (const account of accounts) {
      const listings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        include: { product: true },
      });

      result.total += listings.length;

      for (const listing of listings) {
        if (!listing.product) continue;

        const syncResults = await this.syncProductStock(listing.product.id);

        const relevantResult = syncResults.find(
          (r) => r.externalListingId === listing.externalListingId,
        );

        if (relevantResult) {
          result.results.push(relevantResult);
          if (relevantResult.success) {
            result.successful++;
          } else {
            result.failed++;
          }
        }
      }

      // Log individual por conta
      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        result.failed === 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
        `SincronizaÃ§Ã£o em lote: ${result.successful}/${result.total} bem-sucedidos`,
        {
          total: result.total,
          successful: result.successful,
          failed: result.failed,
          accountId: account.id,
        },
      );
    }

    return result;
  }

  /**
   * Sincroniza dados completos de um produto para um anÃºncio especÃ­fico
   * Atualiza preÃ§o, estoque e outros campos suportados pelo marketplace
   */
  static async syncProductData(
    productId: string,
    externalListingId: string,
    marketplaceAccountId: string,
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      productId,
      externalListingId,
    };

    try {
      // 1. Buscar produto
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        throw new Error(`Produto ${productId} nÃ£o encontrado`);
      }

      // 2. Buscar conta do marketplace
      const account = await prisma.marketplaceAccount.findUnique({
        where: { id: marketplaceAccountId },
      });

      if (!account || !account.accessToken) {
        throw new Error(
          "Conta do marketplace nÃ£o encontrada ou sem token de acesso",
        );
      }

      // 3. Roteamento baseado na plataforma
      switch (account.platform) {
        case Platform.MERCADO_LIVRE:
          return await this.syncMLProductData(
            product,
            externalListingId,
            account,
          );
        case Platform.SHOPEE:
          return await this.syncShopeeProductData(
            product,
            externalListingId,
            account,
          );
        default:
          throw new Error(
            `Plataforma ${account.platform} nÃ£o suportada para sincronizaÃ§Ã£o completa`,
          );
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);

      // Registrar log de erro
      await this.logSync(
        marketplaceAccountId,
        SyncType.PRODUCT_SYNC,
        SyncStatus.FAILURE,
        `Erro ao sincronizar produto ${productId}: ${result.error}`,
        {
          productId,
          externalListingId,
          error: result.error,
        },
      );
    }

    return result;
  }

  /**
   * Sincroniza dados completos para Mercado Livre
   */
  private static async syncMLProductData(
    product: any,
    externalListingId: string,
    account: any,
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      productId: product.id,
      externalListingId,
    };

    try {
      // If the externalListingId is a local placeholder, skip remote calls
      if (String(externalListingId).startsWith("PENDING_")) {
        // Record a sync warning and return
        try {
          await this.logSync(
            account.id,
            SyncType.PRODUCT_SYNC,
            SyncStatus.WARNING,
            `SincronizaÃ§Ã£o ignorada para placeholder local ${externalListingId}`,
            { productId: product.id, externalListingId },
          );
        } catch (e) {
          /* ignore logging failures */
        }

        result.error =
          "AnÃºncio local (placeholder) â€” nÃ£o existe no Mercado Livre. OperaÃ§Ã£o ignorada.";
        return result;
      }
      // Verificar status do anÃºncio antes de atualizar
      const currentItem = await MLApiService.getItemDetails(
        account.accessToken,
        externalListingId,
      );

      console.log(`[SYNC] Status atual do anÃºncio: ${currentItem.status}`);

      // Preparar dados para atualizaÃ§Ã£o baseados no status
      const updateData: MLItemUpdatePayload = {};

      // Sempre sincronizar preÃ§o e estoque (campos suportados pela API)
      updateData.price = Number(product.price);
      updateData.available_quantity = product.stock;

      // SÃ³ sincronizar tÃ­tulo e descriÃ§Ã£o se o anÃºncio estiver ativo
      // AnÃºncios pausados nÃ£o permitem atualizaÃ§Ã£o de tÃ­tulo/descriÃ§Ã£o
      if (currentItem.status === "active") {
        // Sincronizar nome se foi alterado
        if (product.name && product.name !== currentItem.title) {
          updateData.title = product.name;
        }

        // Sincronizar descriÃ§Ã£o se foi alterada
        if (product.description) {
          updateData.description = product.description;
        }
      }

      // Sincronizar categoria se foi alterada (geralmente nÃ£o permitida em anÃºncios ativos)
      if (product.category) {
        console.log(
          `[SYNC] Categoria detectada mas nÃ£o sincronizada: ${product.category}`,
        );
      }

      // Sincronizar imagem se foi alterada (pode nÃ£o ser permitido em anÃºncios ativos)
      if (product.imageUrl) {
        console.log(
          `[SYNC] Imagem detectada mas pode nÃ£o ser sincronizada em anÃºncio ativo`,
        );
      }

      console.log(`[SYNC] Dados a serem enviados para ML:`, updateData);

      // SÃ³ fazer a atualizaÃ§Ã£o se houver dados para atualizar
      if (Object.keys(updateData).length > 0) {
        const updatedItem = await MLApiService.updateItem(
          account.accessToken,
          externalListingId,
          updateData,
        );
        console.log(`[SYNC] Resposta do ML:`, updatedItem);

        result.success = true;
        result.previousStock = currentItem.available_quantity;
        result.newStock = product.stock;
        result.previousPrice = currentItem.price;
        result.newPrice = Number(product.price);

        // Registrar log de sucesso
        await this.logSync(
          account.id,
          SyncType.PRODUCT_SYNC,
          SyncStatus.SUCCESS,
          `Produto ${product.sku} sincronizado: preÃ§o R$ ${product.price}, estoque ${product.stock}, tÃ­tulo "${product.name}"`,
          {
            productId: product.id,
            externalListingId,
            price: product.price,
            stock: product.stock,
            title: product.name,
            description: product.description,
            imageUrl: product.imageUrl,
          },
        );
      } else {
        console.log(`[SYNC] Nenhum dado para atualizar`);
        throw new Error(
          "AnÃºncio ativo - apenas preÃ§o e estoque podem ser sincronizados",
        );
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  /**
   * Sincroniza dados completos para Shopee
   */
  private static async syncShopeeProductData(
    product: any,
    externalListingId: string,
    account: any,
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      productId: product.id,
      externalListingId,
    };

    try {
      if (!account.shopId) {
        throw new Error("ShopId nÃ£o encontrado para conta Shopee");
      }

      // Buscar item atual no Shopee
      const currentItem = await ShopeeApiService.getItemDetail(
        account.accessToken,
        account.shopId,
        parseInt(externalListingId),
      );

      console.log(`[SYNC] Status atual do item Shopee: ${currentItem.status}`);

      // Preparar dados para atualizaÃ§Ã£o
      const updateData: any = {
        item_id: parseInt(externalListingId),
      };

      // Sempre sincronizar preÃ§o e estoque
      updateData.price = Number(product.price);
      updateData.stock = product.stock;

      // Sincronizar tÃ­tulo se foi alterado
      if (product.name && product.name !== currentItem.item_name) {
        updateData.item_name = product.name;
      }

      // Sincronizar descriÃ§Ã£o se foi alterada
      if (
        product.description &&
        product.description !== currentItem.description
      ) {
        updateData.description = product.description;
      }

      console.log(`[SYNC] Dados a serem enviados para Shopee:`, updateData);

      // Fazer a atualizaÃ§Ã£o
      const updatedItem = await ShopeeApiService.updateItem(
        account.accessToken,
        account.shopId,
        updateData,
      );
      console.log(`[SYNC] Resposta do Shopee:`, updatedItem);

      result.success = true;
      result.previousStock = currentItem.stock_info[0]?.stock_quantity ?? 0;
      result.newStock = product.stock;
      result.previousPrice = currentItem.price_info[0]?.current_price ?? 0;
      result.newPrice = Number(product.price);

      // Registrar log de sucesso
      await this.logSync(
        account.id,
        SyncType.PRODUCT_SYNC,
        SyncStatus.SUCCESS,
        `Produto ${product.sku} sincronizado: preÃ§o R$ ${product.price}, estoque ${product.stock}, tÃ­tulo "${product.name}"`,
        {
          productId: product.id,
          externalListingId,
          price: product.price,
          stock: product.stock,
          title: product.name,
          description: product.description,
          imageUrl: product.imageUrl,
        },
      );
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  /**
   * Registra um log de sincronizaÃ§Ã£o
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
}




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
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import CategoryRepository from "../repositories/category.repository";
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import type { MLItemDetails } from "../types/ml-api.types";
import type { MLItemUpdatePayload } from "../types/ml-api.types";
import type { ShopeeItem } from "../types/shopee-api.types";
import { normalizeSku } from "@/app/lib/sku";
import fs from "node:fs";
import path from "node:path";

// Tipos para resultados de sincronizaÃ§Ã£o
export interface ImportResult {
  totalItems: number;
  linkedItems: number;
  unlinkedItems: number;
  errorCount?: number;
  itemsPreviewTruncated?: boolean;
  errorsPreviewTruncated?: boolean;
  errors: string[];
  items: {
    externalListingId: string;
    title: string;
    sku: string | null;
    linkedProductId: string | null;
    status: "linked" | "unlinked" | "error";
  }[];
}

type ImportItemResult = ImportResult["items"][number];

type ShopeeImportJobState = "queued" | "running" | "completed" | "failed";

interface ShopeeImportJobPayload {
  kind: "SHOPEE_IMPORT";
  state: ShopeeImportJobState;
  phase: "queued" | "listing" | "details" | "processing" | "completed" | "failed";
  importId: string;
  accountId: string;
  totalItemIds: number;
  totalItems: number;
  pagesFetched: number;
  fetchedBaseInfo: number;
  processedItems: number;
  linkedItems: number;
  unlinkedItems: number;
  errorCount: number;
  itemsPreview: ImportItemResult[];
  errorsPreview: string[];
  itemsPreviewTruncated: boolean;
  errorsPreviewTruncated: boolean;
  startedAt: string;
  finishedAt?: string;
  message?: string;
}

interface ShopeeImportJobStatus {
  importId: string;
  status: ShopeeImportJobState;
  progress: Omit<ShopeeImportJobPayload, "kind" | "importId" | "accountId">;
  result?: ImportResult;
}

interface ShopeeImportProgress {
  phase?: ShopeeImportJobPayload["phase"];
  totalItemIds?: number;
  totalItems?: number;
  pagesFetched?: number;
  fetchedBaseInfo?: number;
  processedItems?: number;
  linkedItems?: number;
  unlinkedItems?: number;
  errorCount?: number;
  itemsPreview?: ImportItemResult[];
  errorsPreview?: string[];
  itemsPreviewTruncated?: boolean;
  errorsPreviewTruncated?: boolean;
  message?: string;
  finishedAt?: string;
}

export interface SyncResult {
  success: boolean;
  productId: string;
  externalListingId: string;
  platform?: Platform;
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
  private static readonly IMPORT_ITEMS_PREVIEW_LIMIT = 100;
  private static readonly IMPORT_ERRORS_PREVIEW_LIMIT = 50;
  private static readonly SHOPEE_IMPORT_BATCH_SIZE = 50;
  private static readonly SHOPEE_IMPORT_MAX_CONCURRENT_BATCHES = 4;
  private static readonly SHOPEE_IMPORT_MIN_BASE_INFO_RATIO = 0.1;
  private static readonly SHOPEE_IMPORT_PROGRESS_FLUSH_MS = 1000;
  private static readonly SHOPEE_IMPORT_STALE_MS = 15 * 60 * 1000;

  /**
   * Importa todos os itens do Mercado Livre e tenta vincular automaticamente por SKU
   * Nota: Apenas cria listings para itens que podem ser vinculados a produtos existentes
   */
  static async importMLItems(
    userId: string,
    accountId?: string,
  ): Promise<ImportResult> {
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

    // 2. Buscar todos os IDs do vendedor via scan (status filtrado depois)
    const itemIds = await MLApiService.getSellerItemIds(
      account.accessToken,
      account.externalUserId,
    );

    if (itemIds.length === 0) {
      return result;
    }

    // 3. Buscar detalhes dos itens em lotes
    const itemsDetails = await MLApiService.getItemsDetails(
      account.accessToken,
      itemIds,
    );

    // Filtrar itens ativos apenas após coletar todos os IDs (scan não aceita status)
    const activeItems = itemsDetails.filter((item) => item.status === "active");
    if (activeItems.length === 0) {
      console.log("[IMPORT] Nenhum item ativo encontrado após filtro");
      return result;
    }

    result.totalItems = activeItems.length;
    console.log(
      `[IMPORT] Starting to process ${result.totalItems} active items (de ${itemsDetails.length} totais)...`,
    );

    // 4. Preparar dados para processamento otimizado
    const externalItemIds = activeItems.map((item) => item.id);
    const normalizedSkus = Array.from(
      new Set(
        activeItems
          .map((item) => normalizeSku(this.extractSku(item)))
          .filter((sku): sku is string => Boolean(sku)),
      ),
    );

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
      normalizedSkus.length > 0
        ? await prisma.product.findMany({
            where: {
              skuNormalized: { in: normalizedSkus },
              userId: account.userId,
            },
          })
        : [];
    const productsMap = new Map(
      products
        .map((product) => [product.skuNormalized, product] as const)
        .filter(
          (
            entry,
          ): entry is readonly [string, (typeof products)[number]] =>
            Boolean(entry[0]),
        ),
    );

    console.log(
      `[IMPORT] Found ${existingListings.length} existing listings and ${products.length} matching products`,
    );

    // 5. Processar cada item
    let processedCount = 0;
    for (const item of activeItems) {
      try {
        const sku = this.extractSku(item);
        const normalizedSku = normalizeSku(sku);
        const existingListing = existingListingsMap.get(item.id);
        const product = normalizedSku ? productsMap.get(normalizedSku) : null;

        let processedItem: ImportResult["items"][0];

        if (existingListing) {
          // JÃ¡ existe, atualizar status/permalink se necessÃ¡rio
          const needsStatusUpdate = existingListing.status !== item.status;
          const needsPermalinkUpdate =
            !existingListing.permalink && !!item.permalink;

          if (needsStatusUpdate || needsPermalinkUpdate) {
            await ListingRepository.updateListing(existingListing.id, {
              status: needsStatusUpdate ? item.status : undefined,
              permalink: needsPermalinkUpdate
                ? item.permalink || null
                : undefined,
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

        pushItemPreview(processedItem);

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
  static async importShopeeItems(
    userId: string,
    accountId?: string,
    options?: {
      onProgress?: (progress: ShopeeImportProgress) => Promise<void> | void;
      skipFinalLog?: boolean;
    },
  ): Promise<ImportResult> {
    const result: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      errorCount: 0,
      itemsPreviewTruncated: false,
      errorsPreviewTruncated: false,
      errors: [],
      items: [],
    };

    // 1. Buscar conta do marketplace
    const account = await this.resolveShopeeAccount(userId, accountId);

    const emitProgress = async (partial: ShopeeImportProgress = {}) => {
      if (!options?.onProgress) {
        return;
      }

      await options.onProgress({
        totalItems: result.totalItems,
        linkedItems: result.linkedItems,
        unlinkedItems: result.unlinkedItems,
        errorCount: result.errorCount ?? 0,
        itemsPreview: [...result.items],
        errorsPreview: [...result.errors],
        itemsPreviewTruncated: !!result.itemsPreviewTruncated,
        errorsPreviewTruncated: !!result.errorsPreviewTruncated,
        ...partial,
      });
    };

    const pushItemPreview = (item: ImportItemResult) => {
      if (result.items.length < this.IMPORT_ITEMS_PREVIEW_LIMIT) {
        result.items.push(item);
        return;
      }

      result.itemsPreviewTruncated = true;
    };

    const recordError = (message: string, increment = 1) => {
      result.errorCount = (result.errorCount ?? 0) + increment;
      if (result.errors.length < this.IMPORT_ERRORS_PREVIEW_LIMIT) {
        result.errors.push(message);
        return;
      }

      result.errorsPreviewTruncated = true;
    };

    // Helper: refresh token on auth error (401/403) once
    let accessToken = account.accessToken;
    const refreshIfNeeded = async (err: any) => {
      const status = err?.status;
      if (
        (status === 401 || status === 403) &&
        account.refreshToken &&
        account.shopId
      ) {
        const refreshed = await ShopeeOAuthService.refreshAccessToken(
          account.refreshToken,
          account.shopId,
        );
        await MarketplaceRepository.updateTokens(account.id, {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: new Date(Date.now() + refreshed.expire_in * 1000),
        });
        accessToken = refreshed.access_token;
        return true;
      }
      return false;
    };

    // 2. Buscar todos os itens da loja com paginação
    const allItemIds: number[] = [];
    let offset = 0;
    const pageSize = 100;
    let page = 1;
    // Use para fallback se detalhe falhar
    const listingSnapshot: { item_id: number; item_sku?: string; item_name?: string; status?: string }[] = [];
    await emitProgress({
      phase: "listing",
      pagesFetched: 0,
      totalItemIds: 0,
      message: "Coletando itens Shopee da loja",
    });
    while (true) {
      try {
        const itemList = await ShopeeApiService.getItemList(
          accessToken,
          account.shopId,
          {
            offset,
            page_size: pageSize,
            item_status: ["NORMAL"],
            response_optional_fields: ["item_sku"],
          },
        );
        const items = itemList?.item || [];
        allItemIds.push(...items.map((i) => i.item_id));
        listingSnapshot.push(
          ...items.map((i: any) => ({
            item_id: i.item_id,
            item_sku: i.item_sku,
            item_name: i.item_name,
            status: i.item_status || i.status,
          })),
        );
        console.log(
          `[IMPORT][Shopee] page ${page} items=${items.length} has_next=${itemList?.has_next_page}`,
        );
        await emitProgress({
          phase: "listing",
          pagesFetched: page,
          totalItemIds: allItemIds.length,
          message: `Itens Shopee coletados: ${allItemIds.length}`,
        });
        if (!itemList?.has_next_page) break;
        offset = itemList.next_offset || offset + pageSize;
        page++;
      } catch (error: any) {
        const refreshed = await refreshIfNeeded(error);
        if (refreshed) continue;
        throw error;
      }
    }

    if (allItemIds.length === 0) {
      await emitProgress({
        phase: "completed",
        totalItemIds: 0,
        totalItems: 0,
        message: "Nenhum item Shopee encontrado para importar",
      });
      return result;
    }

    // Mapa rápido do snapshot para reaproveitar SKU do get_item_list
    const snapshotMap = new Map<number, { item_sku?: string; item_name?: string; status?: string }>();
    for (const snap of listingSnapshot) {
      snapshotMap.set(snap.item_id, snap);
    }

    const sampleSnapshotSkus = Array.from(snapshotMap.values())
      .map((s) => s.item_sku)
      .filter(Boolean)
      .slice(0, 20);
    console.log(`[IMPORT][Shopee] Sample item_sku from list call:`, sampleSnapshotSkus);

    // 3. Buscar detalhes dos itens em lote (base info) com retry em auth
    result.totalItems = allItemIds.length;
    const itemDetails: ShopeeItem[] = [];
    const notFoundIds: number[] = [];
    const batchSize = this.SHOPEE_IMPORT_BATCH_SIZE;
    const batches: number[][] = [];
    for (let i = 0; i < allItemIds.length; i += batchSize) {
      batches.push(allItemIds.slice(i, i + batchSize));
    }

    let nextBatchIndex = 0;
    const worker = async () => {
      while (true) {
        const batchIndex = nextBatchIndex++;
        if (batchIndex >= batches.length) {
          break;
        }

        const slice = batches[batchIndex];
        const batchLabel = batchIndex + 1;

        try {
          const details = await ShopeeApiService.getItemsBaseInfo(
            accessToken,
            account.shopId,
            slice,
          );
          itemDetails.push(...details);
          await emitProgress({
            phase: "details",
            totalItemIds: allItemIds.length,
            fetchedBaseInfo: itemDetails.length,
            message: `Detalhes Shopee carregados: ${itemDetails.length}/${allItemIds.length}`,
          });
        } catch (error: any) {
          const refreshed = await refreshIfNeeded(error);
          if (refreshed) {
            try {
              const details = await ShopeeApiService.getItemsBaseInfo(
                accessToken,
                account.shopId,
                slice,
              );
              itemDetails.push(...details);
              await emitProgress({
                phase: "details",
                totalItemIds: allItemIds.length,
                fetchedBaseInfo: itemDetails.length,
                message: `Detalhes Shopee carregados: ${itemDetails.length}/${allItemIds.length}`,
              });
              continue;
            } catch (err) {
              const status = (err as any)?.status;
              if (status === 404) {
                notFoundIds.push(...slice);
                recordError(
                  `Batch ${batchLabel}: ${slice.length} item(ns) não encontrado(s) em get_item_base_info`,
                  slice.length,
                );
                continue;
              }
              console.error(`[IMPORT] Erro em batch ${batchLabel} após refresh:`, err);
              recordError(
                `Batch ${batchLabel}: ${err instanceof Error ? err.message : err}`,
                slice.length,
              );
              continue;
            }
          }
          const status = (error as any)?.status;
          if (status === 404) {
            notFoundIds.push(...slice);
            recordError(
              `Batch ${batchLabel}: ${slice.length} item(ns) não encontrado(s) em get_item_base_info`,
              slice.length,
            );
            continue;
          }
          console.error(`[IMPORT] Erro em batch ${batchLabel}:`, error);
          recordError(
            `Batch ${batchLabel}: ${error instanceof Error ? error.message : error}`,
            slice.length,
          );
        }
      }
    };

    const workers = Array.from(
      {
        length: Math.min(
          this.SHOPEE_IMPORT_MAX_CONCURRENT_BATCHES,
          batches.length,
        ),
      },
      () => worker(),
    );
    await Promise.all(workers);

    const baseInfoRatio =
      allItemIds.length > 0 ? itemDetails.length / allItemIds.length : 1;
    if (
      allItemIds.length > 0 &&
      (itemDetails.length === 0 ||
        baseInfoRatio < this.SHOPEE_IMPORT_MIN_BASE_INFO_RATIO)
    ) {
      const ratioPct = (baseInfoRatio * 100).toFixed(1);
      const message = `Falha crítica ao obter detalhes base do Shopee (${itemDetails.length}/${allItemIds.length}, ${ratioPct}% de sucesso)`;
      recordError(message, Math.max(allItemIds.length - itemDetails.length, 1));
      await emitProgress({
        phase: "failed",
        totalItemIds: allItemIds.length,
        fetchedBaseInfo: itemDetails.length,
        message,
      });
      throw new Error(message);
    }

    if (itemDetails.length > 0) {
      const sample = itemDetails.slice(0, 3).map((it: any) => ({
        item_id: it.item_id,
        item_sku: it.item_sku,
        has_model: it.has_model,
        model_sample: Array.isArray(it.model_list)
          ? it.model_list.slice(0, 2).map((m: any) => ({
              model_id: m.model_id,
              model_sku: m.model_sku,
              status: m.status,
            }))
          : null,
      }));
      console.log(`[IMPORT][Shopee] Sample base_info items:`, sample);
    }

    // 4. Flatten itens e variações
    const normalizeShopeeStatus = (status?: string | null) => {
      if (typeof status === "string" && status.length > 0) {
        const upper = status.toUpperCase();
        if (upper === "NORMAL") return "active";
        if (upper === "UNLINKED") return "pending";
        return upper.toLowerCase();
      }
      return "active";
    };

    type FlatItem = {
      externalId: string;
      sku: string | null;
      title: string;
      status: string;
      itemId: number;
    };
    const flatItems: FlatItem[] = [];
    for (const item of itemDetails) {
      const baseStatus = normalizeShopeeStatus(item.status);
      const snapshot = snapshotMap.get(item.item_id);
      if (item.has_model && Array.isArray((item as any).model_list)) {
        for (const model of (item as any).model_list as any[]) {
          const sku =
            this.extractShopeeSku(item, model) ||
            snapshot?.item_sku ||
            null;
          const externalId = `${item.item_id}:${model.model_id}`;
          flatItems.push({
            externalId,
            sku,
            title: `${item.item_name} - ${model.model_name || "variação"}`,
            status:
              model.status
                ? normalizeShopeeStatus(model.status)
                : baseStatus,
            itemId: item.item_id,
          });
        }
      } else {
        flatItems.push({
          externalId: item.item_id.toString(),
          sku: this.extractShopeeSku(item) /* item-level SKU */ || snapshot?.item_sku || null,
          title: item.item_name,
          status: baseStatus,
          itemId: item.item_id,
        });
      }
    }

    // Fallback para itens que retornaram 404: usar snapshot da listagem
    if (notFoundIds.length > 0) {
      console.warn(
        `[IMPORT] ${notFoundIds.length} item(ns) Shopee com 404 em base_info; usando snapshot da listagem como fallback`,
      );
      for (const id of notFoundIds) {
        const snap = listingSnapshot.find((s) => s.item_id === id);
        flatItems.push({
          externalId: id.toString(),
          sku: snap?.item_sku || null,
          title: snap?.item_name || `Shopee item ${id}`,
          status: normalizeShopeeStatus(snap?.status || "unlinked"),
          itemId: id,
        });
      }
    }

    result.totalItems = flatItems.length || result.totalItems;
    console.log(
      `[IMPORT] Starting to process ${result.totalItems} Shopee items (flattened)...`,
    );
    await emitProgress({
      phase: "processing",
      totalItemIds: allItemIds.length,
      totalItems: result.totalItems,
      fetchedBaseInfo: itemDetails.length,
      message: `Processando ${result.totalItems} item(ns) Shopee`,
    });

    const externalItemIds = flatItems.map((fi) => fi.externalId);
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

    // Indexar todos os produtos do usuário por SKU normalizado (evita case/spacing mismatch)
    // Buscar apenas os SKUs que aparecem nos itens, evitando ler todos os produtos do usuário
    const uniqueSkus = Array.from(
      new Set(
        flatItems
          .map((i) => normalizeSku(i.sku))
          .filter((s): s is string => Boolean(s)),
      ),
    );
    const userProducts = uniqueSkus.length
      ? await prisma.product.findMany({
          where: { userId: account.userId, skuNormalized: { in: uniqueSkus } },
          select: { id: true, sku: true, skuNormalized: true },
        })
      : [];
    const productsMap = new Map<
      string,
      { id: string; sku: string; skuNormalized: string | null }
    >();
    for (const p of userProducts) {
      const key = p.skuNormalized;
      if (key) productsMap.set(key, p);
    }

    const itemsWithSku = flatItems.filter((i) => normalizeSku(i.sku)).length;
    const matchedSkus = flatItems.filter(
      (i) => {
        const normalizedSku = normalizeSku(i.sku);
        return normalizedSku ? productsMap.has(normalizedSku) : false;
      },
    ).length;
    const sampleSkus = Array.from(
      new Set(
        flatItems
          .map((i) => normalizeSku(i.sku))
          .filter(Boolean)
          .slice(0, 20) as string[],
      ),
    );
    console.log(
      `[IMPORT] Found ${existingListings.length} existing listings; products indexed=${userProducts.length}; itemsWithSku=${itemsWithSku}; itemsWithoutSku=${flatItems.length - itemsWithSku}; matchedSkus=${matchedSkus}`,
    );
    console.log(`[IMPORT] Sample SKUs from Shopee (normalized):`, sampleSkus);
    console.log(
      `[IMPORT] Account userId=${account.userId}, marketplaceAccountId=${account.id}`,
    );

    // 5. Processar cada item
    let processedCount = 0;
    for (const item of flatItems) {
      try {
        const sku = item.sku;
        const normSku = normalizeSku(sku);
        const externalId = item.externalId;
        const existingListing = existingListingsMap.get(externalId);
        const product = normSku ? productsMap.get(normSku) : null;

        let processedItem: ImportResult["items"][0];

        if (existingListing) {
          // JÃ¡ existe, atualizar status se necessÃ¡rio
          if (existingListing.status !== item.status) {
            await ListingRepository.updateStatus(
              existingListing.id,
              item.status,
            );
          }

          processedItem = {
            externalListingId: externalId,
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
              externalListingId: externalId,
              externalSku: sku || undefined,
              status: item.status,
            });
          }

          processedItem = {
            externalListingId: externalId,
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
        if (processedCount % 50 === 0) {
          console.log(
            `[IMPORT] Processed ${processedCount}/${result.totalItems} Shopee items (${result.linkedItems} linked, ${result.unlinkedItems} unlinked)`,
          );
          await emitProgress({
            phase: "processing",
            totalItems: result.totalItems,
            processedItems: processedCount,
            linkedItems: result.linkedItems,
            unlinkedItems: result.unlinkedItems,
            message: `Processados ${processedCount}/${result.totalItems} item(ns) Shopee`,
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        recordError(`Item ${item.externalId}: ${errorMessage}`);
        pushItemPreview({
          externalListingId: item.externalId,
          title: item.title,
          sku: item.sku,
          linkedProductId: null,
          status: "error",
        });
        processedCount++;
      }
    }

    console.log(
      `[IMPORT] Completed processing ${processedCount} Shopee items. Final: ${result.linkedItems} linked, ${result.unlinkedItems} unlinked, ${result.errorCount} errors`,
    );
    await emitProgress({
      phase: "completed",
      totalItems: result.totalItems,
      processedItems: processedCount,
      linkedItems: result.linkedItems,
      unlinkedItems: result.unlinkedItems,
      finishedAt: new Date().toISOString(),
      message: `Importação Shopee concluída: ${result.linkedItems} vinculado(s), ${result.unlinkedItems} não vinculado(s)`,
    });

    // Registrar log da importaÃ§Ã£o
    if (!options?.skipFinalLog) {
      await this.logSync(
        account.id,
        SyncType.PRODUCT_SYNC,
        result.linkedItems > 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
        `Importados ${result.totalItems} itens do Shopee, ${result.linkedItems} vinculados`,
        {
          totalItems: result.totalItems,
          linkedItems: result.linkedItems,
          unlinkedItems: result.unlinkedItems,
          errorCount: result.errorCount ?? 0,
        },
      );
    }

    return result;
  }

  static async startShopeeImportJob(
    userId: string,
    accountId?: string,
  ): Promise<{ importId: string; status: ShopeeImportJobState; message: string }> {
    const account = await this.resolveShopeeAccount(userId, accountId);
    const queuedMessage = "Importação Shopee enfileirada";
    const created = await prisma.syncLog.create({
      data: {
        marketplaceAccountId: account.id,
        type: SyncType.PRODUCT_SYNC,
        status: SyncStatus.WARNING,
        message: queuedMessage,
        payload: {} as object,
      },
    });

    let payload = this.createShopeeImportPayload(created.id, account.id, {
      message: queuedMessage,
    });
    await prisma.syncLog.update({
      where: { id: created.id },
      data: {
        status: this.getShopeeImportSyncStatus(payload.state, payload.errorCount),
        message: payload.message,
        payload: payload as object,
      },
    });

    setImmediate(async () => {
      let lastFlushAt = 0;
      const flushProgress = async (
        partial: ShopeeImportProgress,
        force = false,
      ) => {
        payload = this.mergeShopeeImportPayload(payload, partial);
        if (
          !force &&
          Date.now() - lastFlushAt < this.SHOPEE_IMPORT_PROGRESS_FLUSH_MS
        ) {
          return;
        }

        await prisma.syncLog.update({
          where: { id: created.id },
          data: {
            status: this.getShopeeImportSyncStatus(
              payload.state,
              payload.errorCount,
            ),
            message: payload.message,
            payload: payload as object,
          },
        });
        lastFlushAt = Date.now();
      };

      try {
        await flushProgress(
          {
            phase: "listing",
            message: "Importação Shopee iniciada",
          },
          true,
        );

        const result = await this.importShopeeItems(userId, accountId, {
          skipFinalLog: true,
          onProgress: async (progress) => {
            await flushProgress(progress);
          },
        });

        await flushProgress(
          {
            phase: "completed",
            totalItems: result.totalItems,
            processedItems: result.totalItems,
            linkedItems: result.linkedItems,
            unlinkedItems: result.unlinkedItems,
            errorCount: result.errorCount ?? result.errors.length,
            itemsPreview: result.items,
            errorsPreview: result.errors,
            itemsPreviewTruncated: !!result.itemsPreviewTruncated,
            errorsPreviewTruncated: !!result.errorsPreviewTruncated,
            finishedAt: new Date().toISOString(),
            message: this.formatShopeeImportSummary(result),
          },
          true,
        );

        await (
          await import("@/app/services/system-log.service")
        ).SystemLogService.logSyncComplete(userId, "IMPORT", "Shopee", {
          totalItems: result.totalItems,
          linkedItems: result.linkedItems,
          unlinkedItems: result.unlinkedItems,
          errorCount: result.errorCount ?? result.errors.length,
          importId: created.id,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        const errorsPreview = [...payload.errorsPreview];
        if (
          !errorsPreview.includes(errorMessage) &&
          errorsPreview.length < this.IMPORT_ERRORS_PREVIEW_LIMIT
        ) {
          errorsPreview.push(errorMessage);
        }

        await flushProgress(
          {
            phase: "failed",
            errorCount: Math.max(payload.errorCount, 1),
            errorsPreview,
            errorsPreviewTruncated:
              payload.errorsPreviewTruncated ||
              errorsPreview.length >= this.IMPORT_ERRORS_PREVIEW_LIMIT,
            finishedAt: new Date().toISOString(),
            message: errorMessage,
          },
          true,
        );

        await (
          await import("@/app/services/system-log.service")
        ).SystemLogService.logSyncError(
          userId,
          "IMPORT",
          "Shopee",
          `${errorMessage} (importId=${created.id})`,
        );
        console.error(
          `[ShopeeImportJob] importId=${created.id} failed:`,
          error instanceof Error ? error.stack : error,
        );
      }
    });

    return {
      importId: created.id,
      status: payload.state,
      message: queuedMessage,
    };
  }

  static async getShopeeImportJobStatus(
    userId: string,
    importId: string,
  ): Promise<ShopeeImportJobStatus> {
    const syncLog = await prisma.syncLog.findFirst({
      where: {
        id: importId,
        marketplaceAccount: {
          userId,
          platform: Platform.SHOPEE,
        },
      },
    });

    if (!syncLog) {
      throw new Error("Importação Shopee não encontrada");
    }

    let payload = this.parseShopeeImportPayload(syncLog.payload, syncLog.id);
    const lastUpdatedMs =
      payload.finishedAt
        ? Date.parse(payload.finishedAt)
        : payload.startedAt
          ? Date.parse(payload.startedAt)
          : syncLog.createdAt.getTime();

    if (
      (payload.state === "queued" || payload.state === "running") &&
      Date.now() - lastUpdatedMs > this.SHOPEE_IMPORT_STALE_MS
    ) {
      payload = this.mergeShopeeImportPayload(payload, {
        phase: "failed",
        finishedAt: new Date().toISOString(),
        message:
          "Importação Shopee expirada antes da conclusão. Inicie uma nova importação.",
      });
      await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: SyncStatus.FAILURE,
          message: payload.message,
          payload: payload as object,
        },
      });
    }

    return {
      importId: syncLog.id,
      status: payload.state,
      progress: {
        state: payload.state,
        phase: payload.phase,
        totalItemIds: payload.totalItemIds,
        totalItems: payload.totalItems,
        pagesFetched: payload.pagesFetched,
        fetchedBaseInfo: payload.fetchedBaseInfo,
        processedItems: payload.processedItems,
        linkedItems: payload.linkedItems,
        unlinkedItems: payload.unlinkedItems,
        errorCount: payload.errorCount,
        itemsPreview: payload.itemsPreview,
        errorsPreview: payload.errorsPreview,
        itemsPreviewTruncated: payload.itemsPreviewTruncated,
        errorsPreviewTruncated: payload.errorsPreviewTruncated,
        startedAt: payload.startedAt,
        finishedAt: payload.finishedAt,
        message: payload.message,
      },
      result:
        payload.state === "completed" || payload.state === "failed"
          ? {
              totalItems: payload.totalItems,
              linkedItems: payload.linkedItems,
              unlinkedItems: payload.unlinkedItems,
              errorCount: payload.errorCount,
              itemsPreviewTruncated: payload.itemsPreviewTruncated,
              errorsPreviewTruncated: payload.errorsPreviewTruncated,
              items: payload.itemsPreview,
              errors: payload.errorsPreview,
            }
          : undefined,
    };
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
      let roots: any[] | null = null;

      try {
        roots = await MLApiService.getSiteCategories(
          siteId,
          account?.accessToken,
        );
      } catch (apiErr) {
        const status = (apiErr as any)?.response?.status;
        const isAuthErr = status === 401 || status === 403;
        // tenta refresh do token do seller antes do fallback local
        if (isAuthErr && account?.refreshToken) {
          try {
            const refreshed =
              await MLOAuthService.refreshAccessTokenForAccount(
                account.id,
                account.refreshToken,
              );
            await MarketplaceRepository.updateTokens(account.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            });
            roots = await MLApiService.getSiteCategories(
              siteId,
              refreshed.accessToken,
            );
          } catch (refreshErr) {
            console.warn(
              "[SYNC] Refresh do token ML falhou, usando fallback:",
              refreshErr instanceof Error ? refreshErr.message : refreshErr,
            );
          }
        }

        // fallback: tentar carregar de um JSON local
        const fallbackPath =
          process.env.ML_CATEGORIES_JSON ||
          path.resolve(process.cwd(), "scripts/tmp-ml-categories.json");
        if (!roots && fs.existsSync(fallbackPath)) {
          console.warn(
            `[SYNC] Usando fallback local de categorias: ${fallbackPath}`,
          );
          const raw = fs.readFileSync(fallbackPath, "utf8");
          const data = JSON.parse(raw);
          if (Array.isArray(data)) {
            roots = data;
          }
        }

        if (!roots) {
          throw apiErr;
        }
      }
      console.log(
        `[SYNC] Fetched ${roots.length} root categories for ${siteId}`,
      );

      if (!roots || roots.length === 0) {
        throw new Error("ML API não retornou categorias; abortando sync.");
      }

      const entries: any[] = [];
      const visited = new Set<string>();
      const queue = [...roots.map((c) => c.id)];
      let processed = 0;
      const MAX_CATEGORIES = 15000; // trava de segurança para não rodar indefinidamente
      const CONCURRENCY = 10;

      const pushEntry = (data: any) => {
        // Rejeitar IDs sintéticos (contêm hífen, ex.: MLB1747-01)
        if (typeof data.id === "string" && data.id.includes("-")) {
          return;
        }
        const path = data.path_from_root || [];
        const fullPath = path.map((p: any) => p.name).join(" > ");
        const parent = path.length > 1 ? path[path.length - 2].id : null;
        entries.push({
          externalId: data.id,
          siteId,
          name: data.name,
          fullPath,
          pathFromRoot: path,
          parentExternalId: parent,
          keywords: null,
        });
      };

      while (queue.length > 0) {
        if (processed > MAX_CATEGORIES) {
          console.warn(
            `[SYNC] Abortado preventivamente após ${processed} categorias (limite de segurança).`,
          );
          break;
        }

        const batch = queue.splice(0, CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (id) => {
            if (visited.has(id)) return [] as string[];
            visited.add(id);
            try {
              const data = await MLApiService.getCategory(id);
              pushEntry(data);
              processed++;
              if (processed % 500 === 0) {
                console.log(
                  `[SYNC] Processadas ${processed} categorias (fila: ${queue.length})`,
                );
              }
              const children = Array.isArray((data as any).children_categories)
                ? (data as any).children_categories
                : [];
              return children
                .map((c: any) => c?.id)
                .filter((cid: any) => typeof cid === "string");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[SYNC] Failed to fetch category ${id}:`, msg);
              return [] as string[];
            }
          }),
        );

        for (const childList of batchResults) {
          for (const childId of childList) {
            if (!visited.has(childId)) queue.push(childId);
          }
        }
      }

      if (entries.length > 0) {
        console.log(`[SYNC] Gravando ${entries.length} categorias no banco...`);
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
  private static async resolveShopeeAccount(userId: string, accountId?: string) {
    const account = accountId
      ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
      : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
          userId,
          Platform.SHOPEE,
        );

    if (!account || !account.accessToken || !account.shopId) {
      throw new Error("Conta do Shopee não conectada ou sem credenciais");
    }

    return account;
  }

  private static createShopeeImportPayload(
    importId: string,
    accountId: string,
    partial: Partial<ShopeeImportJobPayload> = {},
  ): ShopeeImportJobPayload {
    return {
      kind: "SHOPEE_IMPORT",
      state: "queued",
      phase: "queued",
      importId,
      accountId,
      totalItemIds: 0,
      totalItems: 0,
      pagesFetched: 0,
      fetchedBaseInfo: 0,
      processedItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      errorCount: 0,
      itemsPreview: [],
      errorsPreview: [],
      itemsPreviewTruncated: false,
      errorsPreviewTruncated: false,
      startedAt: new Date().toISOString(),
      ...partial,
    };
  }

  private static parseShopeeImportPayload(
    payload: unknown,
    importId: string,
  ): ShopeeImportJobPayload {
    const parsed =
      payload && typeof payload === "object"
        ? (payload as Partial<ShopeeImportJobPayload>)
        : {};

    return this.createShopeeImportPayload(
      importId,
      parsed.accountId || "",
      parsed,
    );
  }

  private static mergeShopeeImportPayload(
    current: ShopeeImportJobPayload,
    partial: ShopeeImportProgress,
  ): ShopeeImportJobPayload {
    const phase = partial.phase ?? current.phase;
    let state = current.state;
    if (phase === "completed") {
      state = "completed";
    } else if (phase === "failed") {
      state = "failed";
    } else if (phase !== "queued") {
      state = "running";
    }

    return {
      ...current,
      ...partial,
      state,
      phase,
      itemsPreview: partial.itemsPreview ?? current.itemsPreview,
      errorsPreview: partial.errorsPreview ?? current.errorsPreview,
      itemsPreviewTruncated:
        partial.itemsPreviewTruncated ?? current.itemsPreviewTruncated,
      errorsPreviewTruncated:
        partial.errorsPreviewTruncated ?? current.errorsPreviewTruncated,
      finishedAt: partial.finishedAt ?? current.finishedAt,
      message: partial.message ?? current.message,
    };
  }

  private static getShopeeImportSyncStatus(
    state: ShopeeImportJobState,
    errorCount: number,
  ): SyncStatus {
    if (state === "failed") {
      return SyncStatus.FAILURE;
    }
    if (state === "completed" && errorCount === 0) {
      return SyncStatus.SUCCESS;
    }
    return SyncStatus.WARNING;
  }

  private static formatShopeeImportSummary(result: ImportResult): string {
    const errorCount = result.errorCount ?? result.errors.length;
    return `Importação Shopee concluída: ${result.totalItems} item(ns), ${result.linkedItems} vinculado(s), ${result.unlinkedItems} não vinculado(s), ${errorCount} erro(s)`;
  }

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

    // Por fim, tentar extrair SKU das variações (seller_custom_field ou atributos)
    if (Array.isArray((item as any).variations) && (item as any).variations.length > 0) {
      const variationSkus = new Set<string>();
      for (const v of (item as any).variations) {
        if (v?.seller_custom_field) {
          variationSkus.add(String(v.seller_custom_field));
          continue;
        }
        if (Array.isArray(v?.attributes)) {
          const attrSku = v.attributes.find(
            (attr: any) =>
              attr.id === "SELLER_SKU" ||
              attr.id === "SKU" ||
              (attr.id && typeof attr.id === "string" && attr.id.toLowerCase().includes("sku")),
          );
          if (attrSku?.value_name) {
            variationSkus.add(String(attrSku.value_name));
            continue;
          }
        }
      }
      if (variationSkus.size === 1) {
        return Array.from(variationSkus)[0];
      }
      // Se houver múltiplos SKUs diferentes entre variações, não arriscar matching errado
    }

    return null;
  }

  /**
   * Extrai SKU de item ou modelo do Shopee, normalizando strings vazias.
   */
  private static extractShopeeSku(
    item: Partial<ShopeeItem>,
    model?: { model_sku?: string | null },
  ): string | null {
    const raw =
      (model?.model_sku ?? item.item_sku ?? "").toString().trim() || null;
    return raw && raw.length > 0 ? raw : null;
  }

  private static getShopeeAvailableStock(item: Partial<ShopeeItem> & any): number {
    const summaryStock = item?.stock_info_v2?.summary_info?.total_available_stock;
    if (typeof summaryStock === "number") {
      return summaryStock;
    }

    if (Array.isArray(item?.stock_info) && item.stock_info.length > 0) {
      const quantity = item.stock_info[0]?.stock_quantity;
      if (typeof quantity === "number") {
        return quantity;
      }
    }

    return 0;
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

        results.push({ ...result, platform: account.platform });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        results.push({
          success: false,
          productId,
          externalListingId: listing.externalListingId,
          platform: account.platform,
          error: errorMessage,
        });
      }
    }

    return results;
  }

  private static async logMLStockWarningAndReturn(
    accountId: string,
    listing: any,
    product: any,
    currentItem: MLItemDetails,
    message: string,
  ): Promise<SyncResult> {
    const previousStock = currentItem?.available_quantity ?? 0;

    await this.logSync(
      accountId,
      SyncType.STOCK_UPDATE,
      SyncStatus.WARNING,
      message,
      {
        productId: product.id,
        externalListingId: listing.externalListingId,
        previousStock,
        desiredStock: product.stock,
        remoteStatus: currentItem.status,
        remoteAvailableQuantity: previousStock,
      },
    );

    return {
      success: true,
      productId: product.id,
      externalListingId: listing.externalListingId,
      previousStock,
      newStock: previousStock,
    };
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
      const currentStatus = currentItem?.status;

      if (currentStatus === "closed") {
        return this.logMLStockWarningAndReturn(
          account.id,
          listing,
          product,
          currentItem,
          `Anúncio ${listing.externalListingId} está fechado no Mercado Livre; sincronização de estoque ignorada.`,
        );
      }

      if (product.stock <= 0) {
        if (
          currentStatus === "paused" ||
          currentStatus === "inactive" ||
          currentStatus === "under_review"
        ) {
          return this.logMLStockWarningAndReturn(
            account.id,
            listing,
            product,
            currentItem,
            `Anúncio ${listing.externalListingId} já está ${currentStatus} no Mercado Livre; estoque local 0 não exige atualização de quantidade.`,
          );
        }

        if (currentStatus === "active") {
          await MLApiService.updateItem(account.accessToken, listing.externalListingId, {
            status: "paused",
          });

          await this.logSync(
            account.id,
            SyncType.STOCK_UPDATE,
            SyncStatus.SUCCESS,
            `Anúncio ${listing.externalListingId} pausado no Mercado Livre porque o estoque local do produto ${product.name} chegou a 0.`,
            {
              productId: product.id,
              externalListingId: listing.externalListingId,
              previousStock,
              desiredStock: product.stock,
              remoteStatusBefore: currentStatus,
              remoteStatusAfter: "paused",
            },
          );

          return {
            success: true,
            productId: product.id,
            externalListingId: listing.externalListingId,
            previousStock,
            newStock: product.stock,
          };
        }
      }

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

    const parseItemId = (externalId: string) =>
      parseInt(externalId.split(":")[0], 10);
    let accessToken = account.accessToken;

    const refreshIfNeeded = async (err: any) => {
      const status = err?.status;
      if (
        (status === 401 || status === 403) &&
        account.refreshToken &&
        account.shopId
      ) {
        const refreshed = await ShopeeOAuthService.refreshAccessToken(
          account.refreshToken,
          account.shopId,
        );
        await MarketplaceRepository.updateTokens(account.id, {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: new Date(Date.now() + refreshed.expire_in * 1000),
        });
        accessToken = refreshed.access_token;
        return true;
      }
      return false;
    };

    try {
      // Buscar item atual no Shopee para log
      const currentItem = await ShopeeApiService.getItemBaseInfo(
        accessToken,
        account.shopId,
        parseItemId(listing.externalListingId),
      );

      const previousStock = this.getShopeeAvailableStock(currentItem);

      // Atualizar estoque no Shopee
      await ShopeeApiService.updateItemStock(
        accessToken,
        account.shopId,
        parseItemId(listing.externalListingId),
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
      const maybeRefreshed = await refreshIfNeeded(error as any);
      if (maybeRefreshed) {
        return this.syncShopeeProductStock(
          { ...listing, marketplaceAccount: { ...account, accessToken } },
          product,
        );
      }

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

    // 2. Para cada conta, buscar listings e sincronizar diretamente (sem re-query)
    for (const account of accounts) {
      const listings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        include: { product: true, marketplaceAccount: true },
      });

      // Deduplicar por productId (mesmo produto pode ter listings duplicados)
      const seen = new Set<string>();
      const uniqueListings = listings.filter((l) => {
        if (!l.product || seen.has(l.product.id)) return false;
        seen.add(l.product.id);
        return true;
      });

      result.total += uniqueListings.length;
      console.log(
        `[syncAllStock] Conta ${account.id} (${platform}): ${uniqueListings.length} listings únicos de ${listings.length} totais`,
      );

      // Processar em lotes de 3 para evitar sobrecarga de conexão DB + API
      const BATCH_SIZE = 3;
      for (let i = 0; i < uniqueListings.length; i += BATCH_SIZE) {
        const batch = uniqueListings.slice(i, i + BATCH_SIZE);
        console.log(
          `[syncAllStock] Processando lote ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(uniqueListings.length / BATCH_SIZE)} (${batch.length} itens)`,
        );

        const batchResults = await Promise.allSettled(
          batch.map(async (listing) => {
            // Timeout de 15s por item para evitar travamento
            const timeoutMs = 15000;
            const syncPromise = (async () => {
              switch (platform) {
                case Platform.MERCADO_LIVRE:
                  return this.syncMLProductStock(listing, listing.product);
                case Platform.SHOPEE:
                  return this.syncShopeeProductStock(listing, listing.product);
                default:
                  return {
                    success: false,
                    productId: listing.product!.id,
                    externalListingId: listing.externalListingId,
                    error: `Plataforma ${platform} não suportada`,
                  } as SyncResult;
              }
            })();

            const timeoutPromise = new Promise<SyncResult>((_, reject) =>
              setTimeout(
                () => reject(new Error("Timeout ao sincronizar estoque")),
                timeoutMs,
              ),
            );

            return Promise.race([syncPromise, timeoutPromise]);
          }),
        );

        for (const settled of batchResults) {
          if (settled.status === "fulfilled") {
            result.results.push(settled.value);
            if (settled.value.success) {
              result.successful++;
            } else {
              result.failed++;
            }
          } else {
            result.failed++;
            result.results.push({
              success: false,
              productId: "",
              externalListingId: "",
              error: settled.reason?.message || "Erro desconhecido",
            });
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

    console.log(
      `[syncAllStock] Concluído: ${result.successful}/${result.total} sucesso, ${result.failed} falhas`,
    );

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

      if (currentItem.status === "closed") {
        await this.logSync(
          account.id,
          SyncType.PRODUCT_SYNC,
          SyncStatus.WARNING,
          `Anúncio ${externalListingId} está fechado no Mercado Livre; sincronização completa ignorada.`,
          {
            productId: product.id,
            externalListingId,
            previousStock: currentItem.available_quantity,
            desiredStock: product.stock,
            remoteStatus: currentItem.status,
          },
        );

        result.success = true;
        result.previousStock = currentItem.available_quantity;
        result.newStock = currentItem.available_quantity;
        return result;
      }

      // Sempre sincronizar preÃ§o; estoque depende do estado do anúncio
      updateData.price = Number(product.price);
      if (product.stock > 0) {
        updateData.available_quantity = product.stock;
      } else if (currentItem.status === "active") {
        updateData.status = "paused";
      }

      // SÃ³ sincronizar tÃ­tulo e descriÃ§Ã£o se o anÃºncio estiver ativo
      // AnÃºncios pausados nÃ£o permitem atualizaÃ§Ã£o de tÃ­tulo/descriÃ§Ã£o
      if (currentItem.status === "active" && product.stock > 0) {
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
      const currentItem = await ShopeeApiService.getItemBaseInfo(
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
      result.previousStock = this.getShopeeAvailableStock(currentItem);
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

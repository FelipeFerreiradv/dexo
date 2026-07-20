/**
 * SyncUseCase - OrquestraÃ§Ã£o de sincronizaÃ§Ã£o entre estoque local e Mercado Livre
 *
 * Responsabilidades:
 * - Importar itens do ML e vincular automaticamente por SKU
 * - Sincronizar estoque do sistema central para o ML
 * - Registrar logs de sincronizaÃ§Ã£o
 */

import prisma from "@/app/lib/prisma";
import { findManyInChunks } from "@/app/lib/prisma-chunked";
import { Platform, SyncType, SyncStatus } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MagaluApiService } from "../services/magalu-api.service";
import { MagaluOAuthService } from "../services/magalu-oauth.service";
import { OlxApiService } from "../services/olx-api.service";
import { OlxPayloadBuilderService } from "../services/olx-payload-builder.service";
import { OlxCategoryResolutionService } from "../services/olx-category-resolution.service";
import { OLX_CONSTANTS } from "../olx/olx-constants";
import CategoryRepository from "../repositories/category.repository";
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ListingUseCase } from "./listing.usercase";
import {
  ListingAutodetectUseCase,
  type AutodetectImportCache,
} from "./listing-autodetect.usercase";
import { SystemLogService } from "@/app/services/system-log.service";
import type { MLItemDetails } from "../types/ml-api.types";
import type { MLItemUpdatePayload } from "../types/ml-api.types";
import type { ShopeeItem } from "../types/shopee-api.types";
import type { MagaluSku } from "../types/magalu-api.types";
import { normalizeSku } from "@/app/lib/sku";
import { normalizeListingStatus } from "../lib/listing-status";
import fs from "node:fs";
import path from "node:path";

// Tipos para resultados de sincronizaÃ§Ã£o
export interface ImportResult {
  totalItems: number;
  linkedItems: number;
  unlinkedItems: number;
  errorCount?: number;
  // Contadores aditivos (opcionais) do fluxo "criar+vincular" via núcleo de
  // auto-detecção. Ausentes nos chamadores legados → zero regressão.
  /** Produtos NOVOS criados a partir de anúncios ativos sem produto. */
  createdProducts?: number;
  /** Anúncios cujo listing já existia (reimport idempotente / no-op). */
  alreadyLinked?: number;
  /** Anúncios religados após perder corrida de criação concorrente (raced). */
  skippedDuplicates?: number;
  /** Quantidade de contas ACTIVE processadas (importação multi-conta). */
  accountsProcessed?: number;
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
  phase:
    "queued" | "listing" | "details" | "processing" | "completed" | "failed";
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

// Job genérico de importação "criar+vincular" (usado por ML e Magalu, cujas
// abas hoje eram fire-and-forget sem contagens). A Shopee mantém seu job rico
// próprio. Estado persistido no payload de um SyncLog.
type GenericImportJobState = "running" | "completed" | "failed";

interface GenericImportJobPayload {
  kind: "GENERIC_IMPORT";
  platform: Platform;
  state: GenericImportJobState;
  startedAt: string;
  finishedAt?: string;
  accountsTotal: number;
  accountsDone: number;
  processedItems: number;
  message?: string;
  result?: ImportResult;
}

export interface GenericImportJobStatus {
  importId: string;
  status: GenericImportJobState;
  progress: {
    state: GenericImportJobState;
    accountsTotal: number;
    accountsDone: number;
    processedItems: number;
    startedAt: string;
    finishedAt?: string;
    message?: string;
  };
  result?: ImportResult;
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
  skipped?: boolean;
  skipReason?: string;
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
   * Concatena descrição do produto + bloco "Compatível com:" gerado a partir
   * das compatibilidades veiculares. Usado em `syncMLProductData` e
   * `syncShopeeProductData` para garantir que o comprador veja a lista de
   * veículos compatíveis mesmo sem chamadas a endpoints proprietários de
   * compatibility (ex.: ML autopart catalog).
   * Idempotente: se a descrição já contém "Compatível com", retorna como está.
   */
  private static appendCompatibilityBlock(
    description: string | null | undefined,
    compatibilities:
      | Array<{
          brand: string;
          model: string;
          yearFrom?: number | null;
          yearTo?: number | null;
          version?: string | null;
        }>
      | null
      | undefined,
  ): string {
    const baseRaw = (description ?? "").toString();
    if (!Array.isArray(compatibilities) || compatibilities.length === 0) {
      return baseRaw;
    }
    if (/compat[ií]vel com/i.test(baseRaw)) {
      return baseRaw;
    }
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const compat of compatibilities) {
      if (!compat) continue;
      const brand = (compat.brand || "").trim();
      const model = (compat.model || "").trim();
      if (!brand || !model) continue;
      const yFrom =
        typeof compat.yearFrom === "number" && compat.yearFrom > 0
          ? compat.yearFrom
          : null;
      const yTo =
        typeof compat.yearTo === "number" && compat.yearTo > 0
          ? compat.yearTo
          : null;
      let yearPart = "";
      if (yFrom && yTo && yFrom !== yTo) yearPart = `${yFrom}-${yTo}`;
      else if (yFrom && yTo) yearPart = `${yFrom}`;
      else if (yFrom) yearPart = `${yFrom}+`;
      else if (yTo) yearPart = `até ${yTo}`;
      const versionPart =
        typeof compat.version === "string" && compat.version.trim().length > 0
          ? compat.version.trim()
          : "";
      const line = [
        brand.toUpperCase(),
        model.toUpperCase(),
        yearPart,
        versionPart,
      ]
        .filter(Boolean)
        .join(" ");
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    if (lines.length === 0) return baseRaw;
    const block = `\n\nCompatível com:\n- ${lines.join("\n- ")}`;
    return baseRaw ? `${baseRaw}${block}` : block.trimStart();
  }

  /**
   * Contabiliza o resultado do núcleo de auto-detecção nos contadores aditivos
   * do ImportResult. `linked_existing_product` não incrementa aqui — é contado
   * como `linkedItems` pelo chamador (o produto já existia e foi só vinculado).
   */
  private static tallyAutodetect(
    result: ImportResult,
    action:
      | "listing_exists"
      | "linked_existing_product"
      | "created_product"
      | "raced",
  ): void {
    if (action === "created_product") {
      result.createdProducts = (result.createdProducts ?? 0) + 1;
    } else if (action === "listing_exists") {
      result.alreadyLinked = (result.alreadyLinked ?? 0) + 1;
    } else if (action === "raced") {
      result.skippedDuplicates = (result.skippedDuplicates ?? 0) + 1;
    }
  }

  /**
   * Importa todos os itens do Mercado Livre. Vincula por SKU quando o produto já
   * existe e, para anúncios ATIVOS sem produto, cria o produto e vincula via o
   * núcleo idempotente `ListingAutodetectUseCase` (anti-duplicação por SKU).
   * NÃO aplica gate de baseline (importa todos os ativos, não só os novos).
   */
  static async importMLItems(
    userId: string,
    accountId?: string,
    options?: {
      skipFinalLog?: boolean;
      onProgress?: (progress: {
        processedItems: number;
        totalItems: number;
        linkedItems: number;
        createdProducts: number;
      }) => Promise<void> | void;
    },
  ): Promise<ImportResult> {
    const result: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      createdProducts: 0,
      alreadyLinked: 0,
      skippedDuplicates: 0,
      errors: [],
      items: [],
    };

    // Preview de itens com truncamento (corrige referência ausente do fluxo
    // legado, que chamava pushItemPreview sem defini-la neste escopo).
    const pushItemPreview = (item: ImportItemResult) => {
      if (result.items.length < this.IMPORT_ITEMS_PREVIEW_LIMIT) {
        result.items.push(item);
        return;
      }
      result.itemsPreviewTruncated = true;
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

    // Buscar listings existentes em lote (EGRESS: só as colunas usadas abaixo).
    // Em lotes: contas grandes (>32k anúncios ativos) estouravam o teto de
    // bind variables do Postgres num único IN(...).
    const existingListings = await findManyInChunks(
      externalItemIds,
      (ids) =>
        prisma.productListing.findMany({
          where: {
            marketplaceAccountId: account.id,
            externalListingId: { in: ids },
          },
          select: {
            id: true,
            externalListingId: true,
            status: true,
            permalink: true,
            productId: true,
          },
        }),
    );
    const existingListingsMap = new Map(
      existingListings.map((listing) => [listing.externalListingId, listing]),
    );

    // Buscar produtos por SKU em lote (EGRESS: id + skuNormalized + name — o
    // name alimenta a guarda de título do box-label via cache, substituindo a
    // query fresca por item do núcleo).
    const products = await findManyInChunks(normalizedSkus, (skus) =>
      prisma.product.findMany({
        where: { skuNormalized: { in: skus }, userId: account.userId },
        select: { id: true, skuNormalized: true, name: true },
      }),
    );
    const productsMap = new Map(
      products
        .map((product) => [product.skuNormalized, product] as const)
        .filter(
          (entry): entry is readonly [string, (typeof products)[number]] =>
            Boolean(entry[0]),
        ),
    );

    console.log(
      `[IMPORT] Found ${existingListings.length} existing listings and ${products.length} matching products`,
    );

    // EGRESS/PERF: pré-carrega em UMA query os produtos casados que já têm
    // anúncio NESTA conta (guarda de box-label). Evita o N+1 de 1 findFirst por
    // item casado por SKU. `withListing.add` no link do lote mantém idêntico.
    const matchedProductIds = products.map((p) => p.id);
    const withListing = new Set<string>(
      (
        await findManyInChunks(matchedProductIds, (productIds) =>
          prisma.productListing.findMany({
            where: {
              marketplaceAccountId: account.id,
              productId: { in: productIds },
            },
            select: { productId: true },
            distinct: ["productId"],
          }),
        )
      ).map((l) => l.productId),
    );

    // Cache write-through do núcleo (só no IMPORT em lote; webhook fica
    // fresco): os preloads acima já respondem os passos 1-3 do núcleo, e o
    // núcleo registra de volta cada produto/listing criado — item seguinte
    // com o mesmo SKU enxerga, exatamente como a query fresca garantia.
    const importCache: AutodetectImportCache = {
      productsBySku: new Map(
        [...productsMap].map(([k, p]) => [k, { id: p.id, name: p.name }]),
      ),
      productIdsWithListing: withListing,
      knownExternalListingIds: new Set(
        existingListings.map((l) => l.externalListingId),
      ),
    };

    // 5. Processar cada item
    let processedCount = 0;
    for (const item of activeItems) {
      try {
        const sku = this.extractSku(item);
        const existingListing = existingListingsMap.get(item.id);

        let processedItem: ImportResult["items"][0];

        if (existingListing) {
          // JÃ¡ existe, atualizar status/permalink se necessÃ¡rio.
          // Write-on-change (antes era write-once): se o permalink mudou no ML
          // (ex.: slug do título editado), corrige no nosso banco.
          const needsStatusUpdate = existingListing.status !== item.status;
          const needsPermalinkUpdate =
            !!item.permalink && existingListing.permalink !== item.permalink;

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
          // TODO o resto passa pelo MESMO núcleo idempotente: casa por SKU
          // (vinculando ao produto existente, inclusive de outra plataforma),
          // aplica a guarda de "SKU de caixa" e faz upsert do listing. Antes
          // havia aqui um ramo próprio que criava o listing por fora — duas
          // implementações da mesma regra, que podiam divergir. O núcleo já
          // cobre esse caso (`linked_existing_product`, que não altera nenhum
          // contador) e ainda é idempotente no listing.
          const outcome =
            await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
              ListingAutodetectUseCase.normalizeMLItem(
                { id: account.id, userId: account.userId },
                item,
              ),
              importCache,
            );
          this.tallyAutodetect(result, outcome.action);

          processedItem = {
            externalListingId: item.id,
            title: item.title,
            sku,
            linkedProductId: outcome.productId,
            status: outcome.productId ? "linked" : "unlinked",
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
          if (options?.onProgress) {
            await options.onProgress({
              processedItems: processedCount,
              totalItems: result.totalItems,
              linkedItems: result.linkedItems,
              createdProducts: result.createdProducts ?? 0,
            });
          }
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
    if (!options?.skipFinalLog) {
      await this.logSync(
        account.id,
        SyncType.PRODUCT_SYNC,
        result.linkedItems > 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
        `Importados ${result.totalItems} itens, ${result.linkedItems} vinculados`,
        { totalItems: result.totalItems, linkedItems: result.linkedItems },
      );
    }

    return result;
  }

  /**
   * Importa anúncios (SKUs) do portfólio da Magalu e tenta vincular por SKU.
   * Espelha importMLItems (busca em lote de listings/produtos + auto-vínculo).
   */
  static async importMagaluItems(
    userId: string,
    accountId?: string,
    options?: {
      skipFinalLog?: boolean;
      onProgress?: (progress: {
        processedItems: number;
        totalItems: number;
        linkedItems: number;
        createdProducts: number;
      }) => Promise<void> | void;
    },
  ): Promise<ImportResult> {
    const result: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      createdProducts: 0,
      alreadyLinked: 0,
      skippedDuplicates: 0,
      errors: [],
      items: [],
    };

    const account = accountId
      ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
      : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
          userId,
          Platform.MAGALU,
        );

    if (!account || !account.accessToken) {
      throw new Error("Conta da Magalu não conectada ou sem credenciais");
    }

    // Paginação: itera o portfólio por offset até esgotar (página < limit),
    // com trava de segurança. Importa TODOS os SKUs ativos (não só a 1ª página).
    const MAGALU_PAGE_SIZE = 100;
    const MAGALU_MAX_PAGES = 500; // trava (até 50k SKUs) contra loop infinito
    const skus: MagaluSku[] = [];
    for (let page = 0; page < MAGALU_MAX_PAGES; page++) {
      const pageSkus = await MagaluApiService.listSkus(account.accessToken, {
        limit: MAGALU_PAGE_SIZE,
        offset: page * MAGALU_PAGE_SIZE,
      });
      skus.push(...pageSkus);
      if (pageSkus.length < MAGALU_PAGE_SIZE) break;
    }
    if (skus.length === 0) {
      return result;
    }

    result.totalItems = skus.length;

    const extractSku = (s: MagaluSku): string | null =>
      (s.seller_sku as string) ||
      (s.sku as string) ||
      (s.code as string) ||
      null;
    // A identidade da Magalu é o SKU do seller (= chave de /skus/{sku} e do
    // create). Por isso o SKU vem ANTES do `id` interno — create/import/auto-
    // detecção gravam todos a MESMA chave (sem divergir → sem duplicar).
    const extractExternalId = (s: MagaluSku): string =>
      String(extractSku(s) ?? s.id ?? "");

    const externalItemIds = skus
      .map((s) => extractExternalId(s))
      .filter(Boolean);
    // SKUs crus (= product.sku, gravado em externalSku) p/ casar o placeholder
    // PENDING_<sku> que o create da Magalu deixa (POST 202 sem id real). Sem
    // isto, o import não acharia o vínculo por externalListingId e DUPLICARIA.
    const rawSkus = Array.from(
      new Set(
        skus
          .map((s) => extractSku(s))
          .filter((sku): sku is string => Boolean(sku)),
      ),
    );
    const normalizedSkus = Array.from(
      new Set(
        skus
          .map((s) => normalizeSku(extractSku(s)))
          .filter((sku): sku is string => Boolean(sku)),
      ),
    );

    // EGRESS: só as colunas usadas (id/externalListingId/externalSku/status/permalink/productId).
    // O OR de duas listas somava os binds das DUAS (id externo + SKU) na mesma
    // query. Rodamos cada ramo em lotes e unimos: a união é equivalente ao OR,
    // com dedupe por id porque a mesma linha pode casar nos dois ramos.
    const listingSelect = {
      id: true,
      externalListingId: true,
      externalSku: true,
      status: true,
      permalink: true,
      productId: true,
    } as const;
    const existingListings = [
      ...new Map(
        [
          ...(await findManyInChunks(externalItemIds, (ids) =>
            prisma.productListing.findMany({
              where: {
                marketplaceAccountId: account.id,
                externalListingId: { in: ids },
              },
              select: listingSelect,
            }),
          )),
          ...(await findManyInChunks(rawSkus, (skus) =>
            prisma.productListing.findMany({
              where: {
                marketplaceAccountId: account.id,
                externalSku: { in: skus },
              },
              select: listingSelect,
            }),
          )),
        ].map((l) => [l.id, l] as const),
      ).values(),
    ];
    const existingListingsMap = new Map(
      existingListings.map((l) => [l.externalListingId, l]),
    );
    // Índice por SKU p/ reusar o vínculo placeholder (PENDING_<sku>) em vez de
    // criar duplicata quando a Magalu devolve o id real (≈ o próprio SKU). Só é
    // consultado no fallback abaixo — quando NÃO houve match por id externo.
    const existingBySku = new Map(
      existingListings
        .filter((l) => l.externalSku)
        .map((l) => [l.externalSku as string, l] as const),
    );

    const products = await findManyInChunks(normalizedSkus, (skus) =>
      prisma.product.findMany({
        where: { skuNormalized: { in: skus }, userId: account.userId },
        // name alimenta a guarda de título do box-label via cache.
        select: { id: true, skuNormalized: true, name: true },
      }),
    );
    const productsMap = new Map(
      products
        .map((p) => [p.skuNormalized, p] as const)
        .filter((e): e is readonly [string, (typeof products)[number]] =>
          Boolean(e[0]),
        ),
    );

    // EGRESS/PERF: pré-carrega em UMA query os produtos casados que já têm
    // anúncio NESTA conta (guarda de box-label sem N+1).
    const matchedProductIds = products.map((p) => p.id);
    const withListing = new Set<string>(
      (
        await findManyInChunks(matchedProductIds, (productIds) =>
          prisma.productListing.findMany({
            where: {
              marketplaceAccountId: account.id,
              productId: { in: productIds },
            },
            select: { productId: true },
            distinct: ["productId"],
          }),
        )
      ).map((l) => l.productId),
    );

    // Cache write-through do núcleo (mesmo desenho do import ML).
    const importCache: AutodetectImportCache = {
      productsBySku: new Map(
        [...productsMap].map(([k, p]) => [k, { id: p.id, name: p.name }]),
      ),
      productIdsWithListing: withListing,
      knownExternalListingIds: new Set(
        existingListings.map((l) => l.externalListingId),
      ),
    };

    const PREVIEW_CAP = 50;
    for (const s of skus) {
      const externalListingId = extractExternalId(s);
      try {
        const sku = extractSku(s);
        // Casa primeiro pelo id externo; se não houver, tenta pelo SKU (caso do
        // placeholder PENDING_<sku> do create) p/ NÃO duplicar o vínculo. O
        // fallback por SKU só dispara quando não houve match por id — então se
        // já existir uma linha com o id real, é ela que casa (sem conflito).
        const existingListing =
          existingListingsMap.get(externalListingId) ||
          (sku ? existingBySku.get(sku) : undefined);
        const status = (s.status as string) || "active";
        const permalink = (s.permalink as string) || (s.url as string) || null;

        let linkedProductId: string | null = null;

        if (existingListing) {
          linkedProductId = existingListing.productId;
          // Upgrade do placeholder: PENDING_<sku> → id externo real da Magalu.
          const needsIdUpgrade =
            !!externalListingId &&
            existingListing.externalListingId !== externalListingId;
          const needsStatusUpdate = existingListing.status !== status;
          // Write-on-change: corrige permalink que mudou no marketplace.
          const needsPermalinkUpdate =
            !!permalink && existingListing.permalink !== permalink;
          if (needsIdUpgrade || needsStatusUpdate || needsPermalinkUpdate) {
            await ListingRepository.updateListing(existingListing.id, {
              externalListingId: needsIdUpgrade ? externalListingId : undefined,
              status: needsStatusUpdate ? status : undefined,
              permalink: needsPermalinkUpdate ? permalink : undefined,
            });
          }
        } else {
          // Mesma regra única do núcleo idempotente (ver importMLItems): casa
          // por SKU e vincula ao produto existente — inclusive quando ele veio
          // de outra plataforma —, aplica a guarda de "SKU de caixa" e faz
          // upsert do listing.
          const outcome =
            await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
              ListingAutodetectUseCase.normalizeMagaluItem(
                { id: account.id, userId: account.userId },
                s,
              ),
              importCache,
            );
          this.tallyAutodetect(result, outcome.action);
          linkedProductId = outcome.productId;
        }

        if (result.items.length < PREVIEW_CAP) {
          result.items.push({
            externalListingId,
            title: (s.title as string) || externalListingId,
            sku,
            linkedProductId,
            status: linkedProductId ? "linked" : "unlinked",
          });
        }
        if (linkedProductId) result.linkedItems++;
        else result.unlinkedItems++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";
        result.errors.push(`Item ${externalListingId}: ${errorMessage}`);
      }
    }

    if (options?.onProgress) {
      await options.onProgress({
        processedItems: result.totalItems,
        totalItems: result.totalItems,
        linkedItems: result.linkedItems,
        createdProducts: result.createdProducts ?? 0,
      });
    }

    if (options?.skipFinalLog) {
      return result;
    }

    await this.logSync(
      account.id,
      SyncType.PRODUCT_SYNC,
      result.linkedItems > 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Importados ${result.totalItems} itens da Magalu, ${result.linkedItems} vinculados`,
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
      createdProducts: 0,
      alreadyLinked: 0,
      skippedDuplicates: 0,
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
    const listingSnapshot: {
      item_id: number;
      item_sku?: string;
      item_name?: string;
      status?: string;
    }[] = [];
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
    const snapshotMap = new Map<
      number,
      { item_sku?: string; item_name?: string; status?: string }
    >();
    for (const snap of listingSnapshot) {
      snapshotMap.set(snap.item_id, snap);
    }

    const sampleSnapshotSkus = Array.from(snapshotMap.values())
      .map((s) => s.item_sku)
      .filter(Boolean)
      .slice(0, 20);
    console.log(
      `[IMPORT][Shopee] Sample item_sku from list call:`,
      sampleSnapshotSkus,
    );

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
              console.error(
                `[IMPORT] Erro em batch ${batchLabel} após refresh:`,
                err,
              );
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
            this.extractShopeeSku(item, model) || snapshot?.item_sku || null;
          const externalId = `${item.item_id}:${model.model_id}`;
          flatItems.push({
            externalId,
            sku,
            title: `${item.item_name} - ${model.model_name || "variação"}`,
            status: model.status
              ? normalizeShopeeStatus(model.status)
              : baseStatus,
            itemId: item.item_id,
          });
        }
      } else {
        flatItems.push({
          externalId: item.item_id.toString(),
          sku:
            this.extractShopeeSku(item) /* item-level SKU */ ||
            snapshot?.item_sku ||
            null,
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

    // Mapa itemId → ShopeeItem completo, p/ enriquecer preço/estoque/imagem ao
    // criar produtos de variações sem produto (o FlatItem não carrega esses
    // campos). Mantém a identidade por VARIAÇÃO (externalId item_id:model_id).
    const itemDetailsMap = new Map<number, ShopeeItem>();
    for (const it of itemDetails) {
      itemDetailsMap.set(it.item_id, it);
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
    // Buscar listings existentes (EGRESS: só id/externalListingId/status/productId).
    const existingListings = await findManyInChunks(externalItemIds, (ids) =>
      prisma.productListing.findMany({
        where: {
          marketplaceAccountId: account.id,
          externalListingId: { in: ids },
        },
        select: {
          id: true,
          externalListingId: true,
          status: true,
          productId: true,
        },
      }),
    );
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
    const userProducts = await findManyInChunks(uniqueSkus, (skus) =>
      prisma.product.findMany({
        where: { userId: account.userId, skuNormalized: { in: skus } },
        // name alimenta a guarda de título do box-label via cache.
        select: { id: true, sku: true, skuNormalized: true, name: true },
      }),
    );
    const productsMap = new Map<
      string,
      { id: string; sku: string; skuNormalized: string | null; name: string }
    >();
    for (const p of userProducts) {
      const key = p.skuNormalized;
      if (key) productsMap.set(key, p);
    }

    // EGRESS/PERF: pré-carrega em UMA query os produtos casados que já têm
    // anúncio NESTA conta (guarda de box-label sem N+1 por variação).
    const matchedProductIds = userProducts.map((p) => p.id);
    const withListing = new Set<string>(
      (
        await findManyInChunks(matchedProductIds, (productIds) =>
          prisma.productListing.findMany({
            where: {
              marketplaceAccountId: account.id,
              productId: { in: productIds },
            },
            select: { productId: true },
            distinct: ["productId"],
          }),
        )
      ).map((l) => l.productId),
    );

    const itemsWithSku = flatItems.filter((i) => normalizeSku(i.sku)).length;
    const matchedSkus = flatItems.filter((i) => {
      const normalizedSku = normalizeSku(i.sku);
      return normalizedSku ? productsMap.has(normalizedSku) : false;
    }).length;
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

    // Cache write-through do núcleo (mesmo desenho do import ML).
    const importCache: AutodetectImportCache = {
      productsBySku: new Map(
        [...productsMap].map(([k, p]) => [k, { id: p.id, name: p.name }]),
      ),
      productIdsWithListing: withListing,
      knownExternalListingIds: new Set(
        existingListings.map((l) => l.externalListingId),
      ),
    };

    // 5. Processar cada item
    let processedCount = 0;
    for (const item of flatItems) {
      try {
        const sku = item.sku;
        const externalId = item.externalId;
        const existingListing = existingListingsMap.get(externalId);

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
          // Mesma regra única do núcleo idempotente (ver importMLItems): casa
          // por SKU e vincula ao produto existente — inclusive de outra
          // plataforma —, aplica a guarda de box-label e faz upsert do listing,
          // preservando a granularidade por VARIAÇÃO
          // (externalListingId = item_id:model_id). Preço/estoque/imagem vêm do
          // item completo quando disponível; o sync reconcilia depois.
          const full = itemDetailsMap.get(item.itemId);
          const normalized = full
            ? {
                ...ListingAutodetectUseCase.normalizeShopeeItem(
                  { id: account.id, userId: account.userId },
                  full,
                ),
                externalListingId: externalId,
                rawSku: sku ?? null,
                title: item.title,
                status: item.status,
              }
            : {
                platform: Platform.SHOPEE,
                account: { id: account.id, userId: account.userId },
                externalListingId: externalId,
                rawSku: sku ?? null,
                title: item.title,
                price: 0,
                stock: 0,
                status: item.status,
                permalink: null,
                imageUrl: null,
                createdAt: new Date(0),
              };
          const outcome =
            await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
              normalized,
              importCache,
            );
          this.tallyAutodetect(result, outcome.action);

          processedItem = {
            externalListingId: externalId,
            title: item.title,
            sku,
            linkedProductId: outcome.productId,
            status: outcome.productId ? "linked" : "unlinked",
          };
        }

        // `pushItemPreview` (e não `push` direto): `result.items` é PREVIEW e
        // vai inteiro para o JSONB do SyncLog, reescrito a cada flush de
        // progresso e relido pelo polling do front. Era o único dos três
        // importadores sem teto — ML e Magalu já capavam, e o próprio ramo de
        // erro logo abaixo já usava o helper.
        pushItemPreview(processedItem);

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
  ): Promise<{
    importId: string;
    status: ShopeeImportJobState;
    message: string;
  }> {
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
        status: this.getShopeeImportSyncStatus(
          payload.state,
          payload.errorCount,
        ),
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

        // Importa de TODAS as contas ACTIVE do dono (ou só `accountId` quando
        // informado). Sequencial, com falha isolada por conta e progresso
        // acumulado entre contas.
        const shopeeAccounts = accountId
          ? [account]
          : await MarketplaceRepository.findAllByUserIdAndPlatform(
              userId,
              Platform.SHOPEE,
            );
        const accountsToRun =
          shopeeAccounts.length > 0 ? shopeeAccounts : [account];

        const agg: ImportResult = {
          totalItems: 0,
          linkedItems: 0,
          unlinkedItems: 0,
          errorCount: 0,
          createdProducts: 0,
          alreadyLinked: 0,
          skippedDuplicates: 0,
          itemsPreviewTruncated: false,
          errorsPreviewTruncated: false,
          errors: [],
          items: [],
        };

        for (let i = 0; i < accountsToRun.length; i++) {
          const acc = accountsToRun[i];
          const label =
            accountsToRun.length > 1
              ? `Conta ${i + 1}/${accountsToRun.length}: `
              : "";
          try {
            const r = await this.importShopeeItems(userId, acc.id, {
              skipFinalLog: true,
              onProgress: async (progress) => {
                await flushProgress({
                  ...progress,
                  totalItems: agg.totalItems + (progress.totalItems ?? 0),
                  processedItems:
                    agg.linkedItems +
                    agg.unlinkedItems +
                    (progress.processedItems ?? 0),
                  linkedItems: agg.linkedItems + (progress.linkedItems ?? 0),
                  unlinkedItems:
                    agg.unlinkedItems + (progress.unlinkedItems ?? 0),
                  errorCount:
                    (agg.errorCount ?? 0) + (progress.errorCount ?? 0),
                  message: `${label}${progress.message ?? ""}`,
                });
              },
            });
            agg.totalItems += r.totalItems;
            agg.linkedItems += r.linkedItems;
            agg.unlinkedItems += r.unlinkedItems;
            agg.errorCount =
              (agg.errorCount ?? 0) + (r.errorCount ?? r.errors.length);
            agg.createdProducts =
              (agg.createdProducts ?? 0) + (r.createdProducts ?? 0);
            agg.alreadyLinked =
              (agg.alreadyLinked ?? 0) + (r.alreadyLinked ?? 0);
            agg.skippedDuplicates =
              (agg.skippedDuplicates ?? 0) + (r.skippedDuplicates ?? 0);
            for (const it of r.items) {
              if (agg.items.length < this.IMPORT_ITEMS_PREVIEW_LIMIT) {
                agg.items.push(it);
              } else {
                agg.itemsPreviewTruncated = true;
              }
            }
            for (const e of r.errors) {
              if (agg.errors.length < this.IMPORT_ERRORS_PREVIEW_LIMIT) {
                agg.errors.push(e);
              } else {
                agg.errorsPreviewTruncated = true;
              }
            }
          } catch (accErr) {
            const msg =
              accErr instanceof Error ? accErr.message : "Erro desconhecido";
            agg.errorCount = (agg.errorCount ?? 0) + 1;
            if (agg.errors.length < this.IMPORT_ERRORS_PREVIEW_LIMIT) {
              agg.errors.push(`Conta ${acc.id}: ${msg}`);
            } else {
              agg.errorsPreviewTruncated = true;
            }
          }
        }
        agg.accountsProcessed = accountsToRun.length;
        const result = agg;

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
    const lastUpdatedMs = payload.finishedAt
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

  private static readonly GENERIC_IMPORT_STALE_MS = 15 * 60 * 1000;

  /**
   * Orquestra a importação "criar+vincular" em TODAS as contas ACTIVE do dono
   * (ou só `accountId`), sequencialmente e com falha isolada por conta.
   * Reaproveita importMLItems/importMagaluItems (que já roteiam anúncios sem
   * produto pelo núcleo idempotente). NÃO aplica gate de baseline.
   */
  static async importAndBuildAllAccounts(
    userId: string,
    platform: Platform,
    accountId?: string,
    onProgress?: (p: {
      accountsTotal: number;
      accountsDone: number;
      processedItems: number;
      message?: string;
    }) => Promise<void> | void,
  ): Promise<ImportResult> {
    const accounts = accountId
      ? await (async () => {
          const a = await MarketplaceRepository.findByIdAndUser(
            accountId,
            userId,
          );
          return a ? [a] : [];
        })()
      : await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          platform,
        );

    const aggregate: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      errorCount: 0,
      createdProducts: 0,
      alreadyLinked: 0,
      skippedDuplicates: 0,
      accountsProcessed: 0,
      itemsPreviewTruncated: false,
      errorsPreviewTruncated: false,
      errors: [],
      items: [],
    };

    if (accounts.length === 0) {
      throw new Error(
        platform === Platform.MERCADO_LIVRE
          ? "Nenhuma conta do Mercado Livre conectada"
          : platform === Platform.MAGALU
            ? "Nenhuma conta da Magalu conectada"
            : "Nenhuma conta conectada",
      );
    }

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      try {
        const r =
          platform === Platform.MERCADO_LIVRE
            ? await this.importMLItems(userId, acc.id, { skipFinalLog: true })
            : await this.importMagaluItems(userId, acc.id, {
                skipFinalLog: true,
              });
        aggregate.totalItems += r.totalItems;
        aggregate.linkedItems += r.linkedItems;
        aggregate.unlinkedItems += r.unlinkedItems;
        aggregate.errorCount =
          (aggregate.errorCount ?? 0) + (r.errorCount ?? r.errors.length);
        aggregate.createdProducts =
          (aggregate.createdProducts ?? 0) + (r.createdProducts ?? 0);
        aggregate.alreadyLinked =
          (aggregate.alreadyLinked ?? 0) + (r.alreadyLinked ?? 0);
        aggregate.skippedDuplicates =
          (aggregate.skippedDuplicates ?? 0) + (r.skippedDuplicates ?? 0);
        for (const it of r.items) {
          if (aggregate.items.length < this.IMPORT_ITEMS_PREVIEW_LIMIT) {
            aggregate.items.push(it);
          } else {
            aggregate.itemsPreviewTruncated = true;
          }
        }
        for (const e of r.errors) {
          if (aggregate.errors.length < this.IMPORT_ERRORS_PREVIEW_LIMIT) {
            aggregate.errors.push(e);
          } else {
            aggregate.errorsPreviewTruncated = true;
          }
        }
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro desconhecido";
        aggregate.errorCount = (aggregate.errorCount ?? 0) + 1;
        if (aggregate.errors.length < this.IMPORT_ERRORS_PREVIEW_LIMIT) {
          aggregate.errors.push(`Conta ${acc.id}: ${msg}`);
        } else {
          aggregate.errorsPreviewTruncated = true;
        }
      }
      aggregate.accountsProcessed = (aggregate.accountsProcessed ?? 0) + 1;
      if (onProgress) {
        await onProgress({
          accountsTotal: accounts.length,
          accountsDone: i + 1,
          processedItems: aggregate.totalItems,
          message: `Conta ${i + 1}/${accounts.length} concluída`,
        });
      }
    }

    return aggregate;
  }

  /**
   * Job genérico (ML/Magalu): enfileira a importação multi-conta em background e
   * persiste estado/resultado num SyncLog. Espelha o modelo assíncrono da
   * Shopee (POST responde com importId; a aba faz polling do status).
   */
  static async startGenericImportJob(
    userId: string,
    platform: Platform,
    accountId?: string,
  ): Promise<{
    importId: string;
    status: GenericImportJobState;
    message: string;
  }> {
    const accounts = accountId
      ? await (async () => {
          const a = await MarketplaceRepository.findByIdAndUser(
            accountId,
            userId,
          );
          return a ? [a] : [];
        })()
      : await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          platform,
        );
    if (accounts.length === 0) {
      throw new Error(
        platform === Platform.MERCADO_LIVRE
          ? "Nenhuma conta do Mercado Livre conectada"
          : "Nenhuma conta da Magalu conectada",
      );
    }

    const startedAt = new Date().toISOString();
    const base: GenericImportJobPayload = {
      kind: "GENERIC_IMPORT",
      platform,
      state: "running",
      startedAt,
      accountsTotal: accounts.length,
      accountsDone: 0,
      processedItems: 0,
      message: "Importação enfileirada",
    };
    const created = await prisma.syncLog.create({
      data: {
        marketplaceAccountId: accounts[0].id,
        type: SyncType.PRODUCT_SYNC,
        status: SyncStatus.WARNING,
        message: base.message ?? "",
        payload: base as object,
      },
    });

    const label =
      platform === Platform.MERCADO_LIVRE ? "MercadoLivre" : "Magalu";

    setImmediate(async () => {
      const writePayload = async (
        payload: GenericImportJobPayload,
        status: SyncStatus,
      ) => {
        await prisma.syncLog.update({
          where: { id: created.id },
          data: {
            status,
            message: payload.message ?? "",
            payload: payload as object,
          },
        });
      };
      try {
        const result = await this.importAndBuildAllAccounts(
          userId,
          platform,
          accountId,
          async (p) => {
            await writePayload(
              {
                ...base,
                accountsDone: p.accountsDone,
                processedItems: p.processedItems,
                message: p.message,
              },
              SyncStatus.WARNING,
            );
          },
        );
        await writePayload(
          {
            ...base,
            state: "completed",
            accountsDone: result.accountsProcessed ?? base.accountsTotal,
            processedItems: result.totalItems,
            finishedAt: new Date().toISOString(),
            message: `Importação concluída: ${result.createdProducts ?? 0} criado(s), ${result.linkedItems} vinculado(s)`,
            result,
          },
          (result.errorCount ?? 0) > 0
            ? SyncStatus.WARNING
            : SyncStatus.SUCCESS,
        );
        await SystemLogService.logSyncComplete(userId, "IMPORT", label, {
          totalItems: result.totalItems,
          linkedItems: result.linkedItems,
          createdProducts: result.createdProducts ?? 0,
          errors: result.errorCount ?? result.errors.length,
          importId: created.id,
        });
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro desconhecido";
        await writePayload(
          {
            ...base,
            state: "failed",
            finishedAt: new Date().toISOString(),
            message: msg,
          },
          SyncStatus.FAILURE,
        );
        await SystemLogService.logSyncError(
          userId,
          "IMPORT",
          label,
          `${msg} (importId=${created.id})`,
        );
        console.error(
          `[GenericImportJob][${label}] importId=${created.id} failed:`,
          error instanceof Error ? error.stack : error,
        );
      }
    });

    return {
      importId: created.id,
      status: "running",
      message: base.message ?? "",
    };
  }

  static startMLImportJob(userId: string, accountId?: string) {
    return this.startGenericImportJob(
      userId,
      Platform.MERCADO_LIVRE,
      accountId,
    );
  }

  static startMagaluImportJob(userId: string, accountId?: string) {
    return this.startGenericImportJob(userId, Platform.MAGALU, accountId);
  }

  static async getGenericImportJobStatus(
    userId: string,
    importId: string,
  ): Promise<GenericImportJobStatus> {
    const syncLog = await prisma.syncLog.findFirst({
      where: { id: importId, marketplaceAccount: { userId } },
      // EGRESS: só o payload (estado do job) + createdAt (fallback do stale).
      select: { id: true, payload: true, createdAt: true },
    });
    if (!syncLog) {
      throw new Error("Importação não encontrada");
    }
    let payload = syncLog.payload as unknown as GenericImportJobPayload;
    if (!payload || payload.kind !== "GENERIC_IMPORT") {
      throw new Error("Importação não encontrada");
    }

    const lastMs = payload.finishedAt
      ? Date.parse(payload.finishedAt)
      : payload.startedAt
        ? Date.parse(payload.startedAt)
        : syncLog.createdAt.getTime();
    if (
      payload.state === "running" &&
      Date.now() - lastMs > this.GENERIC_IMPORT_STALE_MS
    ) {
      payload = {
        ...payload,
        state: "failed",
        finishedAt: new Date().toISOString(),
        message: "Importação expirada antes da conclusão. Inicie uma nova.",
      };
      await prisma.syncLog.update({
        where: { id: syncLog.id },
        data: {
          status: SyncStatus.FAILURE,
          message: payload.message ?? "",
          payload: payload as object,
        },
      });
    }

    return {
      importId: syncLog.id,
      status: payload.state,
      progress: {
        state: payload.state,
        accountsTotal: payload.accountsTotal,
        accountsDone: payload.accountsDone,
        processedItems: payload.processedItems,
        startedAt: payload.startedAt,
        finishedAt: payload.finishedAt,
        message: payload.message,
      },
      result:
        payload.state === "completed" || payload.state === "failed"
          ? payload.result
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
            const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
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
  private static async resolveShopeeAccount(
    userId: string,
    accountId?: string,
  ) {
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
          (attr.id &&
            typeof attr.id === "string" &&
            attr.id.toLowerCase().includes("sku")),
      );
      if (skuAttr?.value_name) {
        return skuAttr.value_name;
      }
    }

    // Por fim, tentar extrair SKU das variações (seller_custom_field ou atributos)
    if (
      Array.isArray((item as any).variations) &&
      (item as any).variations.length > 0
    ) {
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
              (attr.id &&
                typeof attr.id === "string" &&
                attr.id.toLowerCase().includes("sku")),
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

  private static getShopeeAvailableStock(
    item: Partial<ShopeeItem> & any,
  ): number {
    const summaryStock =
      item?.stock_info_v2?.summary_info?.total_available_stock;
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
   * Wrappers públicos aditivos: reaproveitam a extração de SKU/estoque na
   * auto-detecção de anúncios (ListingAutodetectUseCase) sem expor mutações.
   * Delegam 1:1 aos privados acima — `importMLItems`/`importShopeeItems` ficam
   * intactos.
   */
  static extractMLItemSku(item: MLItemDetails): string | null {
    return this.extractSku(item);
  }

  static extractShopeeItemSku(
    item: Partial<ShopeeItem>,
    model?: { model_sku?: string | null },
  ): string | null {
    return this.extractShopeeSku(item, model);
  }

  static getShopeeItemAvailableStock(item: Partial<ShopeeItem> & any): number {
    return this.getShopeeAvailableStock(item);
  }

  /**
   * Polling incremental de anúncios NOVOS da Shopee (auto-detecção).
   *
   * A Shopee não entrega push confiável de "item criado", então varremos a loja
   * por `update_time_from` (watermark) e, para cada item com `create_time >=
   * autoImportListingsSince`, criamos na Dexo o Product vinculado via núcleo
   * idempotente. Itens antigos apenas editados (create_time < baseline) são
   * ignorados — sem backfill. Reexecução não duplica (listing_exists/upsert).
   *
   * Fail-safe: sem baseline ou sem shopId, não importa nada. Erros por item são
   * contabilizados e nunca abortam o lote. Acoplado ao loop de sync de pedidos.
   */
  static async importNewShopeeItemsForAccount(account: {
    id: string;
    userId: string;
    shopId: number | null;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    autoImportListingsSince: Date | null;
    shopeeListingsSyncedThrough: Date | null;
  }): Promise<{
    created: number;
    linked: number;
    skipped: number;
    errors: number;
  }> {
    const summary = { created: 0, linked: 0, skipped: 0, errors: 0 };

    // Fail-safe: nunca importa sem baseline ou sem shopId.
    if (!account.autoImportListingsSince || !account.shopId) {
      return summary;
    }
    const shopId = account.shopId;

    const baselineMs = account.autoImportListingsSince.getTime();
    const since =
      account.shopeeListingsSyncedThrough ?? account.autoImportListingsSince;
    const updateTimeFrom = Math.floor(since.getTime() / 1000);
    let maxUpdateTime = updateTimeFrom;

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
          shopId,
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

    // 1. Coletar ids de itens atualizados desde o watermark (server-side filter).
    const itemIds: number[] = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
      try {
        const list = await ShopeeApiService.getItemList(accessToken, shopId, {
          offset,
          page_size: pageSize,
          item_status: ["NORMAL"],
          update_time_from: updateTimeFrom,
          response_optional_fields: ["item_sku"],
        });
        const items = list?.item || [];
        for (const it of items) {
          itemIds.push(it.item_id);
          if (
            typeof it.update_time === "number" &&
            it.update_time > maxUpdateTime
          ) {
            maxUpdateTime = it.update_time;
          }
        }
        if (!list?.has_next_page) break;
        offset = list.next_offset || offset + pageSize;
      } catch (error: any) {
        const refreshed = await refreshIfNeeded(error);
        if (refreshed) continue;
        throw error;
      }
    }

    console.log(
      `[autodetect][shopee] conta ${account.id}: ${itemIds.length} item(ns) na lista (update_time_from=${new Date(updateTimeFrom * 1000).toISOString()})`,
    );

    if (itemIds.length === 0) {
      return summary;
    }

    // 2. Detalhes em lote + auto-detecção por item (gate de "só novos").
    let skipSamplesLogged = 0;
    const batchSize = this.SHOPEE_IMPORT_BATCH_SIZE;
    for (let i = 0; i < itemIds.length; i += batchSize) {
      const slice = itemIds.slice(i, i + batchSize);

      let details: ShopeeItem[];
      try {
        details = await ShopeeApiService.getItemsBaseInfo(
          accessToken,
          shopId,
          slice,
        );
      } catch (error: any) {
        const refreshed = await refreshIfNeeded(error);
        if (!refreshed) {
          summary.errors += slice.length;
          continue;
        }
        try {
          details = await ShopeeApiService.getItemsBaseInfo(
            accessToken,
            shopId,
            slice,
          );
        } catch {
          summary.errors += slice.length;
          continue;
        }
      }

      for (const item of details) {
        try {
          if (
            typeof item.update_time === "number" &&
            item.update_time > maxUpdateTime
          ) {
            maxUpdateTime = item.update_time;
          }

          // Gate "só novos": create_time < baseline = anúncio antigo (só editado).
          const createMs = (item.create_time ?? 0) * 1000;
          if (!Number.isFinite(createMs) || createMs < baselineMs) {
            if (skipSamplesLogged < 3) {
              console.log(
                `[autodetect][shopee] conta ${account.id}: item ${item.item_id} ignorado (create_time=${item.create_time}, baseline=${Math.floor(baselineMs / 1000)})`,
              );
              skipSamplesLogged++;
            }
            summary.skipped++;
            continue;
          }

          const normalized = ListingAutodetectUseCase.normalizeShopeeItem(
            { id: account.id, userId: account.userId },
            item,
          );
          const res =
            await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
              normalized,
            );
          if (res.action === "created_product") {
            summary.created++;
          } else if (
            res.action === "linked_existing_product" ||
            res.action === "raced"
          ) {
            summary.linked++;
          }
          // res.action === "listing_exists" → no-op idempotente.
        } catch (err) {
          summary.errors++;
          console.error(
            `[AUTODETECT][Shopee] Falha no item ${item.item_id} (conta ${account.id}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // 3. Avançar o watermark (monotônico) p/ o próximo polling ser incremental.
    try {
      await MarketplaceRepository.advanceShopeeListingsWatermark(
        account.id,
        new Date(maxUpdateTime * 1000),
      );
    } catch (err) {
      console.error(
        `[AUTODETECT][Shopee] Falha ao avançar watermark da conta ${account.id}:`,
        err instanceof Error ? err.message : err,
      );
    }

    return summary;
  }

  /**
   * Polling incremental de anúncios NOVOS da Magalu (auto-detecção).
   *
   * Varre o portfólio (listSkus) e, para cada SKU com `created_at >=
   * autoImportListingsSince`, cria na Dexo o Product vinculado via núcleo
   * idempotente. SKUs antigos (created_at < baseline) são ignorados — sem
   * backfill. Reexecução não duplica: anúncios criados pelo Dexo já têm o SKU
   * como externalListingId (listing_exists no núcleo) e o upsert é à prova de
   * corrida. Sem baseline ⇒ não importa nada. Erros por item nunca abortam o
   * lote. NOTA: listSkus traz só a 1ª página por enquanto (TODO paginação),
   * mesma limitação do importMagaluItems.
   */
  static async importNewMagaluItemsForAccount(account: {
    id: string;
    userId: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    autoImportListingsSince: Date | null;
  }): Promise<{
    created: number;
    linked: number;
    skipped: number;
    errors: number;
  }> {
    const summary = { created: 0, linked: 0, skipped: 0, errors: 0 };

    // Fail-safe: nunca importa sem baseline.
    if (!account.autoImportListingsSince) return summary;
    const baselineMs = account.autoImportListingsSince.getTime();

    // Token fresco (refresh + persist se expirado). Falha de refresh ⇒ aborta.
    let accessToken = account.accessToken;
    if (
      account.expiresAt &&
      new Date(account.expiresAt) <= new Date() &&
      account.refreshToken
    ) {
      try {
        const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
          account.id,
          account.refreshToken,
        );
        await MarketplaceRepository.updateTokens(account.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        });
        accessToken = refreshed.accessToken;
      } catch (err) {
        console.error(
          `[autodetect][magalu] refresh de token falhou (conta ${account.id}):`,
          err instanceof Error ? err.message : err,
        );
        return summary;
      }
    }

    let skus: MagaluSku[];
    try {
      skus = await MagaluApiService.listSkus(accessToken, { limit: 100 });
    } catch (err) {
      console.error(
        `[autodetect][magalu] listSkus falhou (conta ${account.id}):`,
        err instanceof Error ? err.message : err,
      );
      return summary;
    }
    if (skus.length === 0) return summary;

    // Idempotência robusta POR SKU: a identidade da Magalu É o SKU. Pré-carrega
    // os externalSku que já têm vínculo nesta conta para NUNCA duplicar um
    // anúncio que o Dexo criou (externalListingId=sku) nem um placeholder legado
    // (PENDING_<sku>), independentemente de a Magalu devolver um id interno
    // diferente do SKU. O núcleo já é idempotente por externalListingId; este
    // filtro cobre o caso em que a chave gravada difere do SKU (legado/divergência).
    const rawSkusForCheck = skus
      .map(
        (s) =>
          (s.seller_sku as string) ||
          (s.sku as string) ||
          (s.code as string) ||
          null,
      )
      .filter((x): x is string => Boolean(x));
    const linkedSkus = new Set<string>(
      (
        await findManyInChunks(rawSkusForCheck, (skusChunk) =>
          prisma.productListing.findMany({
            where: {
              marketplaceAccountId: account.id,
              externalSku: { in: skusChunk },
            },
            select: { externalSku: true },
          }),
        )
      )
        .map((l) => l.externalSku)
        .filter((x): x is string => Boolean(x)),
    );

    let skipSamplesLogged = 0;
    for (const sku of skus) {
      try {
        const normalized = ListingAutodetectUseCase.normalizeMagaluItem(
          { id: account.id, userId: account.userId },
          sku,
        );

        // Já vinculado (Dexo, detecção anterior ou placeholder legado) → no-op
        // idempotente, sem chamar o núcleo (evita duplicar por chave divergente).
        if (normalized.rawSku && linkedSkus.has(normalized.rawSku)) {
          continue;
        }

        // Gate "só novos": created_at < baseline = SKU antigo (só editado) →
        // ignora, sem backfill. SKU sem id externo também é pulado.
        const createdMs = normalized.createdAt.getTime();
        if (
          !normalized.externalListingId ||
          !Number.isFinite(createdMs) ||
          createdMs < baselineMs
        ) {
          if (skipSamplesLogged < 3) {
            console.log(
              `[autodetect][magalu] conta ${account.id}: sku ${normalized.externalListingId || "(sem id)"} ignorado (created_at=${normalized.createdAt.toISOString()}, baseline=${account.autoImportListingsSince.toISOString()})`,
            );
            skipSamplesLogged++;
          }
          summary.skipped++;
          continue;
        }

        const res =
          await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
            normalized,
          );
        if (res.action === "created_product") {
          summary.created++;
        } else if (
          res.action === "linked_existing_product" ||
          res.action === "raced"
        ) {
          summary.linked++;
        }
        // res.action === "listing_exists" → no-op idempotente.
      } catch (err) {
        summary.errors++;
        console.error(
          `[AUTODETECT][Magalu] Falha no sku ${sku.sku ?? sku.id} (conta ${account.id}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return summary;
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
          case Platform.MAGALU:
            result = await this.syncMagaluProductStock(listing, product);
            break;
          case Platform.OLX:
            result = await this.syncOlxProductStock(listing, product);
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

  /**
   * Espelha o status remoto no ProductListing local (best-effort, aditivo).
   * Muta listing.status em memória após gravar, para chamadas subsequentes
   * na mesma execução compararem contra o valor novo.
   * Kill-switch: LISTING_STATUS_SYNC_DISABLED=1. Nunca lança.
   */
  private static async mirrorListingStatusBestEffort(
    listing: any,
    platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU",
    rawRemoteStatus: string | null | undefined,
  ): Promise<void> {
    if (process.env.LISTING_STATUS_SYNC_DISABLED === "1") return;
    if (!listing?.id) return;
    try {
      const normalized = normalizeListingStatus(platform, rawRemoteStatus);
      if (!normalized || normalized === listing.status) return;
      // EGRESS: variante lean — devolve 3 colunas, não a linha inteira.
      await ListingRepository.updateStatusLean(listing.id, normalized);
      listing.status = normalized;
    } catch (err) {
      console.warn(
        `[SyncUseCase] Espelho de status falhou p/ listing ${listing.id} (sync segue):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private static async logMLStockWarningAndReturn(
    accountId: string,
    listing: any,
    product: any,
    currentItem: MLItemDetails,
    message: string,
    skipReason: string,
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
        skipReason,
      },
    );

    return {
      success: true,
      productId: product.id,
      externalListingId: listing.externalListingId,
      previousStock,
      newStock: previousStock,
      skipped: true,
      skipReason,
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

      // Espelho marketplace→Dexo: reflete o status remoto ANTES dos gates,
      // para closed/paused/under_review aparecerem na Dexo mesmo quando o
      // sync de estoque é ignorado logo abaixo.
      await this.mirrorListingStatusBestEffort(
        listing,
        "MERCADO_LIVRE",
        currentStatus,
      );

      if (currentStatus === "closed") {
        return this.logMLStockWarningAndReturn(
          account.id,
          listing,
          product,
          currentItem,
          `Anúncio ${listing.externalListingId} está fechado no Mercado Livre; sincronização de estoque ignorada.`,
          "ml_status_closed",
        );
      }

      if (product.stock <= 0) {
        if (currentStatus === "paused" && previousStock > 0) {
          await this.alertMLReactivationRisk(
            account,
            listing,
            product,
            previousStock,
          );
          return this.logMLStockWarningAndReturn(
            account.id,
            listing,
            product,
            currentItem,
            `Anúncio ${listing.externalListingId} paused com quantidade remota=${previousStock} e estoque local=0. RISCO DE OVERSELL se reativar manualmente no ML — zere a quantidade no painel do ML antes de reativar.`,
            "ml_paused_with_remote_qty",
          );
        }

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
            `ml_status_${currentStatus}`,
          );
        }

        if (currentStatus === "active") {
          await MLApiService.updateItem(
            account.accessToken,
            listing.externalListingId,
            {
              status: "paused",
            },
          );

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

          // O remoto acabou de virar paused pela lógica pré-existente acima;
          // espelha o valor NOVO (o mirror do topo gravou o pré-pausa).
          await this.mirrorListingStatusBestEffort(
            listing,
            "MERCADO_LIVRE",
            "paused",
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
   * Resolve o channel.id do seller Magalu (obrigatório em estoque/preço),
   * via GET /seller/v1/portfolios/me. O seller tem 1 canal.
   */
  private static async resolveMagaluChannelId(
    accessToken: string,
  ): Promise<string> {
    const channels = await MagaluApiService.getChannels(accessToken);
    const id = channels[0]?.id;
    if (!id) {
      throw new Error(
        "Seller Magalu sem canal de venda (channel) — não é possível sincronizar.",
      );
    }
    return id;
  }

  /**
   * Sincroniza estoque de um produto para a Magalu.
   * Atualiza a quantidade do SKU no portfólio (serviço de estoque da Magalu).
   */
  private static async syncMagaluProductStock(
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

    if (
      listing.externalListingId &&
      String(listing.externalListingId).startsWith("PENDING_")
    ) {
      try {
        await this.logSync(
          account.id,
          SyncType.STOCK_UPDATE,
          SyncStatus.WARNING,
          `Anúncio local (placeholder) — não existe na Magalu: ${listing.externalListingId}`,
          {
            productId: product.id,
            externalListingId: listing.externalListingId,
          },
        );
      } catch {
        /* ignore logging failures */
      }
      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error:
          "Anúncio local (placeholder) — não existe na Magalu. Sincronização ignorada.",
      };
    }

    // A Magalu identifica o item de estoque pelo SKU do seller.
    const sku = listing.externalSku || product.sku;
    if (!sku) {
      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error: "Listing sem SKU para sincronizar estoque na Magalu",
      };
    }

    try {
      const channelId = await this.resolveMagaluChannelId(account.accessToken);
      await MagaluApiService.setStock(
        account.accessToken,
        sku,
        product.stock,
        channelId,
      );

      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.SUCCESS,
        `Estoque do produto ${product.name} atualizado na Magalu para ${product.stock}`,
        {
          productId: product.id,
          externalListingId: listing.externalListingId,
          newStock: product.stock,
        },
      );

      return {
        success: true,
        productId: product.id,
        externalListingId: listing.externalListingId,
        newStock: product.stock,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Erro desconhecido";
      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.FAILURE,
        `Erro ao atualizar estoque na Magalu: ${errorMessage}`,
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
   * Sincroniza estoque para a OLX — path DURÁVEL (stockSyncJob → syncProductStock).
   *
   * A OLX não tem API de estoque per-SKU: a baixa é UNIDIRECIONAL ERP→OLX e
   * mapeia para publicar/despublicar o anúncio:
   *   - targetStock === 0 → deleteAd (despublica).
   *   - targetStock  >  0 → upsertAd insert (re-publica; re-entra na fila da OLX).
   * Idempotente: delete repetido = no-op; insert com o mesmo id = edição.
   *
   * ⚠️ Este `case OLX` é OBRIGATÓRIO: sem ele o switch cai no `default` e todo
   * stockSyncJob de listing OLX falha em loop (o job é enfileirado p/ TODA
   * listing, sem filtro de plataforma). Sem refresh de token (OLX não tem).
   */
  private static async syncOlxProductStock(
    listing: any,
    product: any,
  ): Promise<SyncResult> {
    const account = listing.marketplaceAccount;

    if (!account.accessToken) {
      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error: "Conta OLX sem token de acesso",
      };
    }

    const olxId = listing.externalListingId;
    if (!olxId || String(olxId).startsWith("PENDING_")) {
      return {
        success: false,
        productId: product.id,
        externalListingId: listing.externalListingId,
        error:
          "Anúncio local (placeholder) — não existe na OLX. Sincronização ignorada.",
      };
    }

    const targetStock = Number(product.stock) || 0;

    try {
      if (targetStock <= 0) {
        // Zerou → despublica.
        const resp = await OlxApiService.deleteAd(account.accessToken, olxId);
        if (resp.statusCode !== 0) {
          throw this.olxRespError(resp);
        }
        await ListingRepository.updateStatus(listing.id, "paused");
      } else {
        // Estoque > 0 → (re)publica com o MESMO id (edição/insert).
        const category =
          OlxCategoryResolutionService.resolveCategoryId(product);
        const phone = OLX_CONSTANTS.SELLER_PHONE;
        const zipcode = OLX_CONSTANTS.SELLER_ZIPCODE;
        if (category == null || !phone || !zipcode) {
          throw new Error(
            "Publicação OLX requer categoria resolvida + OLX_SELLER_PHONE/ZIPCODE.",
          );
        }
        const ad = OlxPayloadBuilderService.build(product, {
          categoryId: category,
          phone,
          zipcode,
          params: OlxCategoryResolutionService.buildAdParams(product, category),
        });
        ad.id = olxId; // preserva o id do anúncio (idempotência da edição)
        const resp = await OlxApiService.submitImport(account.accessToken, [
          ad,
        ]);
        if (resp.statusCode !== 0) {
          throw this.olxRespError(resp);
        }
        await ListingRepository.updateStatus(listing.id, "active");
      }

      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.SUCCESS,
        `Estoque do produto ${product.name} sincronizado na OLX (${targetStock <= 0 ? "despublicado" : "publicado"})`,
        {
          productId: product.id,
          externalListingId: listing.externalListingId,
          newStock: targetStock,
        },
      );

      return {
        success: true,
        productId: product.id,
        externalListingId: listing.externalListingId,
        newStock: targetStock,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Erro desconhecido";
      await this.logSync(
        account.id,
        SyncType.STOCK_UPDATE,
        SyncStatus.FAILURE,
        `Erro ao sincronizar estoque na OLX: ${errorMessage}`,
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

  /** Transforma uma resposta de import OLX com statusCode≠0 num Error tipado. */
  private static olxRespError(resp: {
    statusCode: number;
    statusMessage?: string;
    errors?: string[];
  }): Error {
    const detail =
      resp.statusMessage ||
      (resp.errors && resp.errors.join("; ")) ||
      `statusCode ${resp.statusCode}`;
    const err = new Error(`OLX recusou o import: ${detail}`);
    (err as any).olxStatusCode = resp.statusCode;
    return err;
  }

  /**
   * Sincroniza dados completos (estoque + preço) para a Magalu.
   */
  /**
   * Sincroniza dados completos (título/descrição/preço/estoque) para a OLX.
   * Na OLX editar = re-insert com o MESMO id (edição). Estoque 0 → delete.
   * Reflete mudanças do produto reenviando o anúncio inteiro.
   */
  private static async syncOlxProductData(
    product: any,
    externalListingId: string,
    account: any,
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      productId: product.id,
      externalListingId,
    };

    if (!externalListingId || externalListingId.startsWith("PENDING_")) {
      result.error = "Anúncio OLX ainda não publicado (placeholder).";
      return result;
    }

    try {
      const targetStock = Number(product.stock) || 0;
      if (targetStock <= 0) {
        const resp = await OlxApiService.deleteAd(
          account.accessToken,
          externalListingId,
        );
        if (resp.statusCode !== 0) throw this.olxRespError(resp);
      } else {
        const category =
          OlxCategoryResolutionService.resolveCategoryId(product);
        const phone = OLX_CONSTANTS.SELLER_PHONE;
        const zipcode = OLX_CONSTANTS.SELLER_ZIPCODE;
        if (category == null || !phone || !zipcode) {
          throw new Error(
            "Sincronização OLX requer categoria resolvida + OLX_SELLER_PHONE/ZIPCODE.",
          );
        }
        const ad = OlxPayloadBuilderService.build(product, {
          categoryId: category,
          phone,
          zipcode,
          params: OlxCategoryResolutionService.buildAdParams(product, category),
        });
        ad.id = externalListingId;
        const resp = await OlxApiService.submitImport(account.accessToken, [
          ad,
        ]);
        if (resp.statusCode !== 0) throw this.olxRespError(resp);
      }
      result.success = true;
      result.newStock = targetStock;
      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  private static async syncMagaluProductData(
    product: any,
    externalListingId: string,
    account: any,
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      productId: product.id,
      externalListingId,
    };

    // A Magalu é keyed por SKU (não pelo externalListingId): a publicação é um
    // POST 202 assíncrono e o vínculo local fica PENDING_<sku>. Por isso NÃO há
    // guarda de PENDING aqui — o SKU do produto já é a chave real de
    // patchSku/setStock/setPrice. Sem SKU não há o que sincronizar.
    const sku = product.sku;
    if (!sku) {
      result.error = "Produto sem SKU para sincronizar na Magalu";
      return result;
    }

    // Cada operação (título/descrição, estoque, preço) é ISOLADA: uma falha de
    // estoque NÃO pode impedir a atualização de preço (e vice-versa) — antes
    // tudo dividia o mesmo try e um erro de estoque pulava o preço. Os erros são
    // coletados com o detalhe da API da Magalu (status + corpo) p/ diagnóstico.
    const errors: string[] = [];
    const detail = (e: unknown): string => {
      const err = e as {
        message?: string;
        status?: number;
        responseData?: unknown;
      };
      const base = err?.message ?? String(e);
      const extra = [
        err?.status != null ? `status=${err.status}` : null,
        err?.responseData != null
          ? `resp=${JSON.stringify(err.responseData).slice(0, 300)}`
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      return extra ? `${base} (${extra})` : base;
    };

    // Título/descrição (PATCH parcial no SKU; não depende de canal) — paridade
    // com ML/Shopee, que propagam nome/descrição na edição. Só envia o que existe.
    const patch: Record<string, unknown> = {};
    if (typeof product.name === "string" && product.name.trim()) {
      patch.title = product.name.trim().slice(0, 150);
    }
    if (typeof product.description === "string" && product.description.trim()) {
      patch.description = product.description.trim();
    }
    if (Object.keys(patch).length > 0) {
      try {
        await MagaluApiService.patchSku(account.accessToken, sku, patch);
      } catch (e) {
        errors.push(`título/descrição: ${detail(e)}`);
      }
    }

    // Estoque e preço dependem do canal — resolve uma vez. Se o canal falhar,
    // ambos são pulados (nada a fazer sem canal), mas o título/descrição acima
    // já foi tentado.
    let channelId: string | null = null;
    try {
      channelId = await this.resolveMagaluChannelId(account.accessToken);
    } catch (e) {
      errors.push(`canal: ${detail(e)}`);
    }

    if (channelId) {
      try {
        await MagaluApiService.setStock(
          account.accessToken,
          sku,
          product.stock,
          channelId,
        );
        result.newStock = product.stock;
      } catch (e) {
        errors.push(`estoque: ${detail(e)}`);
      }

      const price = product.price != null ? Number(product.price) : null;
      if (price != null && Number.isFinite(price)) {
        try {
          await MagaluApiService.setPrice(
            account.accessToken,
            sku,
            price,
            channelId,
          );
        } catch (e) {
          errors.push(`preço: ${detail(e)}`);
        }
      }
    }

    if (errors.length === 0) {
      await this.logSync(
        account.id,
        SyncType.PRODUCT_SYNC,
        SyncStatus.SUCCESS,
        `Dados do produto ${product.name} sincronizados na Magalu (título/descrição/estoque/preço)`,
        { productId: product.id, externalListingId, newStock: product.stock },
      );
      result.success = true;
    } else {
      result.error = errors.join(" | ");
      console.warn(
        `[SYNC] Magalu sync parcial/falho (sku=${sku}, listing=${externalListingId}): ${result.error}`,
      );
      await this.logSync(
        account.id,
        SyncType.PRODUCT_SYNC,
        SyncStatus.FAILURE,
        `Erro ao sincronizar dados na Magalu: ${result.error}`,
        { productId: product.id, externalListingId, errors },
      );
    }

    return result;
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
    const parseModelId = (externalId: string): number | undefined => {
      const parts = externalId.split(":");
      if (parts.length < 2) return undefined;
      const parsed = parseInt(parts[1], 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };
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
      const itemId = parseItemId(listing.externalListingId);
      const listingModelId = parseModelId(listing.externalListingId);
      const currentItem = await ShopeeApiService.getItemBaseInfo(
        accessToken,
        account.shopId,
        itemId,
      );

      const previousStock = this.getShopeeAvailableStock(currentItem);

      // Espelho marketplace→Dexo: reflete o status do ITEM antes de qualquer
      // gate (UNLIST/BANNED aparecem na Dexo mesmo se o sync falhar abaixo).
      // A API real devolve item_status; o tipo declara status (defesa dupla,
      // mesma convenção do autodetect).
      await this.mirrorListingStatusBestEffort(
        listing,
        "SHOPEE",
        (currentItem as any)?.item_status ?? currentItem?.status,
      );

      // Se o item tem variações mas o listing não referencia um model_id,
      // update_stock a nível de item é ignorado pela Shopee.
      if (currentItem.has_model && !listingModelId) {
        throw new Error(
          `Listing ${listing.externalListingId} aponta para item ${itemId} com variações (has_model=true) mas não inclui model_id no externalListingId — sync de estoque não aplicável sem o modelo.`,
        );
      }

      // Atualizar estoque no Shopee (endpoint update_stock, não update_item)
      await ShopeeApiService.updateItemStock(
        accessToken,
        account.shopId,
        itemId,
        product.stock,
        listingModelId,
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
        // EGRESS (2 ofensores do pg_stat_statements no MESMO call-site):
        // - Relação: `product: true` fazia o Prisma resolver com UM batch-load
        //   `Product WHERE id IN (<TODOS os productIds da conta>)` trazendo
        //   TODAS as colunas — incluindo o JSONB pesado `mlCatalogSnapshot`,
        //   `attributes` e `imageUrls` (IN de dezenas de milhares de ids ×
        //   colunas gordas, com detoast por linha).
        // - Query-mãe: sem `select`, puxava as ~46 colunas do ProductListing
        //   (20 delas *Override de texto) de TODOS os anúncios da conta
        //   (7.459 calls @285ms).
        // A árvore de sync de estoque (syncMLProductStock, syncShopeeProductStock,
        // logMLStockWarningAndReturn, alertMLReactivationRisk) lê APENAS
        // listing.id e listing.externalListingId + product.{id,sku,stock,name}
        // + marketplaceAccount.* — MESMAS linhas, sem trafegar o resto.
        select: {
          id: true,
          externalListingId: true,
          product: { select: { id: true, sku: true, stock: true, name: true } },
          marketplaceAccount: true,
        },
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
                case Platform.MAGALU:
                  return this.syncMagaluProductStock(listing, listing.product);
                case Platform.OLX:
                  return this.syncOlxProductStock(listing, listing.product);
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

      // 2.1 Buscar listing especifico desta conta para aplicar overrides
      // antes de enviar para o marketplace. Quando o anuncio tem campos
      // personalizados (titleOverride, priceOverride, etc.), precisamos
      // RESPEITAR esses overrides no re-sync — caso contrario, editar o
      // produto sobrescreveria a personalizacao do anuncio.
      const [listingForOverrides, productCompatibilities] = await Promise.all([
        prisma.productListing.findUnique({
          where: {
            marketplaceAccountId_externalListingId: {
              marketplaceAccountId,
              externalListingId,
            },
          },
        }),
        // Compatibilidades veiculares: usadas para enriquecer a descrição
        // do anúncio. Falha silenciosa — não bloqueia sync se a tabela
        // estiver vazia.
        (prisma as any).productCompatibility
          .findMany({
            where: { productId },
            orderBy: { createdAt: "asc" },
          })
          .catch(() => [] as unknown[]),
      ]);
      const { applyOverridesToProduct } =
        await import("../services/listing-overrides.service");
      const effectiveProduct = applyOverridesToProduct(
        product,
        listingForOverrides,
      ) as Record<string, unknown> & {
        compatibilities?: Array<{
          brand: string;
          model: string;
          yearFrom?: number | null;
          yearTo?: number | null;
          version?: string | null;
        }>;
      };
      effectiveProduct.compatibilities = Array.isArray(productCompatibilities)
        ? (productCompatibilities as Array<{
            brand: string;
            model: string;
            yearFrom?: number | null;
            yearTo?: number | null;
            version?: string | null;
          }>)
        : [];

      // 3. Roteamento baseado na plataforma
      switch (account.platform) {
        case Platform.MERCADO_LIVRE:
          return await this.syncMLProductData(
            effectiveProduct,
            externalListingId,
            account,
          );
        case Platform.SHOPEE:
          return await this.syncShopeeProductData(
            effectiveProduct,
            externalListingId,
            account,
          );
        case Platform.MAGALU:
          return await this.syncMagaluProductData(
            effectiveProduct,
            externalListingId,
            account,
          );
        case Platform.OLX:
          return await this.syncOlxProductData(
            effectiveProduct,
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

      // Detecta fluxo "User Product" (UP) — itens com family_name têm título
      // derivado e NÃO aceitam PUT /items/{id} alterando `title` (ML responde
      // BODY_INVALID_FIELDS) nem `description` (item.description.not_modifiable).
      // Para esses, o título é atualizado via PUT /items/{id} com `family_name`
      // (NÃO `title`) — mesmo caminho usado em ListingUseCase pós-criação. A
      // descrição vai via POST /items/{id}/description.
      const userProductIdFromMl = (
        (currentItem as { user_product_id?: string | null }).user_product_id ||
        ""
      ).trim();
      const familyNameFromMl = (
        (currentItem as { family_name?: string | null }).family_name || ""
      ).trim();
      const isUserProductItem = !!(userProductIdFromMl || familyNameFromMl);

      // Atualizações UP-específicas pendentes (executadas após o PUT /items).
      let pendingFamilyNameUpdate: string | null = null;
      let pendingUpDescriptionUpdate: string | null = null;

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
        // Sincronizar nome se foi alterado. Em items UP, o título é derivado
        // do family_name — usamos PUT /user-products/{up_id} em vez de incluir
        // `title` no PUT /items (que o ML rejeita com BODY_INVALID_FIELDS).
        if (product.name && product.name !== currentItem.title) {
          if (isUserProductItem) {
            pendingFamilyNameUpdate = product.name;
          } else {
            updateData.title = product.name;
          }
        }

        // Descrição enriquecida com bloco de compatibilidade veicular.
        // Em items UP, `description` no PUT /items retorna
        // item.description.not_modifiable — usamos POST /items/{id}/description
        // (endpoint dedicado já usado durante a criação do listing).
        const enrichedDescription = SyncUseCase.appendCompatibilityBlock(
          product.description,
          (product as { compatibilities?: unknown }).compatibilities as Array<{
            brand: string;
            model: string;
            yearFrom?: number | null;
            yearTo?: number | null;
            version?: string | null;
          }>,
        );
        if (enrichedDescription) {
          if (isUserProductItem) {
            pendingUpDescriptionUpdate = enrichedDescription;
          } else {
            updateData.description = enrichedDescription;
          }
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

      // Sincronizar ficha técnica secundária — só os atributos que não são
      // imutáveis no ML após criação. BRAND/MODEL/YEAR/PART_NUMBER/MPN/OEM
      // costumam ser fixados no momento da criação; tentar atualizá-los
      // gera body.invalid_attribute. Enviamos apenas o resto.
      const extras = (product as any).attributes;
      // currentItem.status === "closed" já saiu via early return acima.
      if (extras && typeof extras === "object" && !Array.isArray(extras)) {
        const IMMUTABLE_ATTRS = new Set([
          "BRAND",
          "MODEL",
          "YEAR",
          "VEHICLE_YEAR",
          "PART_NUMBER",
          "MPN",
          "OEM",
          "SELLER_SKU",
        ]);
        const list: Array<{
          id: string;
          value_id?: string;
          value_name?: string;
        }> = [];
        for (const [id, raw] of Object.entries(
          extras as Record<string, unknown>,
        )) {
          if (!id || IMMUTABLE_ATTRS.has(id)) continue;
          if (!raw || typeof raw !== "object") continue;
          const v = raw as { value_id?: string; value_name?: string };
          const valueId =
            typeof v.value_id === "string" && v.value_id.trim().length > 0
              ? v.value_id.trim()
              : undefined;
          const valueName =
            typeof v.value_name === "string" && v.value_name.trim().length > 0
              ? v.value_name.trim()
              : undefined;
          if (!valueId && !valueName) continue;
          const entry: { id: string; value_id?: string; value_name?: string } =
            { id };
          if (valueId) entry.value_id = valueId;
          if (valueName) entry.value_name = valueName;
          list.push(entry);
        }
        if (list.length > 0) {
          updateData.attributes = list;
        }
      }

      console.log(`[SYNC] Dados a serem enviados para ML:`, updateData);
      if (pendingFamilyNameUpdate || pendingUpDescriptionUpdate) {
        console.log(
          `[SYNC] Item UP detectado (user_product_id=${userProductIdFromMl || "?"}) — title/description serão atualizados via endpoints dedicados:`,
          {
            family_name: pendingFamilyNameUpdate ? "queued" : "skip",
            description: pendingUpDescriptionUpdate ? "queued" : "skip",
          },
        );
      }

      // SÃ³ fazer a atualizaÃ§Ã£o se houver dados para atualizar
      if (Object.keys(updateData).length > 0) {
        // Loop de retry: ML pode rejeitar parte do payload por regras
        // específicas do anúncio (family_name bloqueia title em autopart
        // catalog; attributes imutáveis em catálogo). Em vez de perder o
        // sync inteiro de preço/estoque, removemos o campo bloqueado e
        // tentamos novamente.
        let updatedItem;
        let currentPayload = { ...updateData };
        const MAX_ML_ATTEMPTS = 4;
        let succeeded = false;

        for (let attempt = 0; attempt < MAX_ML_ATTEMPTS; attempt++) {
          try {
            updatedItem = await MLApiService.updateItem(
              account.accessToken,
              externalListingId,
              currentPayload,
            );
            succeeded = true;
            break;
          } catch (err: any) {
            const cause = err?.response?.data;
            const causeStr =
              typeof cause === "string" ? cause : JSON.stringify(cause || "");
            const lower = (causeStr + " " + (err?.message || "")).toLowerCase();

            const blockedThisRound: string[] = [];
            if (
              "title" in currentPayload &&
              (lower.includes("cannot modify the title") ||
                lower.includes("family_name"))
            ) {
              blockedThisRound.push("title");
            }
            if (
              "attributes" in currentPayload &&
              lower.includes("attribute") &&
              (lower.includes("invalid") || err?.response?.status === 400)
            ) {
              blockedThisRound.push("attributes");
            }
            if (
              "description" in currentPayload &&
              lower.includes("description") &&
              lower.includes("not_modifiable")
            ) {
              blockedThisRound.push("description");
            }

            if (blockedThisRound.length === 0) {
              // Erro não conhecido — propaga e marca sync como falho.
              throw err;
            }

            console.warn(
              `[SYNC] ML rejeitou ${blockedThisRound.join(",")} (attempt ${attempt + 1}); removendo do payload e re-tentando. cause:`,
              causeStr.slice(0, 500),
            );
            const next = { ...currentPayload };
            for (const key of blockedThisRound) {
              delete (next as Record<string, unknown>)[key];
            }
            currentPayload = next;

            if (Object.keys(currentPayload).length === 0) {
              // Nada sobrou pra mandar — pula sem erro fatal.
              succeeded = true;
              break;
            }
          }
        }

        if (!succeeded) {
          throw new Error(
            "Não foi possível atualizar o anúncio no ML após várias tentativas",
          );
        }
        console.log(`[SYNC] Resposta do ML:`, updatedItem);

        // Atualização do título em items UP: o ML NÃO permite alterar
        // `family_name` (e portanto o título) via PUT /items nem via qualquer
        // endpoint de /user-products após a criação — testado empiricamente:
        // GET /user-products/{id} responde 200 mas PUT em qualquer formato
        // retorna 404 ou 400 ("The field family name is invalid", cause:374).
        //
        // A única forma de propagar mudança de título em item UP é
        // REPUBLICAR (criar um novo anúncio com o novo título e fechar o
        // antigo). Aplicamos salvaguarda: só republicamos se o anúncio antigo
        // não tem vendas nem bids (preserva reputação/vendas de listings
        // com histórico).
        let wasRepublished = false;
        if (pendingFamilyNameUpdate) {
          const soldQty = Number(
            (currentItem as { sold_quantity?: number }).sold_quantity || 0,
          );
          const hasBids = !!(currentItem as { has_bids?: boolean }).has_bids;
          if (soldQty > 0 || hasBids) {
            console.warn(
              JSON.stringify({
                event: "ml.up.republish.skipped",
                reason: "item_has_sales_or_bids",
                productId: product.id,
                externalListingId,
                soldQty,
                hasBids,
                requestedTitle: pendingFamilyNameUpdate,
              }),
            );
          } else {
            try {
              const r = await SyncUseCase.republishUpListing({
                userId: account.userId,
                productId: product.id,
                accountId: account.id,
                accessToken: account.accessToken,
                oldExternalListingId: externalListingId,
                currentItem,
                newTitle: pendingFamilyNameUpdate,
              });
              wasRepublished = r.republished;
            } catch (err) {
              const rawMessage =
                err instanceof Error ? err.message : String(err);
              console.error(
                JSON.stringify({
                  event: "ml.up.republish.failed",
                  productId: product.id,
                  externalListingId,
                  newTitle: pendingFamilyNameUpdate,
                  error: rawMessage,
                }),
              );
              // Não interrompe o sync principal — preço/estoque/description já
              // foram aplicados acima.
            }
          }
        }

        // Skip se houve republicação: o anúncio antigo foi fechado e a
        // description já foi setada no novo anúncio dentro do createMLListing.
        // Tentar PUT no antigo fechado retornaria item.status.invalid.
        if (pendingUpDescriptionUpdate && !wasRepublished) {
          try {
            await MLApiService.upsertDescription(
              account.accessToken,
              externalListingId,
              pendingUpDescriptionUpdate,
            );
            console.log(
              `[SYNC] UP description atualizada via endpoint dedicado /items/${externalListingId}/description`,
            );
          } catch (err) {
            const rawMessage = err instanceof Error ? err.message : String(err);
            console.error(
              JSON.stringify({
                event: "ml.description.update_failed",
                productId: product.id,
                externalListingId,
                error: rawMessage,
              }),
            );
            // Não interrompe o sync principal.
          }
        }

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

      // O preço NÃO vai por update_item (Shopee descarta silenciosamente
      // em vários cenários). Aplicamos via update_price separado abaixo.
      const priceNum = Number(product.price);
      const priceToApply =
        Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;
      updateData.stock = product.stock;

      // Sincronizar tÃ­tulo se foi alterado
      if (product.name && product.name !== currentItem.item_name) {
        updateData.item_name = product.name;
      }

      // Descrição enriquecida com bloco de compatibilidade veicular —
      // Shopee não tem endpoint dedicado de compat, então a descrição é
      // o veículo. Idempotente: se a descrição já tem o bloco, mantém.
      const enrichedShopeeDescription = SyncUseCase.appendCompatibilityBlock(
        product.description,
        (product as { compatibilities?: unknown }).compatibilities as Array<{
          brand: string;
          model: string;
          yearFrom?: number | null;
          yearTo?: number | null;
          version?: string | null;
        }>,
      );
      if (
        enrichedShopeeDescription &&
        enrichedShopeeDescription !== currentItem.description
      ) {
        updateData.description = enrichedShopeeDescription;
      }

      // Dimensões e peso — Shopee aceita esses campos no update_item.
      const heightCm = Number((product as { heightCm?: unknown }).heightCm);
      const widthCm = Number((product as { widthCm?: unknown }).widthCm);
      const lengthCm = Number((product as { lengthCm?: unknown }).lengthCm);
      const weightKg = Number((product as { weightKg?: unknown }).weightKg);
      if (
        Number.isFinite(heightCm) &&
        Number.isFinite(widthCm) &&
        Number.isFinite(lengthCm) &&
        heightCm > 0 &&
        widthCm > 0 &&
        lengthCm > 0
      ) {
        updateData.dimension = {
          package_height: heightCm,
          package_width: widthCm,
          package_length: lengthCm,
        };
      }
      if (Number.isFinite(weightKg) && weightKg > 0) {
        updateData.weight = weightKg;
      }

      console.log(`[SYNC] Dados a serem enviados para Shopee:`, updateData);

      // 1) Campos não-preço via update_item.
      //    item_id sempre presente; só chamamos se houver algum campo além dele.
      const updateItemKeys = Object.keys(updateData).filter(
        (k) => k !== "item_id",
      );
      if (updateItemKeys.length > 0) {
        const updatedItem = await ShopeeApiService.updateItem(
          account.accessToken,
          account.shopId,
          updateData,
        );
        console.log(
          `[SYNC] Resposta do Shopee update_item:`,
          "keys=",
          Object.keys(updatedItem || {}).join(","),
        );
      }

      // 2) Preço via /api/v2/product/update_price (endpoint dedicado).
      //    update_item descarta original_price em vários cenários — daí
      //    usamos sempre o endpoint dedicado para garantir propagação.
      if (priceToApply !== null) {
        const priceList: Array<{
          model_id?: number;
          original_price: number;
        }> = [];
        if (currentItem.has_model === true) {
          const models = (
            currentItem as unknown as {
              model_list?: Array<{ model_id?: number }>;
            }
          ).model_list;
          if (Array.isArray(models) && models.length > 0) {
            for (const m of models) {
              if (typeof m.model_id === "number") {
                priceList.push({
                  model_id: m.model_id,
                  original_price: priceToApply,
                });
              }
            }
          }
        }
        if (priceList.length === 0) {
          priceList.push({ original_price: priceToApply });
        }
        try {
          await ShopeeApiService.updatePrice(
            account.accessToken,
            account.shopId,
            parseInt(externalListingId),
            priceList,
          );
          console.log(
            `[SYNC] Shopee updatePrice OK previous=${currentItem.price_info?.[0]?.current_price ?? "?"} applied=${priceToApply} models=${priceList.length}`,
          );
        } catch (priceErr) {
          // Falha de preço não derruba o sync inteiro — o resto pode ter
          // passado. Reportamos via result.error para subir como warning.
          const msg =
            priceErr instanceof Error ? priceErr.message : String(priceErr);
          result.error = `Preço não atualizou na Shopee: ${msg}`;
          console.error(
            `[SYNC] Shopee updatePrice failed (externalId=${externalListingId}):`,
            msg,
          );
        }
      }

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

    if (status === SyncStatus.FAILURE) {
      void this.checkAndAlertTokenHealth(marketplaceAccountId, message);
    }
  }

  private static readonly TOKEN_ERROR_PATTERNS = [
    /invalid[_\s-]?token/i,
    /token[_\s-]?revoked/i,
    /unauthorized/i,
    /invalid access token/i,
    /refresh[_\s-]?token[_\s-]?(?:expired|invalid)/i,
    /401/,
  ];

  private static isTokenError(message: string): boolean {
    if (!message) return false;
    return this.TOKEN_ERROR_PATTERNS.some((re) => re.test(message));
  }

  /**
   * Detecta falhas consecutivas por token expirado numa conta de marketplace
   * e dispara alerta único (dedup 24h) em SystemLog para o usuário reconectar.
   *
   * Janela: 3 falhas-token em 30min. Evita spam com dedup baseado em
   * SystemLog(action=TOKEN_EXPIRED_REPEATED, resourceId=accountId) nas últimas 24h.
   */
  private static async checkAndAlertTokenHealth(
    marketplaceAccountId: string,
    message: string,
  ): Promise<void> {
    try {
      if (!this.isTokenError(message)) return;

      const windowStart = new Date(Date.now() - 30 * 60 * 1000);
      const recentFailures = await prisma.syncLog.count({
        where: {
          marketplaceAccountId,
          status: SyncStatus.FAILURE,
          createdAt: { gte: windowStart },
        },
      });

      if (recentFailures < 3) return;

      const dedupeStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const existing = await prisma.systemLog.findFirst({
        where: {
          action: "TOKEN_EXPIRED_REPEATED",
          resourceId: marketplaceAccountId,
          createdAt: { gte: dedupeStart },
        },
        select: { id: true },
      });
      if (existing) return;

      const account = await prisma.marketplaceAccount.findUnique({
        where: { id: marketplaceAccountId },
        select: { platform: true, accountName: true },
      });

      const label = `${account?.platform ?? "?"} "${account?.accountName ?? marketplaceAccountId}"`;
      await SystemLogService.logError(
        "TOKEN_EXPIRED_REPEATED",
        `Token aparentemente expirado em ${label} — ${recentFailures} falhas nos últimos 30min. Reconecte em /integracoes.`,
        {
          resource: "MarketplaceAccount",
          resourceId: marketplaceAccountId,
          details: {
            platform: account?.platform,
            accountName: account?.accountName,
            recentFailures,
            lastError: message.slice(0, 500),
          },
        },
      );
    } catch (err) {
      console.error("[checkAndAlertTokenHealth] falhou:", err);
    }
  }

  /**
   * Alerta persistente para anúncios ML em estado perigoso para reativação manual:
   * paused + quantidade remota > 0 + estoque local = 0. Se o vendedor reativar
   * pelo painel do ML sem antes zerar a quantidade, o anúncio volta vendável e
   * pode gerar oversell. ML rejeita qty=0 via API, então não há correção
   * automática — apenas alertamos.
   *
   * Dedup: 24h por listing (action=ML_REACTIVATION_RISK, resourceId=listing.id).
   */
  private static async alertMLReactivationRisk(
    account: { id: string; platform: string; accountName: string },
    listing: { id: string; externalListingId: string },
    product: { id: string; sku: string | null; name: string },
    remoteQuantity: number,
  ): Promise<void> {
    try {
      const dedupeStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const existing = await prisma.systemLog.findFirst({
        where: {
          action: "ML_REACTIVATION_RISK",
          resourceId: listing.id,
          createdAt: { gte: dedupeStart },
        },
        select: { id: true },
      });
      if (existing) return;

      const label = `${account.platform} "${account.accountName}"`;
      await SystemLogService.logError(
        "ML_REACTIVATION_RISK",
        `Risco de oversell em ${label}: anúncio ${listing.externalListingId} (SKU ${product.sku ?? "?"} — ${product.name}) está paused com quantidade remota=${remoteQuantity} mas estoque local=0. Antes de reativar pelo painel do ML, zere a quantidade no próprio ML (API rejeita qty=0 remotamente).`,
        {
          resource: "Listing",
          resourceId: listing.id,
          details: {
            platform: account.platform,
            accountName: account.accountName,
            accountId: account.id,
            externalListingId: listing.externalListingId,
            productId: product.id,
            productSku: product.sku,
            productName: product.name,
            remoteQuantity,
            localStock: 0,
          },
        },
      );
    } catch (err) {
      console.error("[alertMLReactivationRisk] falhou:", err);
    }
  }

  /**
   * Republica um anúncio em fluxo "User Product" do Mercado Livre quando o
   * título muda. Necessário porque o ML não permite atualizar `family_name`
   * de items UP após criação (toda tentativa via PUT /items/{id} retorna
   * 400 "The field family name is invalid", cause:374; endpoints
   * /user-products/{id} e /families/{id} retornam 404). O único caminho
   * para refletir o novo título é criar um anúncio novo e fechar o antigo.
   *
   * Aplicado APENAS quando o anúncio antigo não tem vendas nem bids
   * (salvaguarda aplicada pelo caller). Caso contrário, o sync ignora o
   * title em silêncio e preserva o anúncio existente.
   *
   * Fluxo:
   *  1. Reset externalListingId do ProductListing para placeholder
   *     "PENDING_REPUBLISH_<old>_<ts>" — assim createMLListing reusa o
   *     mesmo registro do banco e atualiza com o novo MLB-ID quando o ML
   *     criar o anúncio.
   *  2. Chama ListingUseCase.createMLListing com settings extraídos do
   *     currentItem (listing_type, condition, shipping, warranty) para
   *     preservar o tipo do anúncio.
   *  3. Se sucesso: fecha o anúncio antigo via PUT /items/{old} { status:
   *     "closed" } e loga ml.up.republished.
   *  4. Se falha: reverte externalListingId para o oldId original (anúncio
   *     antigo permanece intocado).
   */
  /**
   * Estado de retry a gravar junto com o revert do placeholder.
   *
   * `createMLListing` REUSA a linha do listing (findByProductAndAccount), e os
   * ramos de falha da escada dele gravam `retryEnabled: true` nessa mesma
   * linha. Ao reverter, a linha volta a apontar o anúncio ANTIGO — que segue
   * vivo e ativo no ML — então não há nada a retentar: sem este reset, a linha
   * fica com `externalListingId` real + `retryEnabled: true`, o
   * ListingRetryService a considera candidata (o filtro dele passa por
   * retryEnabled, sem exigir prefixo PENDING_) e chama createItem, criando um
   * anúncio DUPLICADO no ML e deixando o antigo órfão (vivo lá, sem linha
   * aqui). Não dá para filtrar por PENDING_ no retry: os candidatos legítimos
   * do Shopee têm id real.
   */
  private static readonly REVERTED_RETRY_STATE = {
    retryEnabled: false,
    nextRetryAt: null,
  } as const;

  static async republishUpListing(args: {
    userId: string;
    productId: string;
    accountId: string;
    accessToken: string;
    oldExternalListingId: string;
    currentItem: MLItemDetails;
    newTitle: string;
  }): Promise<{ republished: boolean; newExternalListingId?: string }> {
    const {
      userId,
      productId,
      accountId,
      accessToken,
      oldExternalListingId,
      currentItem,
      newTitle,
    } = args;

    // Busca pela unique (conta, externalListingId) — a linha EXATA do anúncio
    // sendo republicado. Buscar por (produto, conta) pegava uma linha
    // arbitrária quando o par tem várias (autodetect cria uma por anúncio), e
    // o swap de placeholder abaixo podia sequestrar a linha de OUTRO anúncio.
    const listing = await ListingRepository.findByExternalListingId(
      accountId,
      oldExternalListingId,
    );
    if (!listing) {
      throw new Error(
        `Listing não encontrado no banco para item ${oldExternalListingId} / account ${accountId}`,
      );
    }

    // 1. Extrair mlSettings do anúncio atual para preservar configurações.
    const mlSettings = SyncUseCase.extractMlSettingsFromItem(currentItem);
    const categoryId = currentItem.category_id;

    console.warn(
      `[SYNC] UP republish: iniciando para ${oldExternalListingId} (productId=${productId}, accountId=${accountId}, newTitle="${newTitle}")`,
    );

    // 2. Reset externalListingId pra placeholder — createMLListing reusa o
    // mesmo registro e atualiza com o novo MLB-ID.
    const placeholder = `PENDING_REPUBLISH_${oldExternalListingId}_${Date.now()}`;
    await ListingRepository.updateListing(listing.id, {
      externalListingId: placeholder,
      status: "pending",
    });

    // 3. Chamar createMLListing — mesmo pipeline usado por novos anúncios
    // (cria item, anexa compatibilidades, reconcilia listing_type, etc.).
    // Passamos `newTitle` como `titleOverride` para o caso de edit unitário
    // em que o título alvo difere do `product.name` (override só desse anúncio).
    let result;
    try {
      result = await ListingUseCase.createMLListing(
        userId,
        productId,
        categoryId,
        accountId,
        mlSettings,
        newTitle,
      );
    } catch (createErr) {
      // Reverter o placeholder para o ID original — o anúncio antigo
      // permanece intocado e nada foi alterado no ML.
      await ListingRepository.updateListing(listing.id, {
        externalListingId: oldExternalListingId,
        status: (currentItem.status as string) || "active",
        ...SyncUseCase.REVERTED_RETRY_STATE,
      });
      throw createErr;
    }

    if (!result.success || !result.externalListingId) {
      // Mesmo tratamento: reverter o placeholder.
      await ListingRepository.updateListing(listing.id, {
        externalListingId: oldExternalListingId,
        status: (currentItem.status as string) || "active",
        ...SyncUseCase.REVERTED_RETRY_STATE,
      });
      throw new Error(
        `createMLListing retornou success=false: ${result.error || "sem detalhes"}`,
      );
    }

    const newExternalListingId = result.externalListingId;

    // 4. Fechar anúncio antigo no ML. Não-fatal: se falhar, ficamos com 2
    // anúncios ativos temporariamente (o user pode fechar manualmente).
    try {
      await MLApiService.updateItem(accessToken, oldExternalListingId, {
        status: "closed",
      });
      console.log(
        `[SYNC] Anúncio antigo ${oldExternalListingId} fechado após republicação para ${newExternalListingId}`,
      );
    } catch (closeErr) {
      console.warn(
        JSON.stringify({
          event: "ml.up.republish.old_close_failed",
          productId,
          oldExternalListingId,
          newExternalListingId,
          error:
            closeErr instanceof Error ? closeErr.message : String(closeErr),
        }),
      );
    }

    console.warn(
      JSON.stringify({
        event: "ml.up.republished",
        productId,
        accountId,
        oldExternalListingId,
        newExternalListingId,
        newTitle,
      }),
    );

    return { republished: true, newExternalListingId };
  }

  /**
   * Extrai MLListingSettings de um MLItemDetails. Usado pelo flow de
   * republicação para preservar configurações do anúncio antigo (tipo,
   * condição, frete, garantia) ao criar o novo.
   */
  private static extractMlSettingsFromItem(
    item: MLItemDetails,
  ): import("./listing.usercase").MLListingSettings {
    const settings: import("./listing.usercase").MLListingSettings = {};

    const listingTypeId = (item as { listing_type_id?: string })
      .listing_type_id;
    if (listingTypeId) {
      settings.listingType = listingTypeId;
    }
    const condition = (item as { condition?: string }).condition;
    if (condition) {
      settings.itemCondition = condition;
    }
    const shipping = (item as { shipping?: Record<string, unknown> }).shipping;
    if (shipping && typeof shipping === "object") {
      if (typeof shipping.mode === "string") {
        settings.shippingMode = shipping.mode;
      }
      if (typeof shipping.free_shipping === "boolean") {
        settings.freeShipping = shipping.free_shipping;
      }
      if (typeof shipping.local_pick_up === "boolean") {
        settings.localPickup = shipping.local_pick_up;
      }
    }
    // Warranty vem em sale_terms[].id === "WARRANTY_TYPE" / "WARRANTY_TIME"
    const saleTerms = (
      item as { sale_terms?: Array<{ id: string; value_name?: string }> }
    ).sale_terms;
    if (Array.isArray(saleTerms)) {
      const warrantyType = saleTerms.find((t) => t.id === "WARRANTY_TYPE");
      const warrantyTime = saleTerms.find((t) => t.id === "WARRANTY_TIME");
      if (warrantyType && warrantyType.value_name) {
        settings.hasWarranty = true;
        if (warrantyTime && warrantyTime.value_name) {
          // value_name format: "90 dias" / "12 meses"
          const m = warrantyTime.value_name.match(/(\d+)\s*(dias?|meses?)/i);
          if (m) {
            settings.warrantyDuration = Number(m[1]);
            settings.warrantyUnit = m[2].toLowerCase().startsWith("mes")
              ? "meses"
              : "dias";
          }
        }
      }
    }
    return settings;
  }
}

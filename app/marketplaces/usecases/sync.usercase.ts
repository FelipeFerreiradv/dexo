/**
 * SyncUseCase - Orquestração de sincronização entre estoque local e Mercado Livre
 *
 * Responsabilidades:
 * - Importar itens do ML e vincular automaticamente por SKU
 * - Sincronizar estoque do sistema central para o ML
 * - Registrar logs de sincronização
 */

import prisma from "@/app/lib/prisma";
import { Platform, SyncType, SyncStatus } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import type { MLItemDetails } from "../types/ml-api.types";

// Tipos para resultados de sincronização
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
  static async importMLItems(userId: string): Promise<ImportResult> {
    const result: ImportResult = {
      totalItems: 0,
      linkedItems: 0,
      unlinkedItems: 0,
      errors: [],
      items: [],
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

    // 4. Processar cada item
    for (const item of itemsDetails) {
      try {
        const processedItem = await this.processImportedItem(item, account.id);
        result.items.push(processedItem);

        if (processedItem.status === "linked") {
          result.linkedItems++;
        } else {
          result.unlinkedItems++;
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
      }
    }

    // 5. Registrar log da importação
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
   * Processa um item importado do ML
   * Nota: ProductListing.productId é required, então só criamos listing se houver produto
   */
  private static async processImportedItem(
    item: MLItemDetails,
    accountId: string,
  ): Promise<ImportResult["items"][0]> {
    const sku = this.extractSku(item);

    // Verificar se já existe um listing para este item
    const existingListing = await ListingRepository.findByExternalListingId(
      accountId,
      item.id,
    );

    if (existingListing) {
      // Já existe, atualizar status se necessário
      if (existingListing.status !== item.status) {
        await ListingRepository.updateStatus(existingListing.id, item.status);
      }

      return {
        externalListingId: item.id,
        title: item.title,
        sku,
        linkedProductId: existingListing.productId,
        status: "linked",
      };
    }

    // Tentar vincular por SKU se disponível
    let linkedProductId: string | null = null;

    if (sku) {
      const product = await prisma.product.findUnique({
        where: { sku: sku },
      });

      if (product) {
        linkedProductId = product.id;
      }
    }

    // Se encontrou produto, criar listing
    if (linkedProductId) {
      await ListingRepository.createListing({
        productId: linkedProductId,
        marketplaceAccountId: accountId,
        externalListingId: item.id,
        externalSku: sku || undefined,
        status: item.status,
      });
    }

    return {
      externalListingId: item.id,
      title: item.title,
      sku,
      linkedProductId,
      status: linkedProductId ? "linked" : "unlinked",
    };
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
   * Sincroniza o estoque de um produto específico para o ML
   */
  static async syncProductStock(productId: string): Promise<SyncResult> {
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
      return {
        success: false,
        productId,
        externalListingId: "",
        error: "Produto não encontrado",
      };
    }

    // 2. Filtrar listings do Mercado Livre
    const mlListings = product.listings.filter(
      (listing) =>
        listing.marketplaceAccount.platform === Platform.MERCADO_LIVRE,
    );

    if (mlListings.length === 0) {
      return {
        success: false,
        productId,
        externalListingId: "",
        error: "Produto não vinculado ao Mercado Livre",
      };
    }

    // 3. Sincronizar cada listing (pode haver múltiplas contas)
    const results: SyncResult[] = [];

    for (const listing of mlListings) {
      const account = listing.marketplaceAccount;

      if (!account.accessToken) {
        results.push({
          success: false,
          productId,
          externalListingId: listing.externalListingId,
          error: "Conta sem token de acesso",
        });
        continue;
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
          `Estoque do produto ${product.name} atualizado: ${previousStock} → ${product.stock}`,
          {
            productId,
            externalListingId: listing.externalListingId,
            previousStock,
            newStock: product.stock,
          },
        );

        results.push({
          success: true,
          productId,
          externalListingId: listing.externalListingId,
          previousStock,
          newStock: product.stock,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Erro desconhecido";

        await this.logSync(
          account.id,
          SyncType.STOCK_UPDATE,
          SyncStatus.FAILURE,
          `Erro ao atualizar estoque: ${errorMessage}`,
          {
            productId,
            externalListingId: listing.externalListingId,
            error: errorMessage,
          },
        );

        results.push({
          success: false,
          productId,
          externalListingId: listing.externalListingId,
          error: errorMessage,
        });
      }
    }

    // Retornar primeiro resultado (ou agregar se necessário)
    return (
      results[0] || {
        success: false,
        productId,
        externalListingId: "",
        error: "Nenhum listing processado",
      }
    );
  }

  /**
   * Sincroniza o estoque de todos os produtos vinculados ao ML
   */
  static async syncAllStock(userId: string): Promise<SyncAllResult> {
    const result: SyncAllResult = {
      total: 0,
      successful: 0,
      failed: 0,
      results: [],
    };

    // 1. Buscar conta do marketplace
    const account = await MarketplaceRepository.findByUserIdAndPlatform(
      userId,
      Platform.MERCADO_LIVRE,
    );

    if (!account) {
      throw new Error("Conta do Mercado Livre não encontrada");
    }

    // 2. Buscar todos os listings vinculados a produtos
    const listings = await prisma.productListing.findMany({
      where: {
        marketplaceAccountId: account.id,
      },
      include: {
        product: true,
      },
    });

    result.total = listings.length;

    // 3. Sincronizar cada produto
    for (const listing of listings) {
      if (!listing.product) continue;

      const syncResult = await this.syncProductStock(listing.product.id);
      result.results.push(syncResult);

      if (syncResult.success) {
        result.successful++;
      } else {
        result.failed++;
      }
    }

    // 4. Log geral da sincronização
    await this.logSync(
      account.id,
      SyncType.STOCK_UPDATE,
      result.failed === 0 ? SyncStatus.SUCCESS : SyncStatus.WARNING,
      `Sincronização em lote: ${result.successful}/${result.total} bem-sucedidos`,
      {
        total: result.total,
        successful: result.successful,
        failed: result.failed,
      },
    );

    return result;
  }

  /**
   * Registra um log de sincronização
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

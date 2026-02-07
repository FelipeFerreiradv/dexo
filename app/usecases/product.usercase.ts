import { string } from "zod";
import {
  Product,
  ProductCreate,
  ProductUpdate,
  ProductUpdateResult,
  ProductRepository,
} from "../interfaces/product.interface";
import { ProductRepositoryPrisma } from "../repositories/product.repository";
import { SyncUseCase } from "../marketplaces/usecases/sync.usercase";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { SystemLogService } from "../services/system-log.service";
import prisma from "../lib/prisma";

export class ProductUseCase {
  private productRepository: ProductRepository;
  constructor() {
    this.productRepository = new ProductRepositoryPrisma();
  }

  async create(productData: ProductCreate): Promise<Product> {
    const existsProduct = await this.productRepository.findBySku(
      productData.sku,
    );
    if (existsProduct) {
      throw new Error("Produto com esse sku já existe");
    }
    const data = await this.productRepository.create(productData);
    return data;
  }

  async listProducts(options?: {
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ products: Product[]; total: number; totalPages: number }> {
    const data = await this.productRepository.findAll(options);
    return {
      ...data,
      totalPages: Math.ceil(data.total / (options?.limit || 10)),
    };
  }

  async delete(id: string): Promise<{
    success: boolean;
    message: string;
    listingResults?: Array<{
      externalListingId: string;
      closed: boolean;
      error?: string;
    }>;
  }> {
    try {
      // Before deleting the product, remove all associated ML listings
      const listings = await this.getProductListings(id);
      const listingResults: Array<{
        externalListingId: string;
        closed: boolean;
        error?: string;
      }> = [];

      for (const listing of listings) {
        const result = await ListingUseCase.removeMLListing(listing.id);
        listingResults.push({
          externalListingId: listing.externalListingId,
          closed: result.success,
          error: result.error,
        });
      }

      await this.productRepository.delete(id);

      const failedClosures = listingResults.filter((r) => !r.closed);
      if (failedClosures.length > 0) {
        return {
          success: true,
          message: `Produto excluído. ${failedClosures.length} anúncio(s) não puderam ser fechados no ML devido a infrações.`,
          listingResults,
        };
      }

      return {
        success: true,
        message: "Produto e anúncios associados excluídos com sucesso",
        listingResults,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Erro ao excluir produto",
      };
    }
  }

  async update(id: string, data: ProductUpdate): Promise<ProductUpdateResult> {
    const product = await this.productRepository.findById(id);
    if (!product) {
      throw new Error("Produto não encontrado");
    }

    const updated = await this.productRepository.update(id, data);

    // Sincronizar anúncios relacionados após atualização do produto
    let syncResults = undefined;
    try {
      const results = await this.syncProductListings(updated);
      if (results && results.length > 0) {
        syncResults = {
          totalListings: results.length,
          successful: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
          results,
        };
      }
    } catch (error) {
      // Log do erro mas não falha a atualização do produto
      console.error("Erro ao sincronizar anúncios do produto:", error);
      await SystemLogService.logError(
        "SYNC_STOCK",
        `Erro na sincronização: PRODUCT_UPDATE_SYNC - MercadoLivre`,
        {
          resource: "Sync",
          details: {
            syncType: "PRODUCT_UPDATE_SYNC",
            marketplace: "MercadoLivre",
            error: error instanceof Error ? error.message : error,
          },
        },
      );
    }

    return {
      product: updated,
      syncResults,
    };
  }

  /**
   * Gera o próximo SKU disponível
   * Formato: PROD-001, PROD-002, etc.
   */
  async getNextSku(): Promise<string> {
    const maxNumber = await this.productRepository.getMaxSkuNumber();
    const nextNumber = maxNumber + 1;
    return `PROD-${nextNumber.toString().padStart(3, "0")}`;
  }

  /**
   * Sincroniza anúncios relacionados após atualização do produto
   * Atualiza preço, estoque e outros campos nos marketplaces
   */
  private async syncProductListings(product: Product): Promise<
    Array<{
      success: boolean;
      productId: string;
      externalListingId: string;
      previousStock?: number;
      newStock?: number;
      previousPrice?: number;
      newPrice?: number;
      error?: string;
    }>
  > {
    try {
      console.log(
        `[SYNC] Iniciando sincronização para produto ${product.id} (${product.name})`,
      );

      // Buscar todos os anúncios vinculados a este produto
      const listings = await this.getProductListings(product.id);

      console.log(`[SYNC] Encontrados ${listings.length} anúncios vinculados`);

      if (listings.length === 0) {
        console.log(`[SYNC] Nenhum anúncio para sincronizar`);
        return []; // Nenhum anúncio para sincronizar
      }

      // Sincronizar cada anúncio
      const results = [];
      for (const listing of listings) {
        try {
          console.log(
            `[SYNC] Sincronizando anúncio ${listing.externalListingId} da conta ${listing.marketplaceAccountId}`,
          );
          const result = await SyncUseCase.syncProductData(
            product.id,
            listing.externalListingId,
            listing.marketplaceAccountId,
          );
          results.push(result);
        } catch (error) {
          console.error(
            `Erro ao sincronizar anúncio ${listing.externalListingId}:`,
            error,
          );
          results.push({
            success: false,
            productId: product.id,
            externalListingId: listing.externalListingId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return results;
    } catch (error) {
      console.error("Erro ao buscar anúncios do produto:", error);
      throw error;
    }
  }

  /**
   * Busca todos os anúncios vinculados a um produto
   */
  private async getProductListings(productId: string) {
    try {
      return await prisma.productListing.findMany({
        where: { productId },
        include: {
          marketplaceAccount: true,
        },
      });
    } catch (error) {
      console.error("Erro ao buscar anúncios do produto:", error);
      throw error;
    }
  }
}

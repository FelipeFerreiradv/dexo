import { Platform } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ListingRepository } from "../repositories/listing.repository";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";

export interface CreateListingResult {
  success: boolean;
  listingId?: string;
  externalListingId?: string;
  error?: string;
}

export class ListingUseCase {
  private static productRepository = new ProductRepositoryPrisma();
  /**
   * Mapeia a qualidade do produto para a condição do Mercado Livre
   */
  private static mapQualityToMLCondition(
    quality?: string,
  ): "new" | "used" | "not_specified" {
    switch (quality) {
      case "NOVO":
        return "new";
      case "SEMINOVO":
      case "RECONDICIONADO":
      case "SUCATA":
        return "used";
      default:
        return "not_specified";
    }
  }

  /**
   * Constrói um título completo para o anúncio do ML
   */
  private static buildMLTitle(product: any): string {
    const parts: string[] = [];

    // Adicionar nome do produto
    parts.push(product.name);

    // Adicionar marca se disponível
    if (product.brand) {
      parts.push(product.brand);
    }

    // Adicionar modelo se disponível
    if (product.model) {
      parts.push(product.model);
    }

    // Adicionar ano se disponível
    if (product.year) {
      parts.push(product.year);
    }

    // Adicionar versão se disponível
    if (product.version) {
      parts.push(product.version);
    }

    // Adicionar partNumber se disponível
    if (product.partNumber) {
      parts.push(`PN: ${product.partNumber}`);
    }

    // Juntar tudo e limitar a 60 caracteres
    const fullTitle = parts.join(" - ");
    return fullTitle.length > 60 ? fullTitle.substring(0, 60) : fullTitle;
  }

  /**
   * Constrói uma descrição completa para o anúncio do ML
   */
  private static buildMLDescription(product: any): string {
    const parts: string[] = [];

    // Descrição principal
    if (product.description) {
      parts.push(product.description);
    }

    // Detalhes técnicos
    const details: string[] = [];
    if (product.brand) details.push(`Marca: ${product.brand}`);
    if (product.model) details.push(`Modelo: ${product.model}`);
    if (product.year) details.push(`Ano: ${product.year}`);
    if (product.version) details.push(`Versão: ${product.version}`);
    if (product.partNumber)
      details.push(`Número da Peça: ${product.partNumber}`);
    if (product.quality) details.push(`Qualidade: ${product.quality}`);
    if (product.location) details.push(`Localização: ${product.location}`);

    if (details.length > 0) {
      parts.push("Detalhes Técnicos:");
      parts.push(details.join("\n"));
    }

    // SKU para referência
    parts.push(`SKU: ${product.sku}`);

    return parts.join("\n\n");
  }

  /**
   * Cria um anúncio no Mercado Livre para um produto
   * @param userId ID do usuário
   * @param productId ID do produto
   * @param categoryId ID da categoria do ML (opcional, será inferida se não fornecida)
   */
  static async createMLListing(
    userId: string,
    productId: string,
    categoryId?: string,
  ): Promise<CreateListingResult> {
    try {
      const account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        Platform.MERCADO_LIVRE,
      );

      if (!account || !account.accessToken) {
        return {
          success: false,
          error: "Conta do Mercado Livre não conectada ou sem credenciais",
        };
      }

      // 2. Buscar dados do produto
      const product =
        await ListingUseCase.productRepository.findById(productId);
      if (!product) {
        return {
          success: false,
          error: "Produto não encontrado",
        };
      }

      // 3. Preparar payload para criação do anúncio
      const payload: MLItemCreatePayload = {
        title: this.buildMLTitle(product),
        category_id: categoryId || "MLB271107", // Usar categoria fornecida ou padrão
        price: product.price, // Usar preço real do produto
        currency_id: "BRL",
        available_quantity: Math.min(product.stock, 999999), // ML limita quantidade máxima
        buying_mode: "buy_it_now",
        listing_type_id: "bronze", // Usar bronze que pode não exigir pictures
        condition: this.mapQualityToMLCondition(product.quality) || "new",
        pictures: [
          {
            source: product.imageUrl
              ? product.imageUrl.startsWith("http")
                ? product.imageUrl
                : `${process.env.APP_BACKEND_URL || "http://localhost:3333"}${product.imageUrl}`
              : "https://via.placeholder.com/500x500.png?text=Produto",
          },
        ],
        attributes: [
          {
            id: "BRAND",
            value_name: product.brand || "Genérica",
          },
          {
            id: "MODEL",
            value_name: product.model || product.name,
          },
        ],
        seller_custom_field: product.sku,
      };

      // Adicionar descrição se existir
      // Removido temporariamente para debug
      // if (product.description) {
      //   payload.attributes = [
      //     {
      //       id: "DESCRIPTION",
      //       value_name: product.description,
      //     },
      //   ];
      // }

      // 4. Criar anúncio no ML
      console.log(
        `[ListingUseCase] Creating ML listing for product ${productId} (${product.name})`,
      );
      const mlItem = await MLApiService.createItem(
        account.accessToken,
        payload,
      );

      // 5. Criar vínculo local (ProductListing)
      const listing = await ListingRepository.createListing({
        productId,
        marketplaceAccountId: account.id,
        externalListingId: mlItem.id,
        externalSku: product.sku,
        permalink: mlItem.permalink,
        status: "active",
      });

      console.log(`[ListingUseCase] ML listing created: ${mlItem.id}`);

      return {
        success: true,
        listingId: listing.id,
        externalListingId: mlItem.id,
      };
    } catch (error) {
      console.error("[ListingUseCase] Error creating ML listing:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  /**
   * Atualiza o estoque de um anúncio no ML
   * @param listingId ID do vínculo local
   * @param quantity Nova quantidade
   */
  static async updateMLListingStock(
    listingId: string,
    quantity: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Buscar vínculo
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return { success: false, error: "Vínculo não encontrado" };
      }

      // Buscar conta para obter access token
      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken) {
        return { success: false, error: "Conta sem credenciais válidas" };
      }

      // Atualizar estoque no ML
      await MLApiService.updateItemStock(
        account.accessToken,
        listing.externalListingId,
        quantity,
      );

      return { success: true };
    } catch (error) {
      console.error("[ListingUseCase] Error updating ML stock:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Erro ao atualizar estoque",
      };
    }
  }

  /**
   * Remove um anúncio do ML
   * @param listingId ID do vínculo local
   */
  static async removeMLListing(
    listingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Buscar vínculo
      const listing = await ListingRepository.findById(listingId);
      if (!listing) {
        return { success: false, error: "Vínculo não encontrado" };
      }

      // Buscar conta para obter access token
      const account = await MarketplaceRepository.findById(
        listing.marketplaceAccountId,
      );
      if (!account || !account.accessToken) {
        return { success: false, error: "Conta sem credenciais válidas" };
      }

      // Pausar anúncio no ML (não deletar, apenas pausar)
      await MLApiService.updateItem(
        account.accessToken,
        listing.externalListingId,
        {
          status: "paused",
        },
      );

      // Remover vínculo local
      await ListingRepository.deleteListing(listingId);

      return { success: true };
    } catch (error) {
      console.error("[ListingUseCase] Error removing ML listing:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Erro ao remover anúncio",
      };
    }
  }
}

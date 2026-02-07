import { Platform } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ListingRepository } from "../repositories/listing.repository";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { ShopeeItemCreatePayload } from "../types/shopee-api.types";
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
   * Cria um anúncio em qualquer marketplace suportado
   */
  static async createListing(
    userId: string,
    productId: string,
    platform: Platform,
    categoryId?: string,
  ): Promise<CreateListingResult> {
    switch (platform) {
      case Platform.MERCADO_LIVRE:
        return this.createMLListing(userId, productId, categoryId);
      case Platform.SHOPEE:
        return this.createShopeeListing(userId, productId, categoryId);
      default:
        return {
          success: false,
          error: `Plataforma ${platform} não suportada`,
        };
    }
  }
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
      // Detectar moeda baseada no site da conta (temporário - TODO: implementar detecção dinâmica)
      const currencyId =
        account.accountName?.includes("MLA") ||
        account.accountName?.includes("Argentina")
          ? "ARS"
          : "BRL";

      const payload: MLItemCreatePayload = {
        title: this.buildMLTitle(product),
        category_id: categoryId || "MLB271107", // Usar categoria fornecida ou padrão
        price: product.price, // Usar preço real do produto
        currency_id: currencyId,
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
          {
            id: "SELLER_SKU",
            value_name: product.sku,
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
      console.log(
        `[ListingUseCase] Payload being sent:`,
        JSON.stringify(payload, null, 2),
      );
      const mlItem = await MLApiService.createItem(
        account.accessToken,
        payload,
      );
      console.log(
        `[ListingUseCase] ML response:`,
        JSON.stringify(mlItem, null, 2),
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
   * Constrói um título para o anúncio do Shopee
   */
  private static buildShopeeTitle(product: any): string {
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

    // Juntar tudo e limitar a 120 caracteres (limite do Shopee)
    const fullTitle = parts.join(" - ");
    return fullTitle.length > 120 ? fullTitle.substring(0, 120) : fullTitle;
  }

  /**
   * Constrói uma descrição para o anúncio do Shopee
   */
  private static buildShopeeDescription(product: any): string {
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
   * Cria um anúncio no Shopee para um produto
   * @param userId ID do usuário
   * @param productId ID do produto
   * @param categoryId ID da categoria do Shopee (opcional, será inferida se não fornecida)
   */
  static async createShopeeListing(
    userId: string,
    productId: string,
    categoryId?: string,
  ): Promise<CreateListingResult> {
    try {
      const account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        Platform.SHOPEE,
      );

      if (!account || !account.accessToken || !account.shopId) {
        return {
          success: false,
          error: "Conta do Shopee não conectada ou sem credenciais válidas",
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
      const payload: ShopeeItemCreatePayload = {
        category_id: categoryId ? parseInt(categoryId) : 100644, // Usar categoria fornecida ou padrão
        item_name: this.buildShopeeTitle(product),
        description: this.buildShopeeDescription(product),
        item_sku: product.sku,
        price: product.price,
        stock: Math.min(product.stock, 999999), // Shopee limita quantidade máxima
        weight: 1.0, // Peso padrão em kg
        package_length: 10,
        package_width: 10,
        package_height: 10,
        image: {
          image_url_list: [
            product.imageUrl
              ? product.imageUrl.startsWith("http")
                ? product.imageUrl
                : `${process.env.APP_BACKEND_URL || "http://localhost:3333"}${product.imageUrl}`
              : "https://via.placeholder.com/500x500.png?text=Produto",
          ],
        },
        attribute_list: [
          {
            attribute_id: 100001, // Marca
            attribute_name: "Marca",
            attribute_value_list: [
              {
                value_id: 0,
                value_name: product.brand || "Genérica",
                value_unit: "",
              },
            ],
          },
          {
            attribute_id: 100002, // Modelo
            attribute_name: "Modelo",
            attribute_value_list: [
              {
                value_id: 0,
                value_name: product.model || product.name,
                value_unit: "",
              },
            ],
          },
        ],
        logistic_info: [], // Logística será configurada separadamente
      };

      // 4. Criar anúncio no Shopee
      console.log(
        `[ListingUseCase] Creating Shopee listing for product ${productId} (${product.name})`,
      );
      console.log(
        `[ListingUseCase] Payload being sent:`,
        JSON.stringify(payload, null, 2),
      );
      const shopeeItem = await ShopeeApiService.createItem(
        account.accessToken,
        account.shopId,
        payload,
      );
      console.log(
        `[ListingUseCase] Shopee response:`,
        JSON.stringify(shopeeItem, null, 2),
      );

      // 5. Criar vínculo local (ProductListing)
      const listing = await ListingRepository.createListing({
        productId,
        marketplaceAccountId: account.id,
        externalListingId: shopeeItem.item_id.toString(),
        externalSku: product.sku,
        permalink: `https://shopee.com.br/product/${shopeeItem.item_id}`,
        status: "active",
      });

      console.log(
        `[ListingUseCase] Shopee listing created: ${shopeeItem.item_id}`,
      );

      return {
        success: true,
        listingId: listing.id,
        externalListingId: shopeeItem.item_id.toString(),
      };
    } catch (error) {
      console.error("[ListingUseCase] Error creating Shopee listing:", error);
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

      // Primeiro, verificar o status atual do anúncio
      try {
        const currentItem = await MLApiService.getItemDetails(
          account.accessToken,
          listing.externalListingId,
        );
        console.log(
          `[ListingUseCase] Current status of ${listing.externalListingId}: ${currentItem.status}`,
        );
      } catch (statusError) {
        console.warn(
          `[ListingUseCase] Could not get current status of ${listing.externalListingId}:`,
          statusError,
        );
      }

      // Tentar fechar anúncio no ML (itens com infrações ou em processamento podem não poder ser fechados)
      try {
        await MLApiService.updateItem(
          account.accessToken,
          listing.externalListingId,
          {
            status: "closed",
          },
        );
        console.log(
          `[ListingUseCase] ML listing ${listing.externalListingId} closed successfully`,
        );
      } catch (closeError) {
        console.warn(
          `[ListingUseCase] Could not close ML listing ${listing.externalListingId}:`,
          closeError,
        );
        // Mesmo que não consiga fechar, continua removendo o vínculo local
        // O anúncio ficará visível no ML mas não estará mais vinculado ao produto
        // Isso pode acontecer com itens que têm infrações ou estão em processamento
      }

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

import { Platform } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { ListingRepository } from "../repositories/listing.repository";
import CategoryRepository from "../repositories/category.repository";
import { MLItemCreatePayload } from "../types/ml-api.types";
import { ShopeeItemCreatePayload } from "../types/shopee-api.types";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import { ML_CATEGORY_OPTIONS } from "../../lib/product-parser";
import { AccountStatus } from "@prisma/client";

export interface CreateListingResult {
  success: boolean;
  listingId?: string;
  externalListingId?: string;
  permalink?: string;
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
      let account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        Platform.MERCADO_LIVRE,
      );

      if (!account || !account.accessToken) {
        return {
          success: false,
          error: "Conta do Mercado Livre não conectada ou sem credenciais",
        };
      }

      // Verificar se token expirou e tentar renovação automática (melhor experiência para o usuário)
      const now = new Date();
      if (account.expiresAt < now) {
        try {
          console.debug(
            `[ListingUseCase] ML token expired for account ${account.id}, attempting refresh`,
          );
          const refreshed = await MLOAuthService.refreshAccessToken(
            account.refreshToken,
          );

          console.debug(
            `[ListingUseCase] ML token refresh returned, updating DB tokens`,
          );
          const updated = await MarketplaceRepository.updateTokens(account.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          });

          // usar tokens renovados
          account = updated as any;
          console.debug(
            `[ListingUseCase] Account tokens updated, using accessToken=${account.accessToken}`,
          );
        } catch (refreshErr) {
          // marcar conta como erro e informar usuário para reconectar
          await MarketplaceRepository.updateStatus(
            account.id,
            AccountStatus.ERROR,
          );
          console.warn(
            `[ListingUseCase] Failed to refresh token for account ${account.id}:`,
            refreshErr?.message || refreshErr,
          );
          return {
            success: false,
            error:
              "Conta do Mercado Livre expirou ou token inválido — reconecte a conta",
          };
        }
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

      // Resolve categoryId: accept a validated external ML id OR map an internal ML_CATALOG id -> externalId
      let resolvedCategoryId: string | undefined;
      if (categoryId) {
        // Distinguish between a likely external ML id (alphanumeric only) and internal ML_CATALOG ids (contain hyphen or other chars).
        const looksLikeExternalId = /^[A-Za-z0-9]+$/.test(categoryId);

        if (looksLikeExternalId) {
          // Caller provided an *external-like* id — accept only if present in DB (prevents using synthetic/internal ids stored via fallback sync)
          let fromDb = null;
          try {
            fromDb = await CategoryRepository.findByExternalId(categoryId);
          } catch (e) {
            fromDb = null;
          }

          if (fromDb) {
            resolvedCategoryId = categoryId; // already an external id
          } else {
            // Not found in DB — do not assume it's valid for ML; leave undefined to use fallback later
            resolvedCategoryId = undefined;
            console.warn(
              `[ListingUseCase] Provided external-like categoryId='${categoryId}' not found in DB; will attempt resolution/fallback`,
            );
          }
        } else {
          // Treat categoryId as internal ML_CATALOG id and resolve it via ML_CATEGORY_OPTIONS -> DB fullPath lookup / on-demand sync
          const child = ML_CATEGORY_OPTIONS.find((c) => c.id === categoryId);
          if (child) {
            let found = null;
            try {
              found = await CategoryRepository.findByFullPath(child.value);
            } catch (e) {
              found = null;
            }

            if (!found) {
              try {
                const { SyncUseCase } = await import("./sync.usercase");
                await SyncUseCase.syncMLCategories(userId, "MLB");
                try {
                  found = await CategoryRepository.findByFullPath(child.value);
                } catch (e2) {
                  found = null;
                }
              } catch (syncErr) {
                console.warn(
                  "[ListingUseCase] on-demand ML category sync failed:",
                  syncErr?.message || syncErr,
                );
              }
            }

            if (found && /^[A-Za-z0-9]+$/.test(found.externalId || "")) {
              // Only accept DB externalId values that look like real ML external ids (alphanumeric)
              resolvedCategoryId = found.externalId;
            } else {
              // If DB contains a synthetic/hyphenated 'externalId' (e.g. from static ML_CATALOG fallback), treat as unresolved
              resolvedCategoryId = undefined;
              console.warn(
                `[ListingUseCase] DB mapping for '${child.value}' contains invalid externalId='${found?.externalId}'; ignoring and using fallback category for ML payload`,
              );
            }
          } else {
            // Last-resort: the caller may have provided a fullPath string — try lookup by fullPath
            const found2 = await CategoryRepository.findByFullPath(
              categoryId,
            ).catch(() => null);
            if (found2 && /^[A-Za-z0-9]+$/.test(found2.externalId || "")) {
              resolvedCategoryId = found2.externalId;
            } else {
              resolvedCategoryId = undefined;
              console.warn(
                `[ListingUseCase] DB mapping for fullPath='${categoryId}' contains invalid externalId='${found2?.externalId}'; using fallback category for ML payload`,
              );
            }
          }
        }
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
        category_id: resolvedCategoryId || "MLB271107", // Usar categoria resolvida ou padrão
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

      // Include shipping dimensions when available (cm / kg)
      if (
        product.heightCm ||
        product.widthCm ||
        product.lengthCm ||
        product.weightKg
      ) {
        payload.shipping = {
          dimensions: {
            height: product.heightCm ?? undefined,
            width: product.widthCm ?? undefined,
            length: product.lengthCm ?? undefined,
            weight: product.weightKg ?? undefined,
          },
        };
      }

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

      // Envolver createItem para tratar erros específicos do ML (ex: seller.unable_to_list)
      let mlItem: any;
      try {
        mlItem = await MLApiService.createItem(account.accessToken, payload);
        console.log(
          `[ListingUseCase] ML response:`,
          JSON.stringify(mlItem, null, 2),
        );
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Caso conhecido: vendedor está impedido de anunciar (restrição do ML)
        if (
          errMsg.includes("seller.unable_to_list") ||
          errMsg.includes("User is unable to list")
        ) {
          // marcar conta como ERROR para evitar novas tentativas automáticas
          await MarketplaceRepository.updateStatus(account.id, AccountStatus.ERROR);

          // registrar log do sistema com detalhes do erro ML
          try {
            await SystemLogService.logError(
              "CREATE_LISTING",
              `Falha ao criar anúncio no ML: ${errMsg}`,
              {
                userId,
                resource: "MarketplaceAccount",
                resourceId: account.id,
                details: { mlError: errMsg },
              },
            );
          } catch (logErr) {
            console.error(
              "[ListingUseCase] Failed to record system log for ML restriction:",
              logErr,
            );
          }

          return {
            success: false,
            error:
              "Conta do Mercado Livre com restrição — impossível criar anúncios. Verifique o Seller Center do Mercado Livre.",
          };
        }

        // Repropagar erro desconhecido para o catch externo
        throw err;
      }

      // 4.1. Após criar o item no ML, enviar a descrição completa (se existir)
      // usando a API de update (ML separa criação e conteúdo/description em endpoints diferentes).
      if (product.description) {
        try {
          const mlDescription = this.buildMLDescription(product);
          await MLApiService.updateItem(account.accessToken, mlItem.id, {
            description: mlDescription,
          });
          console.log("[ListingUseCase] ML item description updated");
        } catch (err) {
          // Log e continuar — não falhar a criação do anúncio apenas por falha na descrição
          console.error(
            "[ListingUseCase] Failed to update ML item description:",
            err,
          );
        }
      }

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
        permalink: mlItem.permalink,
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

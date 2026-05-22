import {
  ProductFilterOptions,
  Product,
  ProductCreate,
  ProductListFilters,
  ProductUpdate,
  ProductUpdateResult,
  ProductRepository,
} from "../interfaces/product.interface";
import { ProductRepositoryPrisma } from "../repositories/product.repository";
import { SyncUseCase } from "../marketplaces/usecases/sync.usercase";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { SystemLogService } from "../services/system-log.service";
import { Platform } from "@prisma/client";
import {
  UserRepository,
  UserRepositoryPrisma,
} from "../repositories/user.repository";
import prisma from "../lib/prisma";
import { parseTitleToFields } from "../lib/product-parser";
import { getVehicleBrands } from "../lib/vehicle-catalog";
import { maskCorruptVehicleCategoriesInProducts } from "../marketplaces/services/category-resolution.service";

export class ProductUseCase {
  private productRepository: ProductRepository;
  private userRepository: UserRepository;
  constructor() {
    this.productRepository = new ProductRepositoryPrisma();
    this.userRepository = new UserRepositoryPrisma();
  }

  async create(productData: ProductCreate): Promise<Product> {
    if (!productData.userId) {
      throw new Error("Usuário não encontrado");
    }

    // Parallel: fetch user + check SKU uniqueness
    const [user, existsProduct] = await Promise.all([
      this.userRepository.findById(productData.userId),
      this.productRepository.findBySku(productData.sku, productData.userId),
    ]);

    if (!user) {
      throw new Error("Usuário não encontrado");
    }

    if (existsProduct) {
      throw new Error("Produto com esse sku já existe");
    }

    // Se descrição não foi fornecida, usar a padrão do usuário
    if (!productData.description && user.defaultProductDescription) {
      productData.description = user.defaultProductDescription;
    }

    // Fallback: se campos de marca/modelo/ano/categoria estão ausentes, tentar extrair do nome do produto
    try {
      const detected = parseTitleToFields(productData.name);
      if (!productData.brand && detected.brand)
        productData.brand = detected.brand;
      if (!productData.model && detected.model)
        productData.model = detected.model;
      if (!productData.year && detected.year) productData.year = detected.year;
      if (!productData.category && detected.category)
        productData.category = detected.category;
    } catch (err) {
      // Não falhar a criação por causa da heurística
      console.error("Erro ao extrair campos do título:", err);
    }

    // Persistência transacional única: o repositório grava produto + compatibilidades
    // no mesmo prisma.product.create (nested write). Não duplicar aqui.
    return this.productRepository.create(productData);
  }

  async getDetail(id: string, userId: string) {
    const repo = this.productRepository as ProductRepositoryPrisma;
    const result = await repo.findByIdDetailed(id, userId);
    if (result) {
      await maskCorruptVehicleCategoriesInProducts([result as any]);
      // findByIdDetailed retorna { product, productLocation, ... } — o locationId
      // está em result.product, então enriquecemos esse objeto (não o wrapper).
      if ((result as any).product) {
        await this.enrichLocationFullPaths([(result as any).product], userId);
      }
    }
    return result;
  }

  async listProducts(
    options: ProductListFilters & { userId: string },
  ): Promise<{ products: Product[]; total: number; totalPages: number }> {
    const { userId, ...rest } = options;
    const data = await this.productRepository.findAll(rest, userId);
    await maskCorruptVehicleCategoriesInProducts(data.products as any);
    await this.enrichLocationFullPaths(data.products, userId);
    return {
      ...data,
      totalPages: Math.ceil(data.total / (options?.limit || 10)),
    };
  }

  /**
   * Anexa `locationPath` (campo SOMENTE-LEITURA de exibição) com o CAMINHO
   * COMPLETO da localização ("Galpão 1 > Andar 1 > Caixa 212"), caminhando a
   * cadeia de `parentId`. NÃO toca em `Product.location` (campo escalar que os
   * formulários de edição/criação leem e gravam — mexer ali causaria regressão).
   *
   * Motivo: a query de produtos não traz os ancestrais e o endpoint
   * /locations/select só retorna raízes + 1 nível (não os leaves profundos onde
   * os produtos ficam). Aqui carregamos as localizações do user uma vez
   * (id, code, parentId) e montamos o path — funciona para qualquer profundidade.
   */
  private async enrichLocationFullPaths(
    products: Product[],
    userId: string,
  ): Promise<void> {
    const hasLocation = products.some((p) => (p as any).locationId);
    if (!hasLocation) return;

    const locs = await prisma.location.findMany({
      where: { userId },
      select: { id: true, code: true, parentId: true },
    });
    if (locs.length === 0) return;

    const byId = new Map(locs.map((l) => [l.id, l]));
    const pathCache = new Map<string, string>();
    const buildPath = (id: string): string => {
      const cached = pathCache.get(id);
      if (cached !== undefined) return cached;
      const parts: string[] = [];
      let cur: string | null = id;
      let guard = 0;
      while (cur && guard++ < 25) {
        const node = byId.get(cur);
        if (!node) break;
        parts.unshift(node.code);
        cur = node.parentId;
      }
      const path = parts.join(" > ");
      pathCache.set(id, path);
      return path;
    };

    for (const p of products) {
      const locId = (p as any).locationId as string | null | undefined;
      if (!locId) continue;
      const fullPath = buildPath(locId);
      // campo de EXIBIÇÃO separado; nunca sobrescreve o escalar editável `location`
      if (fullPath) (p as any).locationPath = fullPath;
    }
  }

  async getFilterOptions(userId: string): Promise<ProductFilterOptions> {
    const publishedCategories =
      await this.productRepository.findPublishedCategories(userId);

    return {
      brands: getVehicleBrands(),
      publishedCategories,
    };
  }

  async delete(
    id: string,
    userId?: string,
  ): Promise<{
    success: boolean;
    message: string;
    listingResults?: Array<{
      externalListingId: string;
      closed: boolean;
      error?: string;
    }>;
  }> {
    try {
      // Before deleting the product, remove all associated marketplace listings (ML + Shopee)
      const listings = await this.getProductListings(id);

      // Close all listings in parallel for speed
      const listingResults = await Promise.all(
        listings.map(async (listing) => {
          const result = await ListingUseCase.removeListing(listing.id);
          return {
            externalListingId: listing.externalListingId,
            closed: result.success,
            error: result.error,
          };
        }),
      );

      await this.productRepository.delete(id, userId);

      const failedClosures = listingResults.filter((r) => !r.closed);
      if (failedClosures.length > 0) {
        return {
          success: true,
          message: `Produto excluído. ${failedClosures.length} anúncio(s) não puderam ser fechados no marketplace.`,
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

  /**
   * Pausa ou reativa todos os anúncios publicados de um produto em paralelo.
   * Espelha o fluxo de `delete()`: busca os listings, itera com Promise.all
   * chamando `ListingUseCase.updateListingStatus`, e agrega os resultados.
   * NÃO toca o ProductRepository — só os anúncios.
   *
   * Listings PENDING_ (ainda em publicação) e sem externalListingId são
   * filtrados antes do round-trip — o updateListingStatus tambem rejeita,
   * mas evitamos N chamadas desnecessárias.
   *
   * Idempotência herdada de updateListingStatus: anúncios já no estado
   * desejado são contados em `alreadyInState` sem hit em ML/Shopee.
   */
  async pauseListings(
    productId: string,
    userId: string,
    status: "active" | "paused",
  ): Promise<{
    success: boolean;
    message: string;
    listingResults: Array<{
      externalListingId: string;
      platform: Platform | null;
      paused: boolean;
      alreadyInState: boolean;
      error?: string;
    }>;
  }> {
    try {
      const product = await this.productRepository.findById(productId, userId);
      if (!product) {
        return {
          success: false,
          message: "Produto não encontrado",
          listingResults: [],
        };
      }

      const listings = await this.getProductListings(productId);
      const publishable = listings.filter(
        (l) =>
          l.externalListingId && !l.externalListingId.startsWith("PENDING_"),
      );

      if (publishable.length === 0) {
        return {
          success: true,
          message: "Nenhum anúncio publicado para alterar.",
          listingResults: [],
        };
      }

      const listingResults = await Promise.all(
        publishable.map(async (listing) => {
          const result = await ListingUseCase.updateListingStatus(
            listing.id,
            userId,
            status,
          );
          return {
            externalListingId: listing.externalListingId,
            platform: listing.marketplaceAccount?.platform ?? null,
            paused: result.success,
            alreadyInState: result.alreadyInState ?? false,
            error: result.error,
          };
        }),
      );

      const changed = listingResults.filter(
        (r) => r.paused && !r.alreadyInState,
      ).length;
      const noop = listingResults.filter((r) => r.alreadyInState).length;
      const failed = listingResults.filter((r) => !r.paused);

      const verbPast = status === "paused" ? "pausado(s)" : "reativado(s)";
      let message: string;
      if (failed.length === 0 && noop === 0) {
        message = `${changed} anúncio(s) ${verbPast}.`;
      } else if (failed.length === 0) {
        message = `${changed} ${verbPast}, ${noop} já estava(m) no estado desejado.`;
      } else if (changed === 0 && noop === 0) {
        message = `Nenhum anúncio foi alterado: ${failed.length} falha(s).`;
      } else {
        message = `${changed} alterado(s), ${noop} já estava(m), ${failed.length} falha(s).`;
      }

      return {
        success: failed.length < listingResults.length,
        message,
        listingResults,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Erro ao alterar status dos anúncios",
        listingResults: [],
      };
    }
  }

  async update(
    id: string,
    data: ProductUpdate,
    userId?: string,
  ): Promise<ProductUpdateResult> {
    const product = await this.productRepository.findById(id, userId);
    if (!product) {
      throw new Error("Produto não encontrado");
    }

    const updated = await this.productRepository.update(id, data, userId);

    // Limpa overrides dos anúncios para os campos que o usuário editou no
    // produto. Sem isso, anúncios com priceOverride (criados via "Editar
    // anúncio individual") ignorariam a nova edição porque o re-sync
    // aplica override antes de enviar pro ML/Shopee.
    // Estratégia: edição no produto = "produto vira fonte da verdade" para
    // o campo editado. Outros campos com override permanecem intactos.
    await this.clearOverridesForEditedFields(id, product, data);

    // Run stock log + marketplace sync in parallel (both are independent)
    const stockLogPromise = (async () => {
      try {
        if (data.stock !== undefined && data.stock !== product.stock) {
          await prisma.stockLog.create({
            data: {
              productId: id,
              change: data.stock - product.stock,
              reason: "Manual update",
              previousStock: product.stock,
              newStock: data.stock,
            },
          });
        }
      } catch (error) {
        console.error("Erro ao registrar stock log no update manual:", error);
      }
    })();

    const syncPromise = (async () => {
      try {
        const results = await this.syncProductListings(updated);
        if (results && results.length > 0) {
          return {
            totalListings: results.length,
            successful: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            results,
          };
        }
        return undefined;
      } catch (error) {
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
        return undefined;
      }
    })();

    const [, syncResults] = await Promise.all([stockLogPromise, syncPromise]);

    return {
      product: updated,
      syncResults,
    };
  }

  /**
   * Limpa overrides dos ProductListings vinculados a este produto APENAS
   * para os campos que o usuário editou neste update. Mantém overrides dos
   * outros campos para preservar customizações que ele não tocou.
   *
   * Decisão de design: edição no produto vira fonte da verdade para o
   * campo editado. Sem isso, anúncios com priceOverride (criados via
   * "Editar anúncio individual") ignoram a nova edição.
   *
   * Não faz round-trip ao ML/Shopee — a propagação real acontece em
   * `syncProductListings` chamado logo depois.
   */
  private async clearOverridesForEditedFields(
    productId: string,
    oldProduct: Product,
    data: ProductUpdate,
  ): Promise<void> {
    const clearOverrides: Record<string, null> = {};

    const stringChanged = (
      newVal: string | null | undefined,
      oldVal: string | null | undefined,
    ) =>
      newVal !== undefined &&
      (newVal ?? null) !== ((oldVal ?? null) as string | null);

    const numChanged = (
      newVal: number | null | undefined,
      oldVal: unknown,
    ) => {
      if (newVal === undefined) return false;
      const oldNum =
        typeof oldVal === "number"
          ? oldVal
          : oldVal && typeof oldVal === "object" && "toNumber" in (oldVal as object)
            ? (oldVal as { toNumber(): number }).toNumber()
            : oldVal == null
              ? null
              : Number(oldVal);
      return Number(newVal) !== oldNum;
    };

    const jsonChanged = (newVal: unknown, oldVal: unknown) => {
      if (newVal === undefined) return false;
      try {
        return JSON.stringify(newVal ?? null) !== JSON.stringify(oldVal ?? null);
      } catch {
        return true;
      }
    };

    if (stringChanged(data.name, oldProduct.name))
      clearOverrides.titleOverride = null;
    if (stringChanged(data.description, oldProduct.description))
      clearOverrides.descriptionOverride = null;
    if (numChanged(data.price, (oldProduct as { price?: unknown }).price))
      clearOverrides.priceOverride = null;
    if (stringChanged(data.brand, oldProduct.brand))
      clearOverrides.brandOverride = null;
    if (stringChanged(data.model, oldProduct.model))
      clearOverrides.modelOverride = null;
    if (stringChanged(data.year, oldProduct.year))
      clearOverrides.yearOverride = null;
    if (stringChanged(data.version, oldProduct.version))
      clearOverrides.versionOverride = null;
    if (stringChanged(data.category, oldProduct.category))
      clearOverrides.categoryOverride = null;
    const newMlCategory = data.mlCategoryId ?? data.mlCategory;
    const oldMlCategory =
      (oldProduct as { mlCategoryId?: string | null }).mlCategoryId ??
      (oldProduct as { mlCategory?: string | null }).mlCategory;
    if (stringChanged(newMlCategory, oldMlCategory))
      clearOverrides.mlCategoryOverride = null;
    if (
      stringChanged(
        data.shopeeCategoryId,
        (oldProduct as { shopeeCategoryId?: string | null }).shopeeCategoryId,
      )
    )
      clearOverrides.shopeeCategoryOverride = null;
    if (stringChanged(data.partNumber, oldProduct.partNumber))
      clearOverrides.partNumberOverride = null;
    if (stringChanged(data.quality, oldProduct.quality))
      clearOverrides.qualityOverride = null;
    if (numChanged(data.heightCm, oldProduct.heightCm))
      clearOverrides.heightCmOverride = null;
    if (numChanged(data.widthCm, oldProduct.widthCm))
      clearOverrides.widthCmOverride = null;
    if (numChanged(data.lengthCm, oldProduct.lengthCm))
      clearOverrides.lengthCmOverride = null;
    if (numChanged(data.weightKg, oldProduct.weightKg))
      clearOverrides.weightKgOverride = null;
    if (
      jsonChanged(
        data.imageUrls,
        (oldProduct as { imageUrls?: unknown }).imageUrls,
      )
    )
      clearOverrides.imageUrlsOverride = null;
    if (jsonChanged(data.attributes, oldProduct.attributes))
      clearOverrides.attributesOverride = null;
    if (stringChanged(data.sourceVehicle, oldProduct.sourceVehicle))
      clearOverrides.sourceVehicleOverride = null;

    if (Object.keys(clearOverrides).length === 0) return;

    try {
      const result = await prisma.productListing.updateMany({
        where: { productId },
        data: clearOverrides as Record<string, null>,
      });
      if (result.count > 0) {
        console.log(
          `[ProductUseCase] Cleared ${Object.keys(clearOverrides).join(",")} override(s) on ${result.count} listing(s) of product ${productId}`,
        );
      }
    } catch (error) {
      console.error(
        `[ProductUseCase] Failed to clear overrides for product ${productId}:`,
        error,
      );
      // Não bloqueia o update do produto — overrides desatualizados são
      // só uma inconsistência cosmética; o re-sync vai usar effectiveProduct
      // baseado nesses overrides até a próxima edição.
    }
  }

  /**
   * Gera o próximo SKU disponível
   * Formato: 001, 002, etc. (continua a partir dos SKUs PROD-XXX legados)
   */
  async getNextSku(userId: string): Promise<string> {
    const maxNumber = await this.productRepository.getMaxSkuNumber(userId);
    const nextNumber = maxNumber + 1;
    return nextNumber.toString().padStart(3, "0");
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

      // Sincronizar cada anúncio em paralelo
      const results = await Promise.all(
        listings.map(async (listing) => {
          try {
            console.log(
              `[SYNC] Sincronizando anúncio ${listing.externalListingId} da conta ${listing.marketplaceAccountId}`,
            );
            return await SyncUseCase.syncProductData(
              product.id,
              listing.externalListingId,
              listing.marketplaceAccountId,
            );
          } catch (error) {
            console.error(
              `Erro ao sincronizar anúncio ${listing.externalListingId}:`,
              error,
            );
            return {
              success: false,
              productId: product.id,
              externalListingId: listing.externalListingId,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      return results;
    } catch (error) {
      console.error("Erro ao buscar anúncios do produto:", error);
      throw error;
    }
  }

  /**
   * Busca todos os anúncios vinculados a um produto
   * Only selects fields needed for sync operations
   */
  private async getProductListings(productId: string) {
    try {
      return await prisma.productListing.findMany({
        where: { productId },
        select: {
          id: true,
          externalListingId: true,
          marketplaceAccountId: true,
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accessToken: true,
              refreshToken: true,
              expiresAt: true,
              externalUserId: true,
              userId: true,
            },
          },
        },
      });
    } catch (error) {
      console.error("Erro ao buscar anúncios do produto:", error);
      throw error;
    }
  }
}

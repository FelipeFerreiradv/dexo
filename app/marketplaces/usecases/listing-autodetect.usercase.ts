import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { normalizeSku } from "@/app/lib/sku";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { ListingRepository } from "../repositories/listing.repository";
import { SyncUseCase } from "./sync.usercase";
import { MLItemDetails } from "../types/ml-api.types";
import { ShopeeItem } from "../types/shopee-api.types";

/**
 * Formato comum para o qual ML e Shopee normalizam um anúncio antes de chamar o
 * núcleo de auto-detecção. Mantém o núcleo agnóstico de plataforma.
 */
export interface NormalizedMarketplaceItem {
  platform: Platform;
  account: { id: string; userId: string };
  externalListingId: string; // ML item.id | String(Shopee item_id)
  rawSku: string | null; // SKU do vendedor, antes de normalizar
  title: string;
  price: number;
  stock: number;
  status: string;
  permalink: string | null;
  imageUrl: string | null;
  createdAt: Date; // ML date_created | Shopee create_time*1000 (informativo)
}

export type AutodetectAction =
  | "listing_exists"
  | "linked_existing_product"
  | "created_product"
  | "raced";

export interface UpsertAutodetectResult {
  action: AutodetectAction;
  productId: string | null;
}

/**
 * Núcleo da detecção automática de anúncios criados direto no marketplace.
 *
 * Recebe um item já normalizado e, de forma idempotente e anti-duplicação, cria
 * na Dexo o `Product` vinculado (`ProductListing`) à conta de origem:
 *   1. se o listing já existe → no-op;
 *   2. se o SKU casa com um produto do dono → só vincula (não duplica);
 *   3. senão → cria o produto com flag de origem;
 *   4. cria o listing via upsert (à prova de corrida na unique key).
 *
 * NÃO contém regra de "só novos" — o gate de baseline (date_created/create_time
 * >= autoImportListingsSince) é responsabilidade de quem chama (webhook ML /
 * polling Shopee). Reaproveita `ProductUseCase.create` e `ListingRepository`.
 */
export class ListingAutodetectUseCase {
  static async upsertProductFromMarketplaceItem(
    item: NormalizedMarketplaceItem,
  ): Promise<UpsertAutodetectResult> {
    const { account, externalListingId } = item;

    // 1. Idempotência por listing: vínculo (conta, anúncio) já existe → no-op.
    // EGRESS-light: só o productId, não o Product inteiro.
    const existing = await ListingRepository.findProductIdByExternalListingId(
      account.id,
      externalListingId,
    );
    if (existing) {
      return { action: "listing_exists", productId: existing.productId };
    }

    // 2. Casa por SKU dentro do dono (mesmo critério do importMLItems).
    const normalizedSku = normalizeSku(item.rawSku);
    const matchedId = normalizedSku
      ? await this.findProductIdBySku(account.userId, normalizedSku)
      : null;

    let productId: string;
    let action: AutodetectAction;

    if (matchedId) {
      productId = matchedId;
      action = "linked_existing_product";
    } else {
      // 3. Cria o produto (caminho novo) com a flag de origem.
      const created = await this.createProductFromItem(item, normalizedSku);
      productId = created.productId;
      action = created.raced ? "raced" : "created_product";
    }

    // 4. Cria/keep do listing — upsert idempotente na unique key
    // (marketplaceAccountId, externalListingId). Corrida cai em update no-op.
    await ListingRepository.upsertAutodetectedListing({
      productId,
      marketplaceAccountId: account.id,
      externalListingId,
      externalSku: item.rawSku || undefined,
      permalink: item.permalink,
      status: item.status,
    });

    return { action, productId };
  }

  private static async findProductIdBySku(
    userId: string,
    normalizedSku: string,
  ): Promise<string | null> {
    const product = await prisma.product.findFirst({
      where: { userId, skuNormalized: normalizedSku },
      select: { id: true },
    });
    return product?.id ?? null;
  }

  private static async createProductFromItem(
    item: NormalizedMarketplaceItem,
    normalizedSku: string | null,
  ): Promise<{ productId: string; raced: boolean }> {
    const productUseCase = new ProductUseCase();
    const base = {
      userId: item.account.userId,
      name: item.title,
      stock: item.stock,
      price: item.price,
      imageUrl: item.imageUrl ?? "",
      createdFromMarketplace: true,
      originPlatform: item.platform,
    };

    try {
      const product = item.rawSku
        ? await productUseCase.create({
            ...base,
            sku: item.rawSku,
            autoSku: false,
          })
        : await productUseCase.create({ ...base, sku: "", autoSku: true });
      return { productId: product.id, raced: false };
    } catch (err) {
      // Corrida de SKU real: outro processo criou o produto entre o passo 2 e o
      // insert. O `create` lança "Produto com esse sku já existe" (via
      // @@unique([userId, sku])). Re-resolve por SKU e vincula, sem duplicar.
      if (normalizedSku && this.isDuplicateSkuError(err)) {
        const racedId = await this.findProductIdBySku(
          item.account.userId,
          normalizedSku,
        );
        if (racedId) {
          return { productId: racedId, raced: true };
        }
      }
      throw err;
    }
  }

  private static isDuplicateSkuError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /sku já existe/i.test(msg) || /unique constraint/i.test(msg);
  }

  /**
   * Normaliza um item do Mercado Livre para o formato comum. O gate de "só
   * novos" (date_created >= baseline) é aplicado por quem chama (webhook).
   */
  static normalizeMLItem(
    account: { id: string; userId: string },
    item: MLItemDetails,
  ): NormalizedMarketplaceItem {
    const imageUrl =
      item.thumbnail ||
      (Array.isArray(item.pictures) && item.pictures[0]?.url) ||
      null;

    return {
      platform: Platform.MERCADO_LIVRE,
      account,
      externalListingId: item.id,
      rawSku: SyncUseCase.extractMLItemSku(item),
      title: item.title,
      price: this.coercePrice(item.price),
      stock:
        typeof item.available_quantity === "number"
          ? item.available_quantity
          : 0,
      status: item.status,
      permalink: item.permalink || null,
      imageUrl,
      createdAt: this.parseDate(item.date_created),
    };
  }

  /**
   * Normaliza um item da Shopee (nível item) para o formato comum. O gate de
   * "só novos" (create_time >= baseline) é aplicado por quem chama (polling).
   */
  static normalizeShopeeItem(
    account: { id: string; userId: string },
    item: ShopeeItem,
  ): NormalizedMarketplaceItem {
    const priceInfo = Array.isArray(item.price_info)
      ? item.price_info[0]
      : undefined;
    const price = this.coercePrice(
      priceInfo?.current_price ?? priceInfo?.original_price ?? 0,
    );
    const imageUrl =
      (Array.isArray(item.image?.image_url_list) &&
        item.image.image_url_list[0]) ||
      null;

    return {
      platform: Platform.SHOPEE,
      account,
      externalListingId: String(item.item_id),
      rawSku: SyncUseCase.extractShopeeItemSku(item),
      title: item.item_name,
      price,
      stock: SyncUseCase.getShopeeItemAvailableStock(item),
      status: item.status,
      permalink: null,
      imageUrl,
      createdAt: new Date((item.create_time ?? 0) * 1000),
    };
  }

  private static coercePrice(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  private static parseDate(value: string | null | undefined): Date {
    if (value) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
    }
    // Fail-safe: data ilegível vira epoch 0 → reprovada por qualquer baseline.
    return new Date(0);
  }
}

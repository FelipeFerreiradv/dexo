import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { normalizeSku } from "@/app/lib/sku";
import { areTitlesSimilar } from "@/app/lib/title-similarity";
import { toFullSizeMLImage, toFullSizeMLImages } from "@/app/lib/ml-image";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { ListingRepository } from "../repositories/listing.repository";
import { SyncUseCase } from "./sync.usercase";
import { MLItemDetails } from "../types/ml-api.types";
import { ShopeeItem } from "../types/shopee-api.types";
import { MagaluSku } from "../types/magalu-api.types";

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
  imageUrl: string | null; // capa (= imageUrls[0] quando há galeria)
  /**
   * Galeria completa do anúncio, na ordem do marketplace. Opcional/aditivo:
   * chamadores antigos que não preenchem seguem funcionando (vira []).
   */
  imageUrls?: string[];
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
    const matched = normalizedSku
      ? await this.findProductBySku(account.userId, normalizedSku)
      : null;
    const matchedId = matched?.id ?? null;

    // Guarda de "SKU de caixa": só NÃO agrupa quando (a) o produto casado já tem
    // um anúncio NESTA conta (SKU reutilizado na conta) E (b) o título deste
    // anúncio é CLARAMENTE diferente do produto casado (produto distinto). Se os
    // títulos são parecidos, é o mesmo produto reanunciado → agrupa (hoje).
    // Contas diferentes com o mesmo SKU seguem agrupando (multi-conta legítimo).
    const isBoxLabel =
      matched != null &&
      (await ListingRepository.productHasListingInAccount(
        matched.id,
        account.id,
      )) &&
      !areTitlesSimilar(item.title, matched.name);

    let productId: string;
    let action: AutodetectAction;

    if (matchedId && !isBoxLabel) {
      productId = matchedId;
      action = "linked_existing_product";
    } else {
      // 3. Cria o produto (caminho novo) com a flag de origem. Box label usa
      // SKU sintético único para não colidir/re-agrupar.
      const created = await this.createProductFromItem(
        item,
        normalizedSku,
        isBoxLabel,
      );
      productId = created.productId;
      action = created.raced ? "raced" : "created_product";
    }

    // 4. Cria/keep do listing — idempotente na unique key (trata P2002 de
    // corrida no repositório, relendo o listing vencedor).
    const listing = await ListingRepository.upsertAutodetectedListing({
      productId,
      marketplaceAccountId: account.id,
      externalListingId,
      externalSku: item.rawSku || undefined,
      permalink: item.permalink,
      status: item.status,
    });

    // Corrida sem SKU: se criamos um produto novo agora mas o listing já existia
    // apontando p/ OUTRO produto (uma entrega concorrente do mesmo anúncio
    // venceu), o nosso virou órfão → remove p/ não duplicar no catálogo.
    if (
      action === "created_product" &&
      listing &&
      listing.productId !== productId
    ) {
      await prisma.product
        .delete({ where: { id: productId } })
        .catch((e) =>
          console.error(
            `[autodetect] Órfão não removido (product ${productId}):`,
            e instanceof Error ? e.message : e,
          ),
        );
      return { action: "raced", productId: listing.productId };
    }

    return { action, productId };
  }

  private static async findProductBySku(
    userId: string,
    normalizedSku: string,
  ): Promise<{ id: string; name: string } | null> {
    const product = await prisma.product.findFirst({
      where: { userId, skuNormalized: normalizedSku },
      select: { id: true, name: true },
    });
    return product ?? null;
  }

  private static async createProductFromItem(
    item: NormalizedMarketplaceItem,
    normalizedSku: string | null,
    isBoxLabel = false,
  ): Promise<{ productId: string; raced: boolean }> {
    const productUseCase = new ProductUseCase();
    const base = {
      userId: item.account.userId,
      name: item.title,
      stock: item.stock,
      price: item.price,
      imageUrl: item.imageUrl ?? "",
      // Galeria completa do anúncio (o repositório já persiste `imageUrls`).
      // Ausente => [] (comportamento anterior, zero regressão).
      imageUrls: item.imageUrls ?? [],
      createdFromMarketplace: true,
      originPlatform: item.platform,
    };

    // SKU do produto novo:
    //  - box label (SKU reutilizado em vários anúncios da conta): sintético e
    //    único por anúncio (VAAPT-<id>), para não colidir com o produto casado
    //    nem re-agrupar via o mesmo SKU;
    //  - anúncio com SKU próprio: usa o SKU do vendedor;
    //  - sem SKU: autoSku (contador sequencial).
    const syntheticSku = `VAAPT-${item.externalListingId}`;
    try {
      let product;
      if (isBoxLabel) {
        product = await productUseCase.create({
          ...base,
          sku: syntheticSku,
          autoSku: false,
        });
      } else if (item.rawSku) {
        product = await productUseCase.create({
          ...base,
          sku: item.rawSku,
          autoSku: false,
        });
      } else {
        product = await productUseCase.create({ ...base, sku: "", autoSku: true });
      }
      return { productId: product.id, raced: false };
    } catch (err) {
      if (this.isDuplicateSkuError(err)) {
        // Corrida de SKU: re-resolve pelo SKU efetivamente usado e vincula.
        // Box label re-resolve pelo sintético (único por anúncio); demais pelo
        // SKU do vendedor. Sem duplicar produto.
        const resolveKey = isBoxLabel ? normalizeSku(syntheticSku) : normalizedSku;
        if (resolveKey) {
          const raced = await this.findProductBySku(
            item.account.userId,
            resolveKey,
          );
          if (raced) {
            return { productId: raced.id, raced: true };
          }
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
    // `item.thumbnail` é a MINIATURA (-I, ~100px) — usá-la deixava a foto do
    // produto minúscula na Dexo. As `pictures[]` trazem a imagem original (-O),
    // que é o que o resto do repo consome (migrações, catálogo, backfill).
    // Importamos a GALERIA inteira, na ordem do anúncio; a capa é a primeira.
    // O thumbnail vira só último recurso, já normalizado p/ tamanho original.
    const pictures = Array.isArray(item.pictures) ? item.pictures : [];
    const imageUrls = toFullSizeMLImages(
      pictures.map((p) => p?.secure_url || p?.url),
    );
    const imageUrl = imageUrls[0] ?? toFullSizeMLImage(item.thumbnail) ?? null;

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
      imageUrls,
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
    // Galeria completa do anúncio Shopee (já vem em tamanho cheio no CDN).
    const imageUrls = Array.isArray(item.image?.image_url_list)
      ? item.image.image_url_list.filter(
          (u): u is string => typeof u === "string" && u.trim().length > 0,
        )
      : [];
    const imageUrl = imageUrls[0] ?? null;

    // A API da Shopee devolve `item_status` (não `status`); NORMAL/ausente →
    // "active" (mesma convenção dos demais listings). Sem isso o status ia
    // undefined e o upsert do listing falhava ("Argument status is missing") —
    // o autodetect criava o produto mas NÃO o listing (venda não baixava estoque).
    const rawStatus = (item as { item_status?: string }).item_status ?? item.status;
    const listingStatus = rawStatus && rawStatus !== "NORMAL" ? rawStatus : "active";

    return {
      platform: Platform.SHOPEE,
      account,
      externalListingId: String(item.item_id),
      rawSku: SyncUseCase.extractShopeeItemSku(item),
      title: item.item_name,
      price,
      stock: SyncUseCase.getShopeeItemAvailableStock(item),
      status: listingStatus,
      permalink: null,
      imageUrl,
      imageUrls,
      createdAt: new Date((item.create_time ?? 0) * 1000),
    };
  }

  /**
   * Normaliza um SKU da Magalu (GET /portfolios/skus[/{id}]) para o formato
   * comum. A Magalu é keyed pelo SKU (= externalListingId). Preço/estoque vêm em
   * endpoints separados (prices/stocks) e podem NÃO vir no SKU → caem em 0 (o
   * lojista completa; o sync reconcilia). O gate "só novos" (created_at >=
   * baseline) é aplicado por quem chama (polling).
   */
  static normalizeMagaluItem(
    account: { id: string; userId: string },
    sku: MagaluSku,
  ): NormalizedMarketplaceItem {
    const rawSku =
      (sku.seller_sku as string) ||
      (sku.sku as string) ||
      (sku.code as string) ||
      null;
    // A identidade de um SKU na Magalu é o PRÓPRIO SKU do seller (= externalSku
    // no create e chave de stock/price/patch). Por isso o SKU vem ANTES do `id`
    // interno — assim create-time e poll-time gravam a MESMA chave e o núcleo
    // (idempotente por externalListingId) não duplica o vínculo.
    const externalListingId = String(rawSku ?? sku.id ?? "");
    // imagens: [{ reference, type }] (defensivo — shape do type é aberto).
    // Importa a galeria inteira; a capa é a primeira referência válida.
    const images = (sku as { images?: Array<{ reference?: string }> }).images;
    const imageUrls = Array.isArray(images)
      ? images
          .map((i) => i?.reference)
          .filter(
            (u): u is string => typeof u === "string" && u.trim().length > 0,
          )
      : [];
    const imageUrl = imageUrls[0] ?? null;
    // url pública: permalink | url | url_marketplace[0].url.
    const urlMarketplace = (
      sku as { url_marketplace?: Array<{ url?: string }> }
    ).url_marketplace;
    const permalink =
      (sku.permalink as string) ||
      (sku.url as string) ||
      (Array.isArray(urlMarketplace) && urlMarketplace[0]?.url) ||
      null;
    const stock =
      typeof sku.available_quantity === "number"
        ? sku.available_quantity
        : typeof sku.quantity === "number"
          ? sku.quantity
          : 0;

    return {
      platform: Platform.MAGALU,
      account,
      externalListingId,
      rawSku,
      title: (sku.title as string) || rawSku || externalListingId,
      price: this.coercePrice(sku.price),
      stock,
      status: (sku.status as string) || "active",
      permalink,
      imageUrl,
      imageUrls,
      createdAt: this.parseDate(
        (sku as { created_at?: string }).created_at,
      ),
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

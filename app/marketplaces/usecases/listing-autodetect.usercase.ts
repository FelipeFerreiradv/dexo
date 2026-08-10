import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { normalizeSku } from "@/app/lib/sku";
import { areTitlesSimilar } from "@/app/lib/title-similarity";
import { toFullSizeMLImage, toFullSizeMLImages } from "@/app/lib/ml-image";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import { User } from "@/app/interfaces/user.interface";
import { ListingRepository } from "../repositories/listing.repository";
import { SyncUseCase } from "./sync.usercase";
import { MLItemDetails } from "../types/ml-api.types";
import { ShopeeItem } from "../types/shopee-api.types";
import { MagaluSku } from "../types/magalu-api.types";
import { FacebookCatalogProduct } from "../types/facebook-api.types";

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
 * Cache OPCIONAL para o "Importar anúncios" (importação em LOTE). Os
 * importadores já pré-carregam em lote tudo o que os passos 1-3 do núcleo
 * consultariam por item (listings existentes, produtos por skuNormalized e a
 * guarda de box-label) — sem o cache, cada item novo re-consultava 2-3 vezes
 * o que o lote já sabia. WRITE-THROUGH obrigatório: o núcleo registra aqui
 * cada produto/listing que cria, para o item SEGUINTE do mesmo lote com o
 * MESMO SKU enxergá-lo (no caminho sem cache é a query fresca que garante
 * isso). Backstops de duplicação continuam intocados: unique (userId, sku) +
 * P2002 re-resolve no create, e upsert na unique (conta, externalListingId).
 * Webhook/pollings NÃO passam cache → caminho fresco de hoje, byte a byte.
 */
export interface AutodetectImportCache {
  /** skuNormalized → produto do dono (pré-carregado + creates do lote). */
  productsBySku: Map<string, { id: string; name: string }>;
  /** productIds que JÁ têm anúncio NESTA conta (guarda de box-label). */
  productIdsWithListing: Set<string>;
  /**
   * externalListingIds do lote que JÁ têm listing nesta conta. O preload
   * cobre TODOS os ids do lote — ausente do Set = inexistente garantido.
   */
  knownExternalListingIds: Set<string>;
  /**
   * Dono do lote, resolvido UMA vez (lazy, no 1º produto criado) e reusado por
   * todos os creates — evita um findById(userId) por produto novo. Repassado a
   * ProductUseCase.create como `preloadedUser`. undefined = ainda não resolvido.
   */
  owner?: User | null;
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
    cache?: AutodetectImportCache,
  ): Promise<UpsertAutodetectResult> {
    const { account, externalListingId } = item;

    // 1. Idempotência por listing: vínculo (conta, anúncio) já existe → no-op.
    // EGRESS-light: só o productId, não o Product inteiro. Com cache (lote):
    // ausente do Set = inexistente garantido, sem query; presente → confere
    // fresco como sempre. Corrida com webhook no meio do lote degrada para o
    // upsert idempotente + limpeza de órfão abaixo (mesmo caminho de hoje).
    const existing =
      cache && !cache.knownExternalListingIds.has(externalListingId)
        ? null
        : await ListingRepository.findProductIdByExternalListingId(
            account.id,
            externalListingId,
          );
    if (existing) {
      return { action: "listing_exists", productId: existing.productId };
    }

    // 2. Casa por SKU dentro do dono (mesmo critério do importMLItems). Com
    // cache: o preload cobre todos os SKUs do lote e os creates entram via
    // write-through — hit/miss equivalem à query fresca.
    const normalizedSku = normalizeSku(item.rawSku);
    const matched = normalizedSku
      ? cache
        ? (cache.productsBySku.get(normalizedSku) ?? null)
        : await this.findProductBySku(account.userId, normalizedSku)
      : null;
    const matchedId = matched?.id ?? null;

    // Guarda de "SKU de caixa": só NÃO agrupa quando (a) o produto casado já tem
    // um anúncio NESTA conta (SKU reutilizado na conta) E (b) o título deste
    // anúncio é CLARAMENTE diferente do produto casado (produto distinto). Se os
    // títulos são parecidos, é o mesmo produto reanunciado → agrupa (hoje).
    // Contas diferentes com o mesmo SKU seguem agrupando (multi-conta legítimo).
    const isBoxLabel =
      matched != null &&
      (cache
        ? cache.productIdsWithListing.has(matched.id)
        : await ListingRepository.productHasListingInAccount(
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
        cache,
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

    // WRITE-THROUGH do listing recém-criado/mantido: o item seguinte do lote
    // com o mesmo produto/anúncio precisa enxergar o estado novo.
    if (cache) {
      cache.knownExternalListingIds.add(externalListingId);
      cache.productIdsWithListing.add(listing?.productId ?? productId);
    }

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
      // Write-through com o VENCEDOR da corrida (nunca o órfão removido).
      if (cache && normalizedSku && !isBoxLabel) {
        cache.productsBySku.set(normalizedSku, {
          id: listing.productId,
          name: item.title,
        });
      }
      return { action: "raced", productId: listing.productId };
    }

    // WRITE-THROUGH do produto criado (ou vencedor de corrida de SKU): itens
    // SEGUINTES do lote com o MESMO SKU casam com ele em vez de recriar — no
    // caminho sem cache é a query fresca por item que dá essa garantia. Box
    // label fica de fora (SKU sintético único por anúncio, ninguém casa nele).
    if (
      cache &&
      normalizedSku &&
      !isBoxLabel &&
      action !== "linked_existing_product"
    ) {
      cache.productsBySku.set(normalizedSku, {
        id: productId,
        name: item.title,
      });
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
    cache?: AutodetectImportCache,
  ): Promise<{ productId: string; raced: boolean }> {
    // Dono resolvido UMA vez por lote (cache.owner, lazy) e injetado no
    // ProductUseCase — evita um findById(userId) por produto criado. Sem cache
    // (webhook/polling), fica undefined e create() faz o findById como hoje.
    let preloadedUser: User | null | undefined = undefined;
    if (cache) {
      if (cache.owner === undefined) {
        cache.owner = await new UserRepositoryPrisma().findById(
          item.account.userId,
        );
      }
      preloadedUser = cache.owner;
    }
    const productUseCase = new ProductUseCase(preloadedUser);
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

  /**
   * Reconhece a colisão de identidade do produto, venha ela de onde vier:
   *  - "Produto com esse sku já existe" — o repositório traduz o P2002 da
   *    unique do SKU CRU (`userId`,`sku`);
   *  - "Unique constraint failed …" — P2002 cru, incluindo o do índice
   *    `Product_userId_skuNormalized_key` (SKU NORMALIZADO, ver
   *    docs/dedupe-sku-sql.md), que o repositório não traduz por não conhecer.
   *
   * É esse segundo caso que fecha o buraco real: "mk2-204" e "Mk2-204" são o
   * mesmo produto, mas não colidem na unique crua. Com o índice, o banco
   * rejeita e a recuperação abaixo vincula ao produto vencedor em vez de
   * duplicar — sem custar nenhuma query no caminho feliz.
   */
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

  /**
   * Normaliza um item do Catálogo Meta (GET /{catalog_id}/products) para o
   * núcleo de auto-detecção. Espelha normalizeMagaluItem: a identidade do item
   * é o `retailer_id`, que o Dexo grava = SKU (buildRetailerId) — por isso ele é
   * a chave de vínculo (externalListingId/externalSku), sem divergir do create.
   * `availability` "out of stock" ⇒ status "paused"; qualquer outro ⇒ "active".
   * A borda /products não expõe created_at confiável ⇒ createdAt = agora
   * (informativo; o vínculo é por SKU, não por data).
   */
  static normalizeFacebookItem(
    account: { id: string; userId: string },
    item: FacebookCatalogProduct,
  ): NormalizedMarketplaceItem {
    const rawSku =
      typeof item.retailer_id === "string" && item.retailer_id.trim().length > 0
        ? item.retailer_id
        : null;
    const externalListingId = String(rawSku ?? item.id ?? "");
    const imageUrl =
      typeof item.image_url === "string" && item.image_url.trim().length > 0
        ? item.image_url
        : null;
    const availability = (item.availability as string) || "in stock";
    const status = /out.?of.?stock|discontinued/i.test(availability)
      ? "paused"
      : "active";
    return {
      platform: Platform.FACEBOOK,
      account,
      externalListingId,
      rawSku,
      title: (item.name as string) || rawSku || externalListingId,
      price: this.coercePrice(item.price),
      stock: status === "paused" ? 0 : 1,
      status,
      permalink: (item.url as string) || null,
      imageUrl,
      imageUrls: imageUrl ? [imageUrl] : [],
      createdAt: new Date(),
    };
  }

  private static coercePrice(value: unknown): number {
    if (typeof value === "number") {
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }
    // A Meta devolve o preço como string "199.90 BRL" (valor + código de moeda):
    // Number("199.90 BRL") = NaN, o que zerava TODO produto importado do catálogo.
    // Extrai o número e normaliza o separador decimal (pt-BR "1.199,90" ou en).
    if (typeof value === "string") {
      const match = value.match(/-?\d[\d.,]*/);
      if (!match) return 0;
      let s = match[0];
      if (s.includes(",") && s.includes(".")) {
        // O separador decimal é o último a aparecer; o outro é de milhar.
        s =
          s.lastIndexOf(",") > s.lastIndexOf(".")
            ? s.replace(/\./g, "").replace(",", ".")
            : s.replace(/,/g, "");
      } else if (s.includes(",")) {
        s = s.replace(",", ".");
      }
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    const n = Number(value);
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

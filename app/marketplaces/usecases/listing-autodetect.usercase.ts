import { Platform, type Prisma } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { normalizeSku } from "@/app/lib/sku";
import {
  areTitlesSimilar,
  isOppositeSideOrAxis,
  oppositionReason,
} from "@/app/lib/title-similarity";
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
import { catalogIdentityEnabled } from "../lib/catalog-gallery-identity";
import { accountScopedAutodetectSku } from "../lib/autodetect-synthetic-sku";
import { CatalogIdentityService } from "../services/catalog-identity.service";

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
  | "raced"
  // O anúncio está em ListingIngestionIgnore: uma limpeza de catálogo decidiu
  // que ele NÃO pertence a este tenant (ex.: peças do pai no caso Ducelo). A
  // ingestão não cria nada — nem produto, nem listing — em nenhum caminho.
  | "ignored_by_list";

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
  /**
   * externalListingIds em ListingIngestionIgnore para (userId, platform) —
   * pré-carregado UMA vez por conta (regra R5: nunca uma query por item).
   * OPCIONAL: chamador legado sem o campo mantém o comportamento de sempre no
   * lote; o caminho sem cache (webhook, item único) consulta pontualmente.
   */
  ignoredExternalIds?: Set<string>;
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
  private static readonly IGNORE_LOOKUP_SAVEPOINT =
    "listing_ingestion_ignore_lookup";

  private static async isIgnoredInsideTransaction(
    tx: Prisma.TransactionClient,
    item: NormalizedMarketplaceItem,
  ): Promise<boolean> {
    const savepoint = this.IGNORE_LOOKUP_SAVEPOINT;

    // A criacao do savepoint fica fora do catch: se nem ela funciona, a
    // transacao nao esta em condicoes de continuar e o chamador deve abortar.
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);

    let hit: { id: string } | null;
    try {
      hit = await (tx as any).listingIngestionIgnore.findUnique({
        where: {
          userId_platform_externalListingId: {
            userId: item.account.userId,
            platform: item.platform,
            externalListingId: item.externalListingId,
          },
        },
        select: { id: true },
      });
    } catch {
      // Um erro SQL aborta a transacao PostgreSQL ate um rollback. So fazemos
      // fail-open depois de restaurar e liberar o savepoint; falha em qualquer
      // passo de recuperacao e fatal e, portanto, continua sendo propagada.
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      return false;
    }

    // Falha ao liberar o savepoint tambem denuncia uma transacao inviavel.
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return Boolean(hit);
  }

  static async upsertProductFromMarketplaceItem(
    item: NormalizedMarketplaceItem,
    cache?: AutodetectImportCache,
  ): Promise<UpsertAutodetectResult> {
    if (catalogIdentityEnabled(item)) {
      // A rolled-back transaction must not publish phantom products to a batch cache.
      const workingCache = cache
        ? {
            ...cache,
            productsBySku: new Map(cache.productsBySku),
            productIdsWithListing: new Set(cache.productIdsWithListing),
            knownExternalListingIds: new Set(cache.knownExternalListingIds),
          }
        : undefined;
      const result = await CatalogIdentityService.serialized(
        item,
        (tx, canonical, blockSkuMatch) =>
          this.upsertItem(item, workingCache, tx, canonical, blockSkuMatch),
      );
      if (cache && workingCache) {
        cache.productsBySku = workingCache.productsBySku;
        cache.productIdsWithListing = workingCache.productIdsWithListing;
        cache.knownExternalListingIds = workingCache.knownExternalListingIds;
        cache.owner = workingCache.owner;
      }
      return result;
    }
    return this.upsertItem(item, cache);
  }

  private static async upsertItem(
    item: NormalizedMarketplaceItem,
    cache?: AutodetectImportCache,
    tx?: Prisma.TransactionClient,
    canonical: { id: string; name: string } | null = null,
    blockSkuMatch = false,
  ): Promise<UpsertAutodetectResult> {
    const { account, externalListingId } = item;
    const db = tx ?? prisma;

    // 1. Idempotência por listing: vínculo (conta, anúncio) já existe → no-op.
    // EGRESS-light: só o productId, não o Product inteiro. Com cache (lote):
    // ausente do Set = inexistente garantido, sem query; presente → confere
    // fresco como sempre. Corrida com webhook no meio do lote degrada para o
    // upsert idempotente + limpeza de órfão abaixo (mesmo caminho de hoje).
    const existing = tx
      ? await tx.productListing.findUnique({
          where: {
            marketplaceAccountId_externalListingId: {
              marketplaceAccountId: account.id,
              externalListingId,
            },
          },
          select: { productId: true },
        })
      : cache && !cache.knownExternalListingIds.has(externalListingId)
        ? null
        : await ListingRepository.findProductIdByExternalListingId(
            account.id,
            externalListingId,
          );
    if (existing) {
      return { action: "listing_exists", productId: existing.productId };
    }

    // 1.5. Lista de ignorados: uma limpeza de catálogo decidiu que este
    // anúncio NÃO pertence a este tenant (caso Ducelo: peças do pai vendidas
    // pela mesma conta ML). Sem este gate, a limpeza era inútil — o MK2 limpou
    // 998 produtos e a varredura seguinte recriou 1.934 em um dia. O check
    // vem DEPOIS da idempotência de propósito: listing vivo não é afetado; a
    // lista só impede RE-CRIAÇÃO. Com cache: Set pré-carregado por conta
    // (zero query por item). Sem cache (webhook, item único): uma consulta
    // pontual na unique. Falha da consulta NUNCA bloqueia a ingestão — a
    // lista é um filtro, não um ponto único de falha.
    const ignorado = cache
      ? // Em LOTE a resposta vem SEMPRE do preload — cache legado sem o campo
        // vale "sem lista" (fail-open), nunca uma query por item (regra R5).
        (cache.ignoredExternalIds?.has(externalListingId) ?? false)
      : tx
        ? await this.isIgnoredInsideTransaction(tx, item)
        : await (async () => {
            try {
              const hit = await (db as any).listingIngestionIgnore.findUnique({
                where: {
                  userId_platform_externalListingId: {
                    userId: account.userId,
                    platform: item.platform,
                    externalListingId,
                  },
                },
                select: { id: true },
              });
              return Boolean(hit);
            } catch {
              return false;
            }
          })();
    if (ignorado) {
      return { action: "ignored_by_list", productId: null };
    }

    // 2. Casa por SKU dentro do dono (mesmo critério do importMLItems). Com
    // cache: o preload cobre todos os SKUs do lote e os creates entram via
    // write-through — hit/miss equivalem à query fresca.
    const normalizedSku = normalizeSku(item.rawSku);
    const matched =
      canonical ??
      (!blockSkuMatch && normalizedSku
        ? cache
          ? (cache.productsBySku.get(normalizedSku) ?? null)
          : await this.findProductBySku(account.userId, normalizedSku, tx)
        : null);
    const matchedId = matched?.id ?? null;

    // Um mesmo código pode ser reutilizado como rótulo de caixa, inclusive em
    // outra conta do mesmo tenant. Título claramente diferente nunca prova a
    // mesma peça física; crie uma ficha sintética até existir uma identidade de
    // galeria confirmada. Títulos parecidos continuam agrupando multi-conta.
    const hasIncompatibleTitle =
      matched != null && !areTitlesSimilar(item.title, matched.name);
    const isBoxLabel =
      hasIncompatibleTitle &&
      (cache
        ? cache.productIdsWithListing.has(matched.id)
        : tx
          ? Boolean(
              await tx.productListing.findFirst({
                where: {
                  productId: matched.id,
                  marketplaceAccountId: account.id,
                },
                select: { id: true },
              }),
            )
          : await ListingRepository.productHasListingInAccount(
              matched.id,
              account.id,
            ));

    // ⚠️⚠️ PEÇA ESPELHADA: o Jaccard aprova lado/eixo OPOSTO, então a guarda de
    // caixa acima nunca dispara nesses casos — "Amortecedor ... L/e" casa com
    // "Amortecedor ... L/d" em 1,00 porque `titleTokens` descarta tokens de 1
    // caractere. Medido em 292.014 pares de 9 clientes: 758 vínculos têm lado ou
    // eixo oposto e 485 deles (0,166%) hoje são aprovados pelo Jaccard.
    //
    // Diferente da guarda de caixa, esta NÃO exige que o produto já tenha
    // anúncio nesta conta: ligar um anúncio de peça esquerda na peça direita é
    // errado mesmo na primeira vez, e o pedido vai baixar a peça errada.
    //
    // A saída é a MESMA do box label — produto próprio com SKU sintético — o que
    // mantém o caminho de código já exercitado e reversível.
    const isMirroredPart =
      matched != null && isOppositeSideOrAxis(item.title, matched.name);
    if (isMirroredPart) {
      console.log(
        JSON.stringify({
          event: "autodetect.mirrored_part_not_linked",
          accountId: account.id,
          externalListingId,
          sku: normalizedSku,
          anuncio: item.title,
          produto: matched?.name,
          motivo: oppositionReason(item.title, matched!.name),
        }),
      );
    }

    const naoPodeLigar =
      blockSkuMatch || isBoxLabel || hasIncompatibleTitle || isMirroredPart;
    let usesSyntheticSku = naoPodeLigar;

    let productId: string;
    let action: AutodetectAction;

    if (matchedId && !naoPodeLigar) {
      productId = matchedId;
      action = "linked_existing_product";
    } else {
      // 3. Cria o produto (caminho novo) com a flag de origem. Box label usa
      // SKU sintético único para não colidir/re-agrupar.
      const created = await this.createProductFromItem(
        item,
        normalizedSku,
        naoPodeLigar,
        cache,
        tx,
      );
      productId = created.productId;
      usesSyntheticSku = created.usesSyntheticSku;
      action = created.raced ? "raced" : "created_product";
    }

    // 4. Cria/keep do listing — idempotente na unique key (trata P2002 de
    // corrida no repositório, relendo o listing vencedor).
    const listingData = {
      productId,
      marketplaceAccountId: account.id,
      externalListingId,
      externalSku: item.rawSku || undefined,
      permalink: item.permalink,
      status: item.status,
    };
    const listing = tx
      ? await ListingRepository.upsertAutodetectedListing(listingData, tx)
      : await ListingRepository.upsertAutodetectedListing(listingData);

    // WRITE-THROUGH do listing recém-criado/mantido: o item seguinte do lote
    // com o mesmo produto/anúncio precisa enxergar o estado novo.
    if (cache) {
      cache.knownExternalListingIds.add(externalListingId);
      cache.productIdsWithListing.add(listing?.productId ?? productId);
    }

    // Corrida sem SKU: se criamos um produto novo agora mas o listing já existia
    // apontando p/ OUTRO produto (uma entrega concorrente do mesmo anúncio
    // venceu), o nosso virou órfão → remove p/ não duplicar no catálogo.
    if (listing && listing.productId !== productId) {
      // Só um produto criado por esta execução pode ser órfão. Um candidato
      // preexistente por SKU/identidade continua válido e jamais é apagado.
      if (action === "created_product") {
        const removal = db.product.delete({ where: { id: productId } });
        if (tx) {
          await removal;
        } else {
          await removal.catch((e) =>
            console.error(
              `[autodetect] Órfão não removido (product ${productId}):`,
              e instanceof Error ? e.message : e,
            ),
          );
        }
      }
      // Write-through com o VENCEDOR da corrida (nunca o órfão removido).
      if (cache && normalizedSku && !usesSyntheticSku) {
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
    // label e peça espelhada ficam de fora: seu SKU sintético não é o código
    // do vendedor e não pode substituir o produto original no mapa.
    if (
      cache &&
      normalizedSku &&
      !usesSyntheticSku &&
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
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string } | null> {
    const product = await (tx ?? prisma).product.findFirst({
      where: { userId, skuNormalized: normalizedSku },
      select: { id: true, name: true },
      // ⚠️ ORDEM ESTAVEL. A unique do catalogo e `@@unique([userId, sku])` sobre
      // o sku CRU, mas a busca roda sobre `skuNormalized`: "ABC" e "abc" podem
      // coexistir no mesmo dono e ambos casarem. Sem `orderBy`, o Postgres
      // devolve "qualquer um" — e o mesmo anuncio reimportado podia cair em
      // produto diferente entre execucoes, sem nada mudar no catalogo.
      // Medido em 15/09/2026: ZERO skuNormalized ambiguos em 366.883 produtos
      // de 120 usuarios. A ordem e reprodutibilidade barata para um caso que
      // hoje nao existe — nao guarda de ambiguidade, que mudaria comportamento
      // sem defeito medido para justificar.
      orderBy: { id: "asc" },
    });
    return product ?? null;
  }

  /**
   * Prefixo do SKU sintético de anúncio SEM código de vendedor, por plataforma
   * (usado só com AUTODETECT_SKU_PREFIXADO=true). Curto de propósito: aparece
   * na etiqueta e na busca do lojista. Plataforma nova cai no genérico "MP".
   */
  private static readonly SEM_SKU_PREFIXO: Record<string, string> = {
    [Platform.MERCADO_LIVRE]: "ML",
    [Platform.SHOPEE]: "SHP",
    [Platform.MAGALU]: "MGL",
  };

  private static async createProductFromItem(
    item: NormalizedMarketplaceItem,
    normalizedSku: string | null,
    useSyntheticSku = false,
    cache?: AutodetectImportCache,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    productId: string;
    raced: boolean;
    usesSyntheticSku: boolean;
  }> {
    // Dono resolvido UMA vez por lote (cache.owner, lazy) e injetado no
    // ProductUseCase — evita um findById(userId) por produto criado. Sem cache
    // (webhook/polling), fica undefined e create() faz o findById como hoje.
    let preloadedUser: User | null | undefined = undefined;
    if (cache) {
      if (cache.owner === undefined) {
        const users = new UserRepositoryPrisma();
        cache.owner = tx
          ? await users.findById(item.account.userId, tx)
          : await users.findById(item.account.userId);
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
    //  - box label (SKU reutilizado): sintético e único por
    //    plataforma+conta+anúncio, para não colidir com o produto casado nem
    //    re-agrupar via o mesmo SKU;
    //  - anúncio com SKU próprio: usa o SKU do vendedor;
    //  - sem SKU: autoSku (contador sequencial) — ou, com
    //    AUTODETECT_SKU_PREFIXADO=true, sintético prefixado (ver abaixo).
    const syntheticSku = accountScopedAutodetectSku("VAAPT", {
      platform: item.platform,
      accountId: item.account.id,
      externalListingId: item.externalListingId,
    });

    // SKU sintético para anúncio SEM código de vendedor (OPT-IN, desligado por
    // padrão).
    //
    // POR QUE. O `autoSku` gera `n.toString().padStart(3, "0")` — NÚMERO PURO,
    // exatamente o formato da etiqueta física do galpão. O anúncio sem SKU
    // nasce então ocupando um número que pertence a outra peça, e a peça real
    // (vinda da migração) fica sem poder usar o próprio código. Medido na MK2
    // em 03/09/2026: uma varredura da Shopee criou 1.934 produtos com SKU
    // numérico em UM dia; o caso concreto foi a etiqueta `MK2-6036` aparecer no
    // sistema como `37156`, com quatro fichas para a mesma peça. Reconfirmado
    // em 16/09/2026 pelo próprio cliente: 91% dos anúncios dele (22.387 de
    // 24.660) não têm código de vendedor, e o SKU 9662 que a Dexo emitiu para
    // um coxim é, na planilha dele, a etiqueta de um Sensor ABS.
    //
    // O prefixo torna o SKU inconfundível com etiqueta e, por ser derivado do
    // anúncio, DETERMINÍSTICO: reimportar o mesmo anúncio reencontra o mesmo
    // produto em vez de criar outro. É o mesmo princípio do sintético acima,
    // que já roda em produção — inclusive no destino de publicação
    // (`seller_custom_field` no ML, `item_sku` na Shopee), onde SKU
    // alfanumérico é aceito.
    //
    // ⚠️ Esta flag lê "true", não "1" como as demais do projeto — é o contrato
    // do spec que veio junto. Flag ausente ⇒ caminho de hoje, byte a byte.
    const semSkuPrefixado =
      // The identity transaction requires a deterministic SKU. Auto-number
      // collision retries inside ProductUseCase cannot recover an aborted tx.
      process.env.AUTODETECT_SKU_PREFIXADO === "true" || Boolean(tx)
        ? accountScopedAutodetectSku(
            ListingAutodetectUseCase.SEM_SKU_PREFIXO[item.platform] ?? "MP",
            {
              platform: item.platform,
              accountId: item.account.id,
              externalListingId: item.externalListingId,
            },
          )
        : null;
    // No máximo duas tentativas: SKU do vendedor e, se o vencedor da corrida
    // for incompatível, o sintético deste anúncio. Uma colisão no sintético
    // só relê seu vencedor; nunca volta a tentar o SKU original.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (tx) await tx.$executeRawUnsafe("SAVEPOINT autodetect_product");
      try {
        const sku = useSyntheticSku
          ? syntheticSku
          : item.rawSku || semSkuPrefixado || "";
        const payload = {
          ...base,
          sku,
          autoSku: !sku,
        };
        const product = tx
          ? await productUseCase.create(payload, tx)
          : await productUseCase.create(payload);
        if (tx)
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT autodetect_product");
        return {
          productId: product.id,
          raced: false,
          usesSyntheticSku: useSyntheticSku,
        };
      } catch (err) {
        if (tx) {
          await tx.$executeRawUnsafe(
            "ROLLBACK TO SAVEPOINT autodetect_product",
          );
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT autodetect_product");
        }
        if (this.isDuplicateSkuError(err)) {
          // Re-resolve pelo código efetivamente usado. Sem SKU de vendedor
          // nem prefixo determinístico não há chave para recuperar a corrida.
          const resolveKey = useSyntheticSku
            ? normalizeSku(syntheticSku)
            : (normalizedSku ??
              (semSkuPrefixado ? normalizeSku(semSkuPrefixado) : null));
          if (resolveKey) {
            const raced = await this.findProductBySku(
              item.account.userId,
              resolveKey,
              tx,
            );
            if (raced) {
              // O lookup inicial pode ter ocorrido antes de outro processo
              // criar uma peça diferente com o mesmo SKU. A unique garante o
              // código, mas não a identidade física: reaplique as guardas.
              // A presença de listing é lida fresca, pois o cache antecede a
              // corrida e pode não conhecer o anúncio recém-criado.
              const mirrored = isOppositeSideOrAxis(item.title, raced.name);
              const incompatibleTitle =
                Boolean(raced.name) &&
                !areTitlesSimilar(item.title, raced.name);
              if (mirrored || incompatibleTitle) {
                if (!useSyntheticSku && attempt === 0) {
                  useSyntheticSku = true;
                  continue;
                }
                throw err;
              }
              return {
                productId: raced.id,
                raced: true,
                usesSyntheticSku: useSyntheticSku,
              };
            }
          }
        }
        throw err;
      }
    }
    throw new Error("Não foi possível resolver o SKU do anúncio");
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
    const rawStatus =
      (item as { item_status?: string }).item_status ?? item.status;
    const listingStatus =
      rawStatus && rawStatus !== "NORMAL" ? rawStatus : "active";

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
      createdAt: this.parseDate((sku as { created_at?: string }).created_at),
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

    // Estoque REAL do catálogo quando a Meta o expõe. O fallback é o
    // comportamento anterior (1 unidade disponível) — a edge de leitura pode
    // não devolver o campo dependendo da versão/permissão do app, e inventar
    // um número seria pior do que assumir a unidade.
    const rawQty = item.quantity_to_sell_on_facebook;
    const parsedQty =
      typeof rawQty === "number"
        ? rawQty
        : typeof rawQty === "string" && rawQty.trim() !== ""
          ? Number(rawQty)
          : NaN;
    const stock =
      status === "paused"
        ? 0
        : Number.isFinite(parsedQty) && parsedQty >= 0
          ? Math.trunc(parsedQty)
          : 1;

    // Galeria inteira: capa + adicionais, sem duplicar a capa.
    const extras = Array.isArray(item.additional_image_urls)
      ? item.additional_image_urls.filter(
          (u): u is string => typeof u === "string" && u.trim().length > 0,
        )
      : [];
    const imageUrls = [...(imageUrl ? [imageUrl] : []), ...extras].filter(
      (u, i, arr) => arr.indexOf(u) === i,
    );

    return {
      platform: Platform.FACEBOOK,
      account,
      externalListingId,
      rawSku,
      title: (item.name as string) || rawSku || externalListingId,
      price: this.coerceFacebookPrice(item.price),
      stock,
      status,
      permalink: (item.url as string) || null,
      imageUrl,
      imageUrls,
      createdAt: new Date(),
    };
  }

  /**
   * Preço vindo de ML, Shopee e Magalu. BYTE-IDÊNTICO ao da main: estes três
   * canais entregam número, e alargar o parse aqui mudaria silenciosamente o
   * preço com que um produto é criado na auto-detecção deles.
   * O caso do Facebook (string com moeda) vive em `coerceFacebookPrice`.
   */
  private static coercePrice(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Preço do Catálogo Meta, que vem como string com moeda ("199.90 BRL"):
   * `Number("199.90 BRL")` é NaN, o que zerava todo produto importado.
   * Isolado do `coercePrice` de propósito — ver o comentário acima.
   */
  private static coerceFacebookPrice(value: unknown): number {
    if (typeof value === "number") {
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }
    if (typeof value === "string") {
      const match = value.match(/-?\d[\d.,]*/);
      if (!match) return 0;
      let t = match[0];
      if (t.includes(",") && t.includes(".")) {
        // O separador decimal é o último a aparecer; o outro é de milhar.
        t =
          t.lastIndexOf(",") > t.lastIndexOf(".")
            ? t.replace(/\./g, "").replace(",", ".")
            : t.replace(/,/g, "");
      } else if (t.includes(",")) {
        t = t.replace(",", ".");
      }
      const n = Number(t);
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

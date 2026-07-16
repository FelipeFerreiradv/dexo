import prisma from "../../lib/prisma";

/**
 * Repositório para gerenciar ProductListings
 * Conexão entre Product local e anúncios no Mercado Livre
 */
export class ListingRepository {
  /**
   * Cria uma nova conexão entre produto e anúncio ML
   */
  static async createListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    permalink?: string | null;
    status: string;
    // optional retry metadata
    retryAttempts?: number;
    nextRetryAt?: Date | null;
    lastError?: string | null;
    retryEnabled?: boolean;
    // category that was requested when attempting the ML create (useful for retries)
    requestedCategoryId?: string | null;
    // ML listing settings (persisted per-account; survives retries/edits)
    listingType?: string | null;
    itemCondition?: string | null;
    hasWarranty?: boolean | null;
    warrantyUnit?: string | null;
    warrantyDuration?: number | null;
    shippingMode?: string | null;
    freeShipping?: boolean | null;
    localPickup?: boolean | null;
    manufacturingTime?: number | null;
  }) {
    try {
      const listing = await prisma.productListing.create({
        data: {
          productId: data.productId,
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
          externalSku: data.externalSku || null,
          permalink: data.permalink || null,
          status: data.status,
          retryAttempts: data.retryAttempts ?? 0,
          nextRetryAt: data.nextRetryAt ?? null,
          lastError: data.lastError ?? null,
          retryEnabled: data.retryEnabled ?? false,
          requestedCategoryId: data.requestedCategoryId ?? null,
          listingType: data.listingType ?? null,
          itemCondition: data.itemCondition ?? null,
          hasWarranty: data.hasWarranty ?? null,
          warrantyUnit: data.warrantyUnit ?? null,
          warrantyDuration: data.warrantyDuration ?? null,
          shippingMode: data.shippingMode ?? null,
          freeShipping: data.freeShipping ?? null,
          localPickup: data.localPickup ?? null,
          manufacturingTime: data.manufacturingTime ?? null,
        },
      });
      return listing;
    } catch (error) {
      throw new Error(
        `Erro ao criar listing: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Cria OU atualiza o listing pela unique key (marketplaceAccountId,
   * externalListingId) — idempotente. Usado onde o mesmo anúncio pode ser
   * (re)criado com resultados diferentes (ex.: Magalu, cuja identidade é o SKU:
   * uma falha grava status "error"+lastError e um retry bem-sucedido reaproveita
   * a MESMA linha virando "active", sem P2002 nem linha duplicada). Só sobrescreve
   * os campos informados (preserva overrides do usuário e o resto).
   */
  static async upsertListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    permalink?: string | null;
    status: string;
    lastError?: string | null;
    retryEnabled?: boolean;
    nextRetryAt?: Date | null;
    retryAttempts?: number;
  }) {
    return prisma.productListing.upsert({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
        },
      },
      create: {
        productId: data.productId,
        marketplaceAccountId: data.marketplaceAccountId,
        externalListingId: data.externalListingId,
        externalSku: data.externalSku ?? null,
        permalink: data.permalink ?? null,
        status: data.status,
        lastError: data.lastError ?? null,
        retryEnabled: data.retryEnabled ?? false,
        nextRetryAt: data.nextRetryAt ?? null,
        retryAttempts: data.retryAttempts ?? 0,
      },
      update: {
        status: data.status,
        permalink: data.permalink === undefined ? undefined : data.permalink,
        externalSku:
          data.externalSku === undefined ? undefined : data.externalSku,
        lastError: data.lastError === undefined ? undefined : data.lastError,
        retryEnabled: data.retryEnabled ?? undefined,
        nextRetryAt:
          data.nextRetryAt === undefined ? undefined : data.nextRetryAt,
        retryAttempts: data.retryAttempts ?? undefined,
      },
    });
  }

  /**
   * Cria (ou reaproveita) o listing de um anúncio detectado automaticamente no
   * marketplace. Upsert na unique key (marketplaceAccountId, externalListingId):
   * idempotente e à prova de corrida — uma reentrega/polling repetido cai no
   * `update` no-op em vez de estourar P2002. Espelha `upsertFromOrderFallback`,
   * acrescentando `permalink` (o anúncio já vem com a URL pública).
   */
  static async upsertAutodetectedListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    permalink?: string | null;
    status: string;
  }) {
    try {
      return await prisma.productListing.upsert({
        where: {
          marketplaceAccountId_externalListingId: {
            marketplaceAccountId: data.marketplaceAccountId,
            externalListingId: data.externalListingId,
          },
        },
        create: {
          productId: data.productId,
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
          externalSku: data.externalSku || null,
          permalink: data.permalink || null,
          status: data.status,
        },
        update: {},
        // EGRESS: o chamador só precisa do id + productId (p/ detectar órfão).
        select: { id: true, productId: true },
      });
    } catch (error: any) {
      // Prisma upsert NÃO é atômico (faz SELECT→INSERT). Sob entregas
      // concorrentes do MESMO anúncio (o ML dispara vários webhooks `items`
      // quase simultâneos: criação + preço + estoque), duas execuções passam
      // pelo "não existe" e dois inserts correm → o segundo estoura P2002 na
      // unique key (marketplaceAccountId, externalListingId). Isso é exatamente
      // o estado desejado (o listing já existe) → idempotente: relê e devolve.
      if (error?.code === "P2002") {
        return prisma.productListing.findUnique({
          where: {
            marketplaceAccountId_externalListingId: {
              marketplaceAccountId: data.marketplaceAccountId,
              externalListingId: data.externalListingId,
            },
          },
          select: { id: true, productId: true },
        });
      }
      // Outro erro qualquer: loga completo (a mensagem do Error vinha vazia).
      console.error(
        `[autodetect] Falha no upsert do listing (acct=${data.marketplaceAccountId}, item=${data.externalListingId}, product=${data.productId}):`,
        error,
      );
      const detail =
        error?.message ||
        error?.code ||
        (error?.meta ? JSON.stringify(error.meta) : "") ||
        (error ? String(error) : "erro desconhecido");
      throw new Error(`Erro ao criar listing auto-detectado: ${detail}`);
    }
  }

  /**
   * EGRESS-light: só o `productId` do listing de (conta, anúncio), para a
   * checagem de idempotência da auto-detecção. Evita puxar o Product inteiro
   * (com JSONB de attributes/mlCatalogSnapshot) a cada webhook/polling.
   */
  static async findProductIdByExternalListingId(
    marketplaceAccountId: string,
    externalListingId: string,
  ): Promise<{ productId: string } | null> {
    return prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId,
        },
      },
      select: { productId: true },
    });
  }

  /**
   * Detecção de "SKU de caixa": um produto que já tem um anúncio NESTA conta e
   * casaria com um NOVO anúncio pelo mesmo SKU indica que o SKU foi reutilizado
   * como rótulo de caixa/palete (não é um SKU único por item). Nesse caso o novo
   * anúncio NÃO deve ser agrupado — vira produto próprio. Anúncios da MESMA conta
   * sinalizam reuso; contas diferentes (mesmo SKU) são agrupamento legítimo.
   * EGRESS-light: só existência.
   */
  static async productHasListingInAccount(
    productId: string,
    marketplaceAccountId: string,
  ): Promise<boolean> {
    const found = await prisma.productListing.findFirst({
      where: { productId, marketplaceAccountId },
      select: { id: true },
    });
    return found != null;
  }

  static async upsertFromOrderFallback(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
    status: string;
  }) {
    try {
      return await prisma.productListing.upsert({
        where: {
          marketplaceAccountId_externalListingId: {
            marketplaceAccountId: data.marketplaceAccountId,
            externalListingId: data.externalListingId,
          },
        },
        create: {
          productId: data.productId,
          marketplaceAccountId: data.marketplaceAccountId,
          externalListingId: data.externalListingId,
          externalSku: data.externalSku || null,
          status: data.status,
        },
        update: {},
      });
    } catch (error) {
      throw new Error(
        `Erro ao criar listing via fallback do pedido: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Busca listing por ID do anúncio externo (ML ID)
   */
  static async findByExternalListingId(
    marketplaceAccountId: string,
    externalListingId: string,
  ) {
    return prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId,
        },
      },
      include: {
        product: true,
      },
    });
  }

  /**
   * Busca listing por produto e conta de marketplace
   */
  static async findByProductAndAccount(
    productId: string,
    marketplaceAccountId: string,
  ) {
    return prisma.productListing.findFirst({
      where: {
        productId,
        marketplaceAccountId,
      },
    });
  }

  /**
   * Lista todos os listings de uma conta de marketplace
   */
  static async findAllByAccount(marketplaceAccountId: string) {
    return prisma.productListing.findMany({
      where: {
        marketplaceAccountId,
      },
      include: {
        product: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
  }

  /**
   * Encontra placeholders pendentes para retry (externals que começam com PENDING_)
   * ou listings marcados com retryEnabled=true e nextRetryAt <= now
   */
  static async findPendingRetries(cutoff: Date, limit = 100) {
    return prisma.productListing.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                externalListingId: { startsWith: "PENDING_" },
                retryEnabled: { not: false },
              },
              { retryEnabled: true },
            ],
          },
          {
            OR: [{ nextRetryAt: { lte: cutoff } }, { nextRetryAt: null }],
          },
        ],
      },
      include: { product: true, marketplaceAccount: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
  }

  static async incrementRetryAttempts(
    listingId: string,
    data: {
      lastError?: string | null;
      nextRetryAt?: Date | null;
      retryEnabled?: boolean;
    },
  ) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: {
        retryAttempts: { increment: 1 },
        lastError: data.lastError ?? undefined,
        nextRetryAt:
          data.nextRetryAt === undefined ? undefined : data.nextRetryAt,
        retryEnabled: data.retryEnabled ?? undefined,
      },
    });
  }

  /**
   * Lista todos os listings de um produto
   */
  static async findAllByProduct(productId: string) {
    return prisma.productListing.findMany({
      where: {
        productId,
      },
      include: {
        marketplaceAccount: true,
      },
    });
  }

  /**
   * Atualiza status de um listing
   */
  static async updateStatus(listingId: string, status: string) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { status },
    });
  }

  /**
   * Reaponta um listing para outra conta de marketplace.
   *
   * Usado pelo reparo automático de ownership: quando a remoção via API
   * estoura 403 ("you are not the seller") e descobrimos que o anúncio
   * pertence a outra conta do MESMO usuário, atualizamos o FK aqui em vez
   * de pedir intervenção manual.
   *
   * O índice único `(marketplaceAccountId, externalListingId)` é respeitado
   * porque o destino é uma conta diferente — só dispara conflict se já
   * houver outro listing local para o mesmo externalId nessa conta-destino,
   * o que indicaria duplicação prévia (raro; deixar o erro propagar).
   */
  static async reassignAccount(
    listingId: string,
    newAccountId: string,
  ) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { marketplaceAccountId: newAccountId },
    });
  }

  /**
   * Atualiza SKU externo de um listing
   */
  static async updateExternalSku(listingId: string, externalSku: string) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: { externalSku },
    });
  }

  /**
   * Atualiza campos principais de um listing quando o item for publicado no ML
   */
  static async updateListing(
    listingId: string,
    data: {
      externalListingId?: string;
      externalSku?: string;
      permalink?: string | null;
      status?: string;
      // retry metadata updates
      retryAttempts?: number;
      nextRetryAt?: Date | null;
      lastError?: string | null;
      retryEnabled?: boolean;
      // optionally update requestedCategoryId
      requestedCategoryId?: string | null;
      // ML listing settings
      listingType?: string | null;
      itemCondition?: string | null;
      hasWarranty?: boolean | null;
      warrantyUnit?: string | null;
      warrantyDuration?: number | null;
      shippingMode?: string | null;
      freeShipping?: boolean | null;
      localPickup?: boolean | null;
      manufacturingTime?: number | null;
      // Override fields per-listing (NULL = herda do produto)
      titleOverride?: string | null;
      descriptionOverride?: string | null;
      priceOverride?: number | null;
      brandOverride?: string | null;
      modelOverride?: string | null;
      yearOverride?: string | null;
      versionOverride?: string | null;
      categoryOverride?: string | null;
      mlCategoryOverride?: string | null;
      shopeeCategoryOverride?: string | null;
      partNumberOverride?: string | null;
      qualityOverride?: string | null;
      heightCmOverride?: number | null;
      widthCmOverride?: number | null;
      lengthCmOverride?: number | null;
      weightKgOverride?: number | null;
      imageUrlsOverride?: unknown;
      attributesOverride?: unknown;
      compatibilitiesOverride?: unknown;
      sourceVehicleOverride?: string | null;
    },
  ) {
    return prisma.productListing.update({
      where: { id: listingId },
      data: {
        externalListingId: data.externalListingId || undefined,
        externalSku: data.externalSku || undefined,
        permalink: data.permalink === undefined ? undefined : data.permalink,
        status: data.status || undefined,
        retryAttempts: data.retryAttempts ?? undefined,
        nextRetryAt:
          data.nextRetryAt === undefined ? undefined : data.nextRetryAt,
        lastError: data.lastError === undefined ? undefined : data.lastError,
        retryEnabled: data.retryEnabled ?? undefined,
        requestedCategoryId:
          data.requestedCategoryId === undefined
            ? undefined
            : data.requestedCategoryId,
        listingType:
          data.listingType === undefined ? undefined : data.listingType,
        itemCondition:
          data.itemCondition === undefined ? undefined : data.itemCondition,
        hasWarranty:
          data.hasWarranty === undefined ? undefined : data.hasWarranty,
        warrantyUnit:
          data.warrantyUnit === undefined ? undefined : data.warrantyUnit,
        warrantyDuration:
          data.warrantyDuration === undefined
            ? undefined
            : data.warrantyDuration,
        shippingMode:
          data.shippingMode === undefined ? undefined : data.shippingMode,
        freeShipping:
          data.freeShipping === undefined ? undefined : data.freeShipping,
        localPickup:
          data.localPickup === undefined ? undefined : data.localPickup,
        manufacturingTime:
          data.manufacturingTime === undefined
            ? undefined
            : data.manufacturingTime,
        titleOverride:
          data.titleOverride === undefined ? undefined : data.titleOverride,
        descriptionOverride:
          data.descriptionOverride === undefined
            ? undefined
            : data.descriptionOverride,
        // Override de preço <= 0 significa "herdar o preço do produto" (null),
        // nunca "publicar por R$ 0". Normaliza na escrita para que o valor
        // inválido não chegue ao banco por nenhum caminho (rota, dispatcher,
        // import). `undefined` continua sendo "não mexer no campo".
        priceOverride:
          data.priceOverride === undefined
            ? undefined
            : data.priceOverride !== null && data.priceOverride > 0
              ? data.priceOverride
              : null,
        brandOverride:
          data.brandOverride === undefined ? undefined : data.brandOverride,
        modelOverride:
          data.modelOverride === undefined ? undefined : data.modelOverride,
        yearOverride:
          data.yearOverride === undefined ? undefined : data.yearOverride,
        versionOverride:
          data.versionOverride === undefined ? undefined : data.versionOverride,
        categoryOverride:
          data.categoryOverride === undefined
            ? undefined
            : data.categoryOverride,
        mlCategoryOverride:
          data.mlCategoryOverride === undefined
            ? undefined
            : data.mlCategoryOverride,
        shopeeCategoryOverride:
          data.shopeeCategoryOverride === undefined
            ? undefined
            : data.shopeeCategoryOverride,
        partNumberOverride:
          data.partNumberOverride === undefined
            ? undefined
            : data.partNumberOverride,
        qualityOverride:
          data.qualityOverride === undefined ? undefined : data.qualityOverride,
        heightCmOverride:
          data.heightCmOverride === undefined
            ? undefined
            : data.heightCmOverride,
        widthCmOverride:
          data.widthCmOverride === undefined ? undefined : data.widthCmOverride,
        lengthCmOverride:
          data.lengthCmOverride === undefined
            ? undefined
            : data.lengthCmOverride,
        weightKgOverride:
          data.weightKgOverride === undefined
            ? undefined
            : data.weightKgOverride,
        imageUrlsOverride:
          data.imageUrlsOverride === undefined
            ? undefined
            : (data.imageUrlsOverride as never),
        attributesOverride:
          data.attributesOverride === undefined
            ? undefined
            : (data.attributesOverride as never),
        compatibilitiesOverride:
          data.compatibilitiesOverride === undefined
            ? undefined
            : (data.compatibilitiesOverride as never),
        sourceVehicleOverride:
          data.sourceVehicleOverride === undefined
            ? undefined
            : data.sourceVehicleOverride,
      },
    });
  }

  /**
   * Remove um listing
   */
  static async deleteListing(listingId: string) {
    return prisma.productListing.delete({
      where: { id: listingId },
    });
  }

  /**
   * Busca listing por ID interno
   */
  static async findById(listingId: string) {
    return prisma.productListing.findUnique({
      where: { id: listingId },
      include: {
        product: true,
        marketplaceAccount: true,
      },
    });
  }
}

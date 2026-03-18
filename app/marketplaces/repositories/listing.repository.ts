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
              { externalListingId: { startsWith: "PENDING_" } },
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

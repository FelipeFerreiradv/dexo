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
    externalSku?: string;
    permalink?: string;
    status: string;
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

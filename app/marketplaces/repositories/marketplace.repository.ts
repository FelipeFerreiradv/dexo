import prisma from "@/app/lib/prisma";
import { Platform, AccountStatus } from "@prisma/client";

/**
 * Camada de acesso a dados para contas de marketplace
 * Responsável por gerenciar persistência de contas conectadas
 */
export class MarketplaceRepository {
  /**
   * Cria nova conta de marketplace
   */
  static async createAccount(data: {
    userId: string;
    platform: Platform;
    accountName: string;
    externalUserId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    shopId?: number;
  }) {
    try {
      const account = await prisma.marketplaceAccount.create({
        data: {
          userId: data.userId,
          platform: data.platform,
          accountName: data.accountName,
          externalUserId: data.externalUserId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
          shopId: data.shopId,
          status: AccountStatus.ACTIVE,
        },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao criar conta de marketplace: ${error}`);
    }
  }

  /**
   * Busca conta de marketplace por usuário e plataforma
   */
  static async findByUserIdAndPlatform(userId: string, platform: Platform) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: {
          userId,
          platform,
        },
        orderBy: { updatedAt: "desc" },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta de marketplace: ${error}`);
    }
  }

  /**
   * Busca a primeira conta ATIVA de um usuÃ¡rio para a plataforma
   * (usada como fallback para compatibilidade legada)
   */
  static async findFirstActiveByUserAndPlatform(
    userId: string,
    platform: Platform,
  ) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: {
          userId,
          platform,
          status: AccountStatus.ACTIVE,
        },
        orderBy: { updatedAt: "desc" },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta ativa: ${error}`);
    }
  }

  /**
   * Lista todas as contas de um usuÃ¡rio para uma plataforma
   */
  static async findAllByUserIdAndPlatform(userId: string, platform: Platform) {
    try {
      const accounts = await prisma.marketplaceAccount.findMany({
        where: { userId, platform, status: AccountStatus.ACTIVE },
        orderBy: { createdAt: "asc" },
      });

      return accounts;
    } catch (error) {
      throw new Error(
        `Erro ao buscar contas do usuÃ¡rio para ${platform}: ${error}`,
      );
    }
  }

  /**
   * Busca conta por ID
   */
  static async findById(id: string) {
    try {
      const account = await prisma.marketplaceAccount.findUnique({
        where: { id },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta: ${error}`);
    }
  }

  /**
   * Busca conta por ID garantindo que pertence ao usuÃ¡rio informado
   */
  static async findByIdAndUser(id: string, userId: string) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: { id, userId },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta do usuÃ¡rio: ${error}`);
    }
  }

  /**
   * Lista todas as contas de um usuário
   */
  static async findAllByUserId(userId: string) {
    try {
      const accounts = await prisma.marketplaceAccount.findMany({
        where: { userId },
      });

      return accounts;
    } catch (error) {
      throw new Error(`Erro ao buscar contas do usuário: ${error}`);
    }
  }

  /**
   * Atualiza tokens (normalmente quando token expira)
   */
  static async updateTokens(
    id: string,
    data: {
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
    },
  ) {
    try {
      const account = await prisma.marketplaceAccount.update({
        where: { id },
        data: {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
        },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao atualizar tokens: ${error}`);
    }
  }

  /**
   * Atualiza status da conta
   */
  static async updateStatus(id: string, status: AccountStatus) {
    try {
      const account = await prisma.marketplaceAccount.update({
        where: { id },
        data: { status },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao atualizar status: ${error}`);
    }
  }

  /**
   * Atualiza apenas o shopId da conta
   */
  static async updateShopId(id: string, shopId: number) {
    try {
      const account = await prisma.marketplaceAccount.update({
        where: { id },
        data: { shopId },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao atualizar shopId: ${error}`);
    }
  }

  /**
   * Busca conta de marketplace por externalUserId e plataforma
   * Usado principalmente para webhooks, onde só temos o user_id do ML
   */
  static async findByExternalUserId(
    externalUserId: string,
    platform: Platform,
  ) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: {
          externalUserId,
          platform,
        },
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta por externalUserId: ${error}`);
    }
  }

  /**
   * Busca conta por externalUserId E userId (evita pegar conta de outro usuário)
   */
  static async findByUserAndExternalUserId(
    userId: string,
    externalUserId: string,
    platform: Platform,
  ) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: {
          userId,
          externalUserId,
          platform,
        },
      });
      return account;
    } catch (error) {
      throw new Error(
        `Erro ao buscar conta por externalUserId e usuário: ${error}`,
      );
    }
  }

  /**
   * Busca conta Shopee por shopId + userId
   */
  static async findShopeeByUserAndShopId(userId: string, shopId: number) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: {
          userId,
          platform: Platform.SHOPEE,
          shopId,
        },
      });
      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta Shopee por shopId: ${error}`);
    }
  }

  /**
   * Deleta conta de marketplace e todos os registros relacionados
   */
  static async deleteAccount(id: string): Promise<void> {
    try {
      // Verifica se existem pedidos vinculados à conta
      const ordersCount = await prisma.order.count({
        where: { marketplaceAccountId: id },
      });

      // Sempre removemos artefatos auxiliares
      await prisma.syncLog.deleteMany({ where: { marketplaceAccountId: id } });

      // Listas vinculadas (podem existir sem pedidos). Se houver pedidos, mantemos as listings,
      // mas liberamos relacionamentos opcionais de orderItems para evitar FK em cascata.
      const listings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: id },
        select: { id: true },
      });

      if (ordersCount > 0) {
        // Desconexão "soft": limpa tokens e desativa a conta, preservando histórico de pedidos.
        await prisma.$transaction([
          // orderItems podem referenciar listings; anulamos para não deixar pendência
          prisma.orderItem.updateMany({
            where: { listingId: { in: listings.map((l) => l.id) } },
            data: { listingId: null },
          }),
          prisma.marketplaceAccount.update({
            where: { id },
            data: {
              accessToken: "",
              refreshToken: "",
              expiresAt: new Date(0),
              status: AccountStatus.INACTIVE,
            },
          }),
        ]);
      } else {
        // Nenhum pedido vinculado: podemos excluir tudo de forma segura
        await prisma.$transaction([
          prisma.productListing.deleteMany({
            where: { marketplaceAccountId: id },
          }),
          prisma.marketplaceAccount.delete({
            where: { id },
          }),
        ]);
      }
    } catch (error) {
      throw new Error(`Erro ao deletar conta: ${error}`);
    }
  }
}

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
      });

      return account;
    } catch (error) {
      throw new Error(`Erro ao buscar conta de marketplace: ${error}`);
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
   * Deleta conta de marketplace e todos os registros relacionados
   */
  static async deleteAccount(id: string): Promise<void> {
    try {
      // Deletar logs de sync relacionados primeiro
      await prisma.syncLog.deleteMany({
        where: { marketplaceAccountId: id },
      });

      // Deletar listings relacionados
      await prisma.productListing.deleteMany({
        where: { marketplaceAccountId: id },
      });

      // Agora deletar a conta
      await prisma.marketplaceAccount.delete({
        where: { id },
      });
    } catch (error) {
      throw new Error(`Erro ao deletar conta: ${error}`);
    }
  }
}

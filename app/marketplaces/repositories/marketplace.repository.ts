import prisma from "@/app/lib/prisma";
import { Platform, AccountStatus } from "@prisma/client";
import { chunk } from "@/app/lib/chunk";

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
    // Baseline "só novos": quando informado, fixa o instante a partir do qual
    // anúncios passam a ser auto-detectados. Aditivo — omitido (undefined) grava
    // NULL e reproduz o comportamento de hoje (nada é auto-importado).
    autoImportListingsSince?: Date;
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
          autoImportListingsSince: data.autoImportListingsSince ?? null,
        },
      });

      return account;
    } catch (error) {
      if ((error as any)?.code === "P2002") {
        throw new Error(
          "Esta conta de marketplace já está vinculada a outro usuário ou já existe no sistema.",
        );
      }
      throw new Error(`Erro ao criar conta de marketplace: ${error}`);
    }
  }

  /**
   * Define o baseline "só novos" da conta (autoImportListingsSince). Usado pelo
   * backfill das contas já conectadas no deploy. Aditivo.
   */
  static async setAutoImportBaseline(accountId: string, when: Date) {
    return prisma.marketplaceAccount.update({
      where: { id: accountId },
      data: { autoImportListingsSince: when },
    });
  }

  /**
   * Atualiza dados de vendedor/catálogo por conta (OLX: telefone/CEP; Facebook:
   * catálogo/URL base). Escopo por userId+platform garante ownership.
   */
  static async updateSellerFields(
    accountId: string,
    userId: string,
    platform: Platform,
    data: {
      olxSellerPhone?: string | null;
      olxSellerZipcode?: string | null;
      fbCatalogId?: string | null;
      fbProductUrlBase?: string | null;
    },
  ): Promise<number> {
    const res = await prisma.marketplaceAccount.updateMany({
      where: { id: accountId, userId, platform },
      data,
    });
    return res.count;
  }

  /**
   * Avança (monotonicamente) o watermark do polling de itens novos da Shopee.
   * Nunca regride: só persiste quando `when` é mais recente que o valor atual —
   * assim reexecuções/atrasos não fazem o polling reprocessar tudo de novo.
   */
  static async advanceShopeeListingsWatermark(accountId: string, when: Date) {
    const account = await prisma.marketplaceAccount.findUnique({
      where: { id: accountId },
      select: { shopeeListingsSyncedThrough: true },
    });
    const current = account?.shopeeListingsSyncedThrough;
    if (current && current.getTime() >= when.getTime()) {
      return account;
    }
    return prisma.marketplaceAccount.update({
      where: { id: accountId },
      data: { shopeeListingsSyncedThrough: when },
    });
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
   * ADITIVO (auto-cliente) — variante EGRESS-light do findById: só os campos
   * que o enriquecimento do comprador usa (dono + shopId + access token).
   * Não trafega a row inteira da conta (refreshToken/config) por pedido novo,
   * e por design nem expõe o refreshToken ao caller (que nunca deve refrescar).
   */
  static async findByIdLite(id: string) {
    try {
      return await prisma.marketplaceAccount.findUnique({
        where: { id },
        select: { id: true, userId: true, shopId: true, accessToken: true },
      });
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
   * Renomeia a conta Shopee SOMENTE se o rotulo ainda for o que se leu.
   *
   * Compare-and-swap de proposito: a auto-cura roda dentro de um GET que
   * varios usuarios do mesmo tenant podem disparar ao mesmo tempo, e o
   * `updateMany` com o valor esperado no WHERE faz a segunda escrita virar
   * no-op em vez de sobrescrever a primeira. Devolve quantas linhas mudaram
   * (0 = alguem chegou antes, ou o nome ja nao era o que se esperava).
   */
  static async renameShopeeAccountIfUnchanged(
    id: string,
    accountNameEsperado: string,
    accountName: string,
  ): Promise<number> {
    const r = await prisma.marketplaceAccount.updateMany({
      where: {
        id,
        platform: Platform.SHOPEE,
        accountName: accountNameEsperado,
      },
      data: { accountName },
    });
    return r.count;
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

  static async findAllByExternalUserId(
    externalUserId: string,
    platform: Platform,
    onlyActive = false,
  ) {
    try {
      return await prisma.marketplaceAccount.findMany({
        where: {
          externalUserId,
          platform,
          ...(onlyActive ? { status: AccountStatus.ACTIVE } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      });
    } catch (error) {
      throw new Error(`Erro ao listar contas por externalUserId: ${error}`);
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

  static async findAllShopeeByShopId(shopId: number, onlyActive = false) {
    try {
      return await prisma.marketplaceAccount.findMany({
        where: {
          shopId,
          platform: Platform.SHOPEE,
          ...(onlyActive ? { status: AccountStatus.ACTIVE } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      });
    } catch (error) {
      throw new Error(`Erro ao listar contas Shopee por shopId: ${error}`);
    }
  }

  /**
   * Busca conta Shopee ativa apenas por shopId (usado em webhooks)
   */
  static async findByShopId(shopId: number) {
    try {
      const account = await prisma.marketplaceAccount.findFirst({
        where: {
          shopId,
          platform: Platform.SHOPEE,
          status: AccountStatus.ACTIVE,
        },
        // Duplicated ACTIVE records can exist for the same shopId.
        // Prefer the most recently refreshed/updated account for webhook processing.
        orderBy: [
          { updatedAt: "desc" },
          { expiresAt: "desc" },
          { createdAt: "desc" },
        ],
      });
      return account;
    } catch (error) {
      throw new Error(
        `Erro ao buscar conta Shopee por shopId (webhook): ${error}`,
      );
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
        // PostgreSQL aceita no máximo 32767 bind variables por prepared
        // statement. Contas grandes (JB Desmonte do Leonardo: 42K+ listings)
        // estouravam esse limite em um único updateMany com IN(...).
        // Quebramos em chunks de 10000 IDs (bem abaixo do teto) e mantemos
        // tudo na mesma transação para preservar atomicidade.
        const listingIds = listings.map((l) => l.id);
        const idChunks = chunk(listingIds, 10_000);
        const updateOps = idChunks.map((ids) =>
          prisma.orderItem.updateMany({
            where: { listingId: { in: ids } },
            data: { listingId: null },
          }),
        );

        // Desconexão "soft": limpa tokens e desativa a conta, preservando histórico de pedidos.
        await prisma.$transaction(
          [
            // orderItems podem referenciar listings; anulamos para não deixar pendência
            ...updateOps,
            prisma.marketplaceAccount.update({
              where: { id },
              data: {
                accessToken: "",
                refreshToken: "",
                expiresAt: new Date(0),
                status: AccountStatus.INACTIVE,
              },
            }),
          ],
          // Timeout maior para contas grandes (5 chunks de 10K updates podem
          // levar alguns segundos no Supabase pooler).
          { timeout: 60_000 },
        );
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

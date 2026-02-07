import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { Platform, AccountStatus } from "@prisma/client";

/**
 * Casos de uso para gerenciar contas de marketplace
 * Orquestra fluxo OAuth e persistência
 */
export class MarketplaceUseCase {
  /**
   * Inicia fluxo OAuth para Mercado Livre
   * Retorna URL para qual o usuário deve ser redirecionado
   * @param userId - ID do usuário (opcional, para associar conta após callback)
   */
  static initiateOAuth(userId?: string): { authUrl: string; state: string } {
    const oauthData = MLOAuthService.generateAuthUrl(userId);

    return {
      authUrl: oauthData.authUrl,
      state: oauthData.state,
    };
  }

  /**
   * Processa callback do OAuth após usuário autorizar no Mercado Livre
   * userId pode vir do state (se foi iniciado com userId) ou do parâmetro
   */
  static async handleOAuthCallback(data: {
    code: string;
    state: string;
    userId?: string;
  }) {
    try {
      // 1. Validar state (CSRF protection)
      const stateValidation = MLOAuthService.validateState(data.state);
      if (!stateValidation.valid) {
        throw new Error("State inválido ou expirado. Reinicie a autenticação.");
      }

      const codeVerifier = stateValidation.codeVerifier!;
      // Usar userId do state se não foi passado explicitamente
      const userId = data.userId || stateValidation.userId;

      if (!userId) {
        throw new Error("userId não encontrado. Faça login e tente novamente.");
      }

      // 2. Trocar code por tokens
      const tokenData = await MLOAuthService.exchangeCodeForTokens(
        data.code,
        codeVerifier,
      );

      // 3. Obter informações do usuário (seller) do Mercado Livre
      const userInfo = await MLOAuthService.getUserInfo(tokenData.accessToken);

      // 4. Verificar se já existe conta conectada
      const existingAccount =
        await MarketplaceRepository.findByUserIdAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        );

      // 5. Criar ou atualizar conta
      let account;
      const expiresAt = new Date(Date.now() + tokenData.expiresIn * 1000);

      if (existingAccount) {
        // Atualizar tokens
        account = await MarketplaceRepository.updateTokens(existingAccount.id, {
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt,
        });

        // Reativar se estava inativa
        if (account.status !== AccountStatus.ACTIVE) {
          account = await MarketplaceRepository.updateStatus(
            existingAccount.id,
            AccountStatus.ACTIVE,
          );
        }
      } else {
        // Criar nova conta
        account = await MarketplaceRepository.createAccount({
          userId: userId,
          platform: Platform.MERCADO_LIVRE,
          accountName: userInfo.nickname || userInfo.email || "Mercado Livre",
          externalUserId: tokenData.externalUserId,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt,
        });
      }

      return account;
    } catch (error) {
      throw new Error(
        `Erro ao processar callback OAuth: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Obtém status de conexão com marketplace
   */
  static async getAccountStatus(
    userId: string,
    platform: Platform = Platform.MERCADO_LIVRE,
  ) {
    try {
      const account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        platform,
      );

      if (!account) {
        return {
          connected: false,
          message: `Nenhuma conta ${platform} conectada`,
        };
      }

      const isExpired = new Date() > account.expiresAt;

      if (isExpired) {
        // Tentar renovar token automaticamente
        try {
          const refreshed = await MLOAuthService.refreshAccessToken(
            account.refreshToken,
          );

          await MarketplaceRepository.updateTokens(account.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          });

          return {
            connected: true,
            account,
            message: "Conta conectada (token renovado)",
          };
        } catch (error) {
          // Token expirou e não conseguiu renovar
          await MarketplaceRepository.updateStatus(
            account.id,
            AccountStatus.ERROR,
          );

          return {
            connected: false,
            account,
            message: "Token expirado. Reconecte sua conta.",
          };
        }
      }

      return {
        connected: account.status === AccountStatus.ACTIVE,
        account,
        message: `Conta ${platform} conectada`,
      };
    } catch (error) {
      throw new Error(
        `Erro ao obter status: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Desconecta marketplace
   */
  static async disconnectAccount(
    userId: string,
    platform: Platform = Platform.MERCADO_LIVRE,
  ): Promise<void> {
    try {
      const account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        platform,
      );

      if (!account) {
        throw new Error(`Conta ${platform} não encontrada`);
      }

      await MarketplaceRepository.deleteAccount(account.id);
    } catch (error) {
      throw new Error(
        `Erro ao desconectar conta: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ====================================================================
  // MÉTODOS PARA SHOPEE
  // ====================================================================

  /**
   * Inicia fluxo OAuth para Shopee
   * Retorna URL para qual o usuário deve ser redirecionado
   * @param userId - ID do usuário (opcional, para associar conta após callback)
   */
  static initiateShopeeOAuth(userId?: string): {
    authUrl: string;
    state: string;
  } {
    // Para Shopee, o userId é armazenado no state da URL de callback
    // O shop_id vem no callback, então não precisamos dele aqui
    const oauthData = ShopeeOAuthService.initiateAuth();

    return {
      authUrl: oauthData.auth_url,
      state: userId || "", // userId será usado no callback
    };
  }

  /**
   * Processa callback do OAuth após usuário autorizar no Shopee
   * userId pode vir do state (se foi iniciado com userId) ou do parâmetro
   */
  static async handleShopeeOAuthCallback(data: {
    code: string;
    shopId: number;
    userId?: string;
  }) {
    try {
      // Usar userId passado diretamente (vem da sessão)
      const userId = data.userId;

      if (!userId) {
        throw new Error("userId não encontrado. Faça login e tente novamente.");
      }

      // 2. Trocar code por tokens
      const tokenData = await ShopeeOAuthService.exchangeCodeForTokens(
        data.code,
        data.shopId,
      );

      // 3. Verificar se já existe conta conectada
      const existingAccount =
        await MarketplaceRepository.findByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        );

      // 4. Criar ou atualizar conta
      let account;
      const expiresAt = new Date(Date.now() + tokenData.expire_in * 1000);

      if (existingAccount) {
        // Atualizar tokens
        account = await MarketplaceRepository.updateTokens(existingAccount.id, {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
        });

        // Atualizar shopId se necessário
        if (existingAccount.shopId !== data.shopId) {
          account = await MarketplaceRepository.updateShopId(
            existingAccount.id,
            data.shopId,
          );
        }

        // Reativar se estava inativa
        if (account.status !== AccountStatus.ACTIVE) {
          account = await MarketplaceRepository.updateStatus(
            existingAccount.id,
            AccountStatus.ACTIVE,
          );
        }
      } else {
        // Criar nova conta
        account = await MarketplaceRepository.createAccount({
          userId: userId,
          platform: Platform.SHOPEE,
          accountName: `Shopee Shop ${data.shopId}`,
          externalUserId:
            tokenData.merchant_id?.toString() || data.shopId.toString(),
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
          shopId: data.shopId,
        });
      }

      return account;
    } catch (error) {
      throw new Error(
        `Erro ao processar callback OAuth Shopee: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Obtém status da conta Shopee do usuário
   */
  static async getShopeeAccountStatus(userId: string): Promise<{
    connected: boolean;
    account?: any;
    message: string;
  }> {
    try {
      const account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        Platform.SHOPEE,
      );

      if (!account) {
        return {
          connected: false,
          message: "Conta Shopee não conectada",
        };
      }

      // Verificar se tokens são válidos (não expirados)
      const now = new Date();
      const isExpired = account.expiresAt < now;

      if (isExpired) {
        // Tentar renovar token
        try {
          const newTokens = await ShopeeOAuthService.refreshAccessToken(
            account.refreshToken,
            account.shopId!,
          );

          // Atualizar tokens no banco
          await MarketplaceRepository.updateTokens(account.id, {
            accessToken: newTokens.access_token,
            refreshToken: newTokens.refresh_token,
            expiresAt: new Date(Date.now() + newTokens.expire_in * 1000),
          });

          return {
            connected: true,
            account,
            message: "Conta conectada e token renovado",
          };
        } catch (refreshError) {
          // Se falhar ao renovar, marcar como erro
          await MarketplaceRepository.updateStatus(
            account.id,
            AccountStatus.ERROR,
          );

          return {
            connected: false,
            account,
            message: "Token expirado e não foi possível renovar",
          };
        }
      }

      return {
        connected: account.status === AccountStatus.ACTIVE,
        account,
        message: "Conta conectada",
      };
    } catch (error) {
      return {
        connected: false,
        message: `Erro ao verificar status: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  /**
   * Desconecta conta Shopee do usuário
   */
  static async disconnectShopeeAccount(userId: string): Promise<void> {
    try {
      const account = await MarketplaceRepository.findByUserIdAndPlatform(
        userId,
        Platform.SHOPEE,
      );

      if (!account) {
        throw new Error("Conta Shopee não encontrada");
      }

      // Remover tokens e marcar como inativa
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: "",
        refreshToken: "",
        expiresAt: new Date(),
      });

      await MarketplaceRepository.updateStatus(
        account.id,
        AccountStatus.INACTIVE,
      );
    } catch (error) {
      throw new Error(
        `Erro ao desconectar conta Shopee: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

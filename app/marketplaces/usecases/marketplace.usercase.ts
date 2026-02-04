import { MLOAuthService } from "../services/ml-oauth.service";
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
}

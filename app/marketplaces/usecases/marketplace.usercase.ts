import { MLOAuthService } from "../services/ml-oauth.service";
import { MLApiService } from "../services/ml-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { SystemLogService } from "../../services/system-log.service";
import { MarketplaceAccountService } from "../services/marketplace-account.service";
import { Platform, AccountStatus } from "@prisma/client";

/**
 * Casos de uso para gerenciar contas de marketplace
 * Orquestra fluxo OAuth e persistÃªncia
 */
export class MarketplaceUseCase {
  /**
   * Inicia fluxo OAuth para Mercado Livre
   * Retorna URL para qual o usuÃ¡rio deve ser redirecionado
   * @param userId - ID do usuÃ¡rio (opcional, para associar conta apÃ³s callback)
   */
  static initiateOAuth(userId?: string): { authUrl: string; state: string } {
    const oauthData = MLOAuthService.generateAuthUrl(userId);

    return {
      authUrl: oauthData.authUrl,
      state: oauthData.state,
    };
  }

  /**
   * Processa callback do OAuth apÃ³s usuÃ¡rio autorizar no Mercado Livre
   * userId pode vir do state (se foi iniciado com userId) ou do parÃ¢metro
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
        throw new Error("State invÃ¡lido ou expirado. Reinicie a autenticaÃ§Ã£o.");
      }

      const codeVerifier = stateValidation.codeVerifier!;
      // Usar userId do state se nÃ£o foi passado explicitamente
      const userId = data.userId || stateValidation.userId;

      if (!userId) {
        throw new Error("userId nÃ£o encontrado. FaÃ§a login e tente novamente.");
      }

      // 2. Trocar code por tokens
      const tokenData = await MLOAuthService.exchangeCodeForTokens(
        data.code,
        codeVerifier,
      );

      // 3. Obter informaÃ§Ãµes do usuÃ¡rio (seller) do Mercado Livre
      const userInfo = await MLOAuthService.getUserInfo(tokenData.accessToken);

      // 4. Verificar se jÃ¡ existe conta conectada
      const existingAccount =
        await MarketplaceRepository.findByUserAndExternalUserId(
          userId,
          tokenData.externalUserId,
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
   * ObtÃ©m status de conexÃ£o com marketplace
   */
  static async getAccountStatus(
    userId: string,
    platform: Platform = Platform.MERCADO_LIVRE,
    accountId?: string,
  ) {
    try {
      let account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            platform,
          ) ||
          // fallback: pega qualquer conta (ex.: todas estÃ£o com erro/expiradas)
          await MarketplaceRepository.findByUserIdAndPlatform(
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
          // Token expirou e nÃ£o conseguiu renovar â€” delegate to central handler
          await MarketplaceAccountService.handleAuthFailure(account.id, error, {
            userId,
            context: "AUTH_REFRESH",
          });

          return {
            connected: false,
            account,
            message: "Token expirado. Reconecte sua conta.",
          };
        }
      }

      // Capability check: detectar restriÃ§Ãµes do seller (ex.: seller.unable_to_list)
      try {
        const userInfo = await MLOAuthService.getUserInfo(account.accessToken);
        const sellerId = userInfo?.id?.toString();
        if (sellerId) {
          try {
            await MLApiService.getSellerItemIds(
              account.accessToken,
              sellerId,
              "active",
              1,
            );
          } catch (capErr: any) {
            const capMsg =
              capErr instanceof Error ? capErr.message : String(capErr);
            if (
              capMsg.includes("seller.unable_to_list") ||
              capMsg.includes("User is unable to list")
            ) {
              // Seller restriction detected (e.g. account cannot create listings).
              // Keep the account connected (do not mark ERROR) so user doesn't need to reconnect.
              await SystemLogService.logError(
                "CREATE_LISTING",
                `Capability check detected seller restriction: ${capMsg}`,
                {
                  userId,
                  resource: "MarketplaceAccount",
                  resourceId: account.id,
                  details: { mlError: capMsg },
                },
              );

              return {
                connected: true,
                account,
                restricted: true,
                message:
                  "Conta conectada, mas com restricao de anuncios no Mercado Livre (ver Seller Center).",
              };
            }

            // Detectar modo fÃ©rias / vacation e marcar como INACTIVE (nÃ£o Ã© erro permanente)
            if (
              capMsg.toLowerCase().includes("vacation") ||
              capMsg.toLowerCase().includes("fÃ©rias") ||
              capMsg.toLowerCase().includes("ferias") ||
              capMsg.toLowerCase().includes("on vacation")
            ) {
              await MarketplaceRepository.updateStatus(
                account.id,
                AccountStatus.INACTIVE,
              );
              await SystemLogService.logError(
                "CREATE_LISTING",
                `Capability check detected vacation mode: ${capMsg}`,
                {
                  userId,
                  resource: "MarketplaceAccount",
                  resourceId: account.id,
                  details: { mlError: capMsg },
                },
              );

              return {
                connected: false,
                account,
                message:
                  "Conta do Mercado Livre em modo fÃ©rias â€” ative a venda no Seller Center.",
              };
            }

            if (
              capMsg.toLowerCase().includes("unauthorized") ||
              capMsg.toLowerCase().includes("invalid access token")
            ) {
              await MarketplaceAccountService.handleAuthFailure(
                account.id,
                capMsg,
                {
                  userId,
                  context: "CAPABILITY_CHECK_AUTH",
                },
              );
              return {
                connected: false,
                account,
                message: "Token expirado. Reconecte sua conta.",
              };
            }
          }

          // Capability check succeeded: ensure DB status is ACTIVE so callers see fresh state
          if (account.status !== AccountStatus.ACTIVE) {
            account = await MarketplaceRepository.updateStatus(
              account.id,
              AccountStatus.ACTIVE,
            );
          }
        }
      } catch (capCheckErr) {
        console.warn(
          "[MarketplaceUseCase] capability check failed:",
          capCheckErr,
        );
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
    accountId?: string,
  ): Promise<void> {
    try {
      const account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findByUserIdAndPlatform(userId, platform);

      if (!account) {
        throw new Error(`Conta ${platform} nÃ£o encontrada`);
      }

      await MarketplaceRepository.deleteAccount(account.id);

      // Se restarem outras contas ativas do mesmo usuário/plataforma, manter estado conectado
      const remaining =
        await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          platform,
        );
      if (remaining.length === 0) {
        // nada extra; caller pode marcar desconectado
      }
    } catch (error) {
      throw new Error(
        `Erro ao desconectar conta: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ====================================================================
  // MÃ‰TODOS PARA SHOPEE
  // ====================================================================

  /**
   * Inicia fluxo OAuth para Shopee
   * Retorna URL para qual o usuÃ¡rio deve ser redirecionado
   * @param userId - ID do usuÃ¡rio (opcional, para associar conta apÃ³s callback)
   */
  static initiateShopeeOAuth(userId?: string): {
    authUrl: string;
    state: string;
  } {
    // Para Shopee, o userId Ã© armazenado no state da URL de callback
    // O shop_id vem no callback, entÃ£o nÃ£o precisamos dele aqui
    const oauthData = ShopeeOAuthService.initiateAuth(undefined, userId);

    return {
      authUrl: oauthData.auth_url,
      state: userId || "", // userId serÃ¡ usado no callback
    };
  }

  /**
   * Processa callback do OAuth apÃ³s usuÃ¡rio autorizar no Shopee
   * userId pode vir do state (se foi iniciado com userId) ou do parÃ¢metro
   */
  static async handleShopeeOAuthCallback(data: {
    code: string;
    shopId: number;
    userId?: string;
  }) {
    try {
      // Usar userId passado diretamente (vem da sessÃ£o)
      const userId = data.userId;

      if (!userId) {
        throw new Error("userId nÃ£o encontrado. FaÃ§a login e tente novamente.");
      }

      // 2. Trocar code por tokens
      const tokenData = await ShopeeOAuthService.exchangeCodeForTokens(
        data.code,
        data.shopId,
      );

      // 3. Verificar se jÃ¡ existe conta conectada
      const existingAccount =
        await MarketplaceRepository.findShopeeByUserAndShopId(userId, data.shopId);

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

        // Atualizar shopId se necessÃ¡rio
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
   * ObtÃ©m status da conta Shopee do usuÃ¡rio
   */
  static async getShopeeAccountStatus(userId: string, accountId?: string): Promise<{
    connected: boolean;
    account?: any;
    message: string;
  }> {
    try {
      const account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            Platform.SHOPEE,
          );

      if (!account) {
        return {
          connected: false,
          message: "Conta Shopee nÃ£o conectada",
        };
      }

      // Verificar se tokens sÃ£o vÃ¡lidos (nÃ£o expirados)
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
            message: "Token expirado e nÃ£o foi possÃ­vel renovar",
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
   * Desconecta conta Shopee do usuÃ¡rio
   */
  static async disconnectShopeeAccount(
    userId: string,
    accountId?: string,
  ): Promise<void> {
    try {
      const account = accountId
        ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
        : await MarketplaceRepository.findByUserIdAndPlatform(
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





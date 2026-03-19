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
        throw new Error(
          "State invÃ¡lido ou expirado. Reinicie a autenticaÃ§Ã£o.",
        );
      }

      const codeVerifier = stateValidation.codeVerifier!;
      // Usar userId do state se nÃ£o foi passado explicitamente
      const userId = data.userId || stateValidation.userId;

      if (!userId) {
        throw new Error(
          "userId nÃ£o encontrado. FaÃ§a login e tente novamente.",
        );
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
        console.log(
          `[handleOAuthCallback] Updating existing account=${existingAccount.id} externalUserId=${tokenData.externalUserId}`,
        );
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
        console.log(
          `[handleOAuthCallback] Creating NEW account for userId=${userId} externalUserId=${tokenData.externalUserId}`,
        );
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

      // 6. Desativar contas duplicadas/antigas do mesmo user+platform (exceto a atual)
      try {
        const allAccounts =
          await MarketplaceRepository.findAllByUserIdAndPlatform(
            userId,
            Platform.MERCADO_LIVRE,
          );
        for (const acc of allAccounts) {
          if (acc.id !== account.id) {
            console.log(
              `[handleOAuthCallback] Deactivating stale account=${acc.id} (keeping ${account.id})`,
            );
            await MarketplaceRepository.updateStatus(
              acc.id,
              AccountStatus.INACTIVE,
            );
          }
        }
      } catch (cleanupErr) {
        console.warn("[handleOAuthCallback] cleanup failed:", cleanupErr);
      }

      console.log(
        `[handleOAuthCallback] Done. account=${account.id} expiresAt=${expiresAt}`,
      );

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
        : (await MarketplaceRepository.findFirstActiveByUserAndPlatform(
            userId,
            platform,
          )) ||
          // fallback: pega qualquer conta (ex.: todas estão com erro/expiradas)
          (await MarketplaceRepository.findByUserIdAndPlatform(
            userId,
            platform,
          ));

      console.log(
        `[getAccountStatus] userId=${userId} platform=${platform} found=${!!account} id=${account?.id} status=${account?.status} expiresAt=${account?.expiresAt}`,
      );

      if (!account) {
        return {
          connected: false,
          message: `Nenhuma conta ${platform} conectada`,
        };
      }

      // Se a conta é ACTIVE, consideramos conectada desde o início.
      const isActive = account.status === AccountStatus.ACTIVE;

      const isExpired = new Date() > account.expiresAt;

      if (isExpired) {
        console.log(
          `[getAccountStatus] Token EXPIRED for account=${account.id}, trying refresh...`,
        );
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
          console.log(
            `[getAccountStatus] Refresh FAILED for account=${account.id}: ${error instanceof Error ? error.message : error}`,
          ); // Token expirou e nÃ£o conseguiu renovar â€” delegate to central handler
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

      // Capability check (non-destructive) - nunca muda connected para false em conta ACTIVE
      let restricted = false;
      try {
        const userInfo = await MLOAuthService.getUserInfo(account.accessToken);
        const sellerId = userInfo?.id?.toString();
        console.log(
          `[getAccountStatus] getUserInfo sellerId=${sellerId} accountId=${account.id}`,
        );
        if (sellerId) {
          try {
            await MLApiService.getSellerItemIds(
              account.accessToken,
              sellerId,
              "active",
              1,
            );
            console.log(
              `[getAccountStatus] capability check OK for account=${account.id}`,
            );
          } catch (capErr: any) {
            const capMsg =
              capErr instanceof Error ? capErr.message : String(capErr);
            console.log(
              `[getAccountStatus] capability error: ${capMsg} account=${account.id}`,
            );

            if (
              capMsg.includes("seller.unable_to_list") ||
              capMsg.includes("User is unable to list")
            ) {
              restricted = true;
            } else if (
              capMsg.toLowerCase().includes("vacation") ||
              capMsg.toLowerCase().includes("ferias") ||
              capMsg.toLowerCase().includes("on vacation")
            ) {
              restricted = true;
              console.warn(
                `[getAccountStatus] Seller vacation mode, account=${account.id}`,
              );
            } else if (
              capMsg.toLowerCase().includes("unauthorized") ||
              capMsg.toLowerCase().includes("invalid access token") ||
              capMsg.toLowerCase().includes("invalid_token")
            ) {
              const msUntilExpiry = account.expiresAt.getTime() - Date.now();
              const isFreshToken = msUntilExpiry > 5 * 60 * 60 * 1000;
              if (!isFreshToken) {
                await MarketplaceAccountService.handleAuthFailure(
                  account.id,
                  capMsg,
                  { userId, context: "CAPABILITY_CHECK_AUTH" },
                );
                console.log(
                  `[getAccountStatus] Token antigo invalido, marcando ERROR account=${account.id}`,
                );
                return {
                  connected: false,
                  account,
                  message: "Token expirado. Reconecte sua conta.",
                };
              }
              console.warn(
                `[getAccountStatus] Erro transitorio em token recente, ignorando`,
              );
            }
          }

          // Garantir status ACTIVE no DB
          if (account.status !== AccountStatus.ACTIVE) {
            account = await MarketplaceRepository.updateStatus(
              account.id,
              AccountStatus.ACTIVE,
            );
          }
        }
      } catch (capCheckErr) {
        console.warn(
          "[getAccountStatus] capability check failed (non-blocking):",
          capCheckErr instanceof Error ? capCheckErr.message : capCheckErr,
        );
      }

      const finalConnected =
        isActive || account.status === AccountStatus.ACTIVE;
      console.log(
        `[getAccountStatus] RESULT: connected=${finalConnected} restricted=${restricted} accountStatus=${account.status} isActive=${isActive}`,
      );

      return {
        connected: finalConnected,
        account,
        restricted,
        message: restricted
          ? "Conta conectada, mas com restricoes no Mercado Livre."
          : `Conta ${platform} conectada`,
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
      const remaining = await MarketplaceRepository.findAllByUserIdAndPlatform(
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
        throw new Error(
          "userId nÃ£o encontrado. FaÃ§a login e tente novamente.",
        );
      }

      // 2. Trocar code por tokens
      const tokenData = await ShopeeOAuthService.exchangeCodeForTokens(
        data.code,
        data.shopId,
      );

      // 3. Verificar se jÃ¡ existe conta conectada
      const existingAccount =
        await MarketplaceRepository.findShopeeByUserAndShopId(
          userId,
          data.shopId,
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
  static async getShopeeAccountStatus(
    userId: string,
    accountId?: string,
  ): Promise<{
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

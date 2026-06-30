/**
 * Helper de token por conta para o módulo de etiqueta — espelha o padrão de
 * `getRecentMLOrdersWithRefresh`/`getRecentShopeeOrdersWithRefresh`
 * (order.usercase.ts): tenta a chamada com o token atual; em erro de auth
 * (401/403), refresca, persiste no banco e retenta UMA vez.
 *
 * Reutilizado pelos adapters (ML/Shopee/Magalu). Não altera os clients existentes.
 */
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MagaluOAuthService } from "../services/magalu-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import type { ShippingAccount } from "./shipping-label.types";

/** Mesma heurística de OrderUseCase.isMarketplaceAuthError. */
export function isMarketplaceAuthError(error: unknown): boolean {
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) {
    return true;
  }
  return /unauthorized|invalid access token|token expired|forbidden/i.test(
    message,
  );
}

export class ShippingAuthRetry {
  /**
   * Executa `fn` com um access token válido do ML. Em erro de auth, refresca
   * via MLOAuthService.refreshAccessTokenForAccount, persiste e retenta.
   * Atualiza `account` in-place para chamadas subsequentes na mesma operação.
   */
  static async ml<T>(
    account: ShippingAccount,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(account.accessToken);
    } catch (error) {
      if (!isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }
      const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      account.accessToken = refreshed.accessToken;
      account.refreshToken = refreshed.refreshToken;
      return await fn(refreshed.accessToken);
    }
  }

  /**
   * Executa `fn` com (token, shopId) válidos da Shopee. Em erro de auth,
   * refresca via ShopeeOAuthService.refreshAccessToken, persiste e retenta.
   */
  static async shopee<T>(
    account: ShippingAccount,
    fn: (accessToken: string, shopId: number) => Promise<T>,
  ): Promise<T> {
    if (account.shopId == null) {
      throw new Error("Conta Shopee sem shopId");
    }
    const shopId = account.shopId;
    try {
      return await fn(account.accessToken, shopId);
    } catch (error) {
      if (!isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }
      const refreshed = await ShopeeOAuthService.refreshAccessToken(
        account.refreshToken,
        shopId,
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
      });
      account.accessToken = refreshed.access_token;
      account.refreshToken = refreshed.refresh_token;
      return await fn(refreshed.access_token, shopId);
    }
  }

  /**
   * Executa `fn` com um access token válido da Magalu. Em erro de auth, refresca
   * via MagaluOAuthService.refreshAccessTokenForAccount, persiste e retenta.
   * Mesma forma do `.ml` (o refresh devolve { accessToken, refreshToken,
   * expiresIn }).
   */
  static async magalu<T>(
    account: ShippingAccount,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(account.accessToken);
    } catch (error) {
      if (!isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }
      const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      account.accessToken = refreshed.accessToken;
      account.refreshToken = refreshed.refreshToken;
      return await fn(refreshed.accessToken);
    }
  }
}

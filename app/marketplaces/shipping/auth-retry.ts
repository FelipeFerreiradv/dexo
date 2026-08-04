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
import {
  MarketplaceIntegrationError,
  toIntegrationError,
  type IntegrationMarketplace,
} from "./integration-error";
import type { ShippingAccount } from "./shipping-label.types";

/** Códigos de erro de rede do Node/axios que valem nova tentativa. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);

/**
 * Falha transitória: repetir a MESMA requisição pode dar outro resultado.
 *
 * Deliberadamente conservador — só devolve true quando dá para AFIRMAR que é
 * transitório (429, 5xx, erro de rede). Erro sem classificação vira `false` e
 * não é retentado: repetir um 4xx determinístico só multiplica a chamada, e
 * retentar um 404 foi explicitamente descartado como "correção" no incidente de
 * 29/07/2026 — o 404 era path errado, nenhuma tentativa extra resolveria.
 */
export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof MarketplaceIntegrationError) {
    return error.isTransient;
  }
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code);
}

/** Backoff exponencial com jitter: 400ms, 800ms, 1600ms (± 25%). */
function backoffDelayMs(attempt: number): number {
  const base = 400 * 2 ** attempt;
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

/**
 * Executa `fn` retentando APENAS falhas transitórias, com backoff exponencial
 * e jitter. Desligável por `SHIPPING_LABEL_RETRY_DISABLED=1`.
 *
 * Fica AQUI, e não em volta do pipeline inteiro, de propósito: retentar
 * `produceRawLabel` reexecutaria `ship_order` e criaria envio duplicado. A
 * granularidade certa é a chamada HTTP individual.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; label?: string } = {},
): Promise<T> {
  if (process.env.SHIPPING_LABEL_RETRY_DISABLED === "1") {
    return fn();
  }
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1 || !isTransientProviderError(error)) {
        throw error;
      }
      const delay = backoffDelayMs(attempt);
      console.warn(
        `[Shipping] ${opts.label ?? "chamada"} falhou de forma transitória (tentativa ${attempt + 1}/${maxAttempts}); nova tentativa em ${delay}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Executa o refresh de token convertendo qualquer falha em erro TIPADO.
 *
 * Os `*OAuthService.refresh*` lançam `Error` puro (ex.: "Erro ao renovar token:
 * Request Source IP (…) is undeclared…"). Sem esta conversão, a falha de
 * refresh escapa do envelopamento do usecase e volta como HTTP 500 com o texto
 * cru na tela — a mesma classe de defeito do incidente de 29/07/2026, só que
 * pelo caminho do OAuth em vez do caminho da API.
 */
async function refreshOrThrowTyped<T>(
  marketplace: IntegrationMarketplace,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toIntegrationError(error, {
      marketplace,
      operation: `${marketplace.toLowerCase()}.oauth.refresh_token`,
      step: "token_refresh",
    });
  }
}

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
      return await withTransientRetry(() => fn(account.accessToken), {
        label: "ML",
      });
    } catch (error) {
      if (!isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }
      const refreshed = await refreshOrThrowTyped("MERCADO_LIVRE", () =>
        MLOAuthService.refreshAccessTokenForAccount(
          account.id,
          account.refreshToken!,
        ),
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      account.accessToken = refreshed.accessToken;
      account.refreshToken = refreshed.refreshToken;
      return await withTransientRetry(() => fn(refreshed.accessToken), {
        label: "ML (pós-refresh)",
      });
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
      return await withTransientRetry(() => fn(account.accessToken, shopId), {
        label: "Shopee",
      });
    } catch (error) {
      if (!isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }
      const refreshed = await refreshOrThrowTyped("SHOPEE", () =>
        ShopeeOAuthService.refreshAccessToken(account.refreshToken!, shopId),
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
      });
      account.accessToken = refreshed.access_token;
      account.refreshToken = refreshed.refresh_token;
      return await withTransientRetry(
        () => fn(refreshed.access_token, shopId),
        { label: "Shopee (pós-refresh)" },
      );
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
      return await withTransientRetry(() => fn(account.accessToken), {
        label: "Magalu",
      });
    } catch (error) {
      if (!isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }
      const refreshed = await refreshOrThrowTyped("MAGALU", () =>
        MagaluOAuthService.refreshAccessTokenForAccount(
          account.id,
          account.refreshToken!,
        ),
      );
      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      account.accessToken = refreshed.accessToken;
      account.refreshToken = refreshed.refreshToken;
      return await withTransientRetry(() => fn(refreshed.accessToken), {
        label: "Magalu (pós-refresh)",
      });
    }
  }
}

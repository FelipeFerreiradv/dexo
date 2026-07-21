import axios from "axios";
import { randomBytes } from "crypto";
import {
  FACEBOOK_CONSTANTS,
  facebookGraphBase,
  facebookDialogBase,
  validateFacebookConfig,
} from "../facebook/facebook-constants";
import type {
  FacebookTokenResponse,
  FacebookMeResponse,
} from "../types/facebook-oauth.types";

/**
 * Serviço de OAuth 2.0 com o Facebook/Meta (Graph API).
 *
 * ⚠️ Diferente da OLX (sem expiry) e do ML (refresh_token): o token da Meta
 * EXPIRA (~60 dias). Fluxo:
 *   1. code → short-lived token (GET /oauth/access_token).
 *   2. short-lived → long-lived (grant_type=fb_exchange_token, ~60d).
 *   3. salva o long-lived + `expiresAt` REAL na MarketplaceAccount.
 * NÃO há refresh endpoint clássico — quando o long-lived expira, o seller
 * refaz o OAuth (re-consent). Logo, como a OLX, este serviço é ENXUTO: sem
 * circuit-breaker/mutex/cron de refresh.
 *
 * Consent mora em www.facebook.com/{ver}/dialog/oauth; a troca de token e o
 * /me moram em graph.facebook.com/{ver}.
 */
export class FacebookOAuthService {
  // Estados CSRF in-memory (paridade com ML/Shopee/Magalu/OLX).
  private static pendingStates = new Map<
    string,
    { expiresAt: Date; userId?: string }
  >();

  /** Inicia o fluxo OAuth gerando a URL de consentimento da Meta. */
  static generateAuthUrl(userId?: string): { authUrl: string; state: string } {
    validateFacebookConfig();

    const state = randomBytes(FACEBOOK_CONSTANTS.STATE_LENGTH)
      .toString("hex")
      .substring(0, FACEBOOK_CONSTANTS.STATE_LENGTH);

    const expiresAt = new Date(Date.now() + FACEBOOK_CONSTANTS.STATE_TTL_MS);
    this.pendingStates.set(state, { expiresAt, userId });

    const authUrl = new URL(
      `${facebookDialogBase()}${FACEBOOK_CONSTANTS.OAUTH_DIALOG_ENDPOINT}`,
    );
    authUrl.searchParams.set("client_id", FACEBOOK_CONSTANTS.APP_ID!);
    authUrl.searchParams.set("redirect_uri", FACEBOOK_CONSTANTS.REDIRECT_URI);
    authUrl.searchParams.set("scope", FACEBOOK_CONSTANTS.SCOPES);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", state);

    return { authUrl: authUrl.toString(), state };
  }

  /** Valida o state recebido no callback (TTL + uso único). */
  static validateState(state: string): { valid: boolean; userId?: string } {
    const pendingState = this.pendingStates.get(state);
    if (!pendingState) {
      return { valid: false };
    }
    if (new Date() > pendingState.expiresAt) {
      this.pendingStates.delete(state);
      return { valid: false };
    }
    this.pendingStates.delete(state); // uso único
    return { valid: true, userId: pendingState.userId };
  }

  /**
   * Troca o authorization code por um token e imediatamente o promove a
   * long-lived (fb_exchange_token). Retorna o token final + `expiresAt` REAL
   * (derivado do expires_in do long-lived; fallback LONG_LIVED_TTL_MS).
   */
  static async exchangeCodeForToken(
    code: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    validateFacebookConfig();
    try {
      const shortLived = await this.requestToken({
        grant_type: undefined,
        client_id: FACEBOOK_CONSTANTS.APP_ID ?? "",
        client_secret: FACEBOOK_CONSTANTS.APP_SECRET ?? "",
        redirect_uri: FACEBOOK_CONSTANTS.REDIRECT_URI,
        code,
      });

      const longLived = await this.requestToken({
        grant_type: "fb_exchange_token",
        client_id: FACEBOOK_CONSTANTS.APP_ID ?? "",
        client_secret: FACEBOOK_CONSTANTS.APP_SECRET ?? "",
        fb_exchange_token: shortLived.access_token,
      });

      const ttlMs =
        typeof longLived.expires_in === "number" && longLived.expires_in > 0
          ? longLived.expires_in * 1000
          : FACEBOOK_CONSTANTS.LONG_LIVED_TTL_MS;

      return {
        accessToken: longLived.access_token,
        expiresAt: new Date(Date.now() + ttlMs),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const data: any = error.response?.data;
        throw new Error(
          `Erro ao trocar code por token (Facebook): ${
            data?.error?.message || data?.error_description || error.message
          }`,
        );
      }
      throw error;
    }
  }

  /** GET /oauth/access_token com os params dados (omite chaves undefined). */
  private static async requestToken(
    params: Record<string, string | undefined>,
  ): Promise<FacebookTokenResponse> {
    const url = new URL(
      `${facebookGraphBase()}${FACEBOOK_CONSTANTS.OAUTH_TOKEN_ENDPOINT}`,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, value);
    }
    const response = await axios.get<FacebookTokenResponse>(url.toString(), {
      timeout: FACEBOOK_CONSTANTS.REQUEST_TIMEOUT,
    });
    if (!response.data?.access_token) {
      throw new Error("Resposta da Meta sem access_token");
    }
    return response.data;
  }

  /**
   * Busca id/nome da conta (GET /me?fields=id,name). Usado no callback para
   * nomear a MarketplaceAccount e derivar o externalUserId. Best-effort: se
   * falhar, o callback ainda persiste a conta com fallback.
   */
  static async fetchMe(accessToken: string): Promise<FacebookMeResponse> {
    validateFacebookConfig();
    const url = new URL(
      `${facebookGraphBase()}${FACEBOOK_CONSTANTS.ME_ENDPOINT}`,
    );
    url.searchParams.set("fields", "id,name");
    url.searchParams.set("access_token", accessToken);
    const response = await axios.get<FacebookMeResponse>(url.toString(), {
      timeout: FACEBOOK_CONSTANTS.REQUEST_TIMEOUT,
    });
    return response.data ?? {};
  }

  static cleanupExpiredStates(): number {
    let removed = 0;
    const now = new Date();
    for (const [state, data] of this.pendingStates.entries()) {
      if (now > data.expiresAt) {
        this.pendingStates.delete(state);
        removed++;
      }
    }
    return removed;
  }
}

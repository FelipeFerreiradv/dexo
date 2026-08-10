import axios from "axios";
import { randomBytes } from "crypto";
import { OLX_CONSTANTS, validateOlxConfig } from "../olx/olx-constants";
import type {
  OlxTokenResponse,
  OlxBasicUserInfo,
} from "../types/olx-oauth.types";

/**
 * Serviço de OAuth 2.0 com a OLX (Authorization Code).
 *
 * ⚠️ INTENCIONALMENTE mais enxuto que o MagaluOAuthService. A OLX (validado
 * 2026-07-15) devolve SOMENTE `{ access_token, token_type:"Bearer" }` na troca
 * do code — SEM `refresh_token` e SEM `expires_in`. Logo NÃO há:
 *   - refreshAccessToken / refreshAccessTokenForAccount
 *   - circuit breaker de refresh terminal
 *   - mutex de refresh por conta
 * O access_token é salvo na MarketplaceAccount e reusado; se ele morrer, o
 * seller refaz o OAuth (re-consent). Não há o que renovar.
 *
 * O identificador externo da conta vem de POST /oauth_api/basic_user_info
 * (user_email), não de um JWT. Consent e token vivem em auth.olx.com.br; o
 * basic_user_info vive em apps.olx.com.br (API_URL).
 */
export class OlxOAuthService {
  // Estados CSRF in-memory (paridade com ML/Shopee/Magalu). `code` da OLX
  // expira em 10 min → o state usa o mesmo TTL.
  private static pendingStates = new Map<
    string,
    { expiresAt: Date; userId?: string }
  >();

  /**
   * Inicia o fluxo OAuth gerando a URL de consentimento da OLX.
   * Sem PKCE — apenas state (CSRF) + userId associado.
   */
  static generateAuthUrl(userId?: string): { authUrl: string; state: string } {
    validateOlxConfig();

    const state = randomBytes(OLX_CONSTANTS.STATE_LENGTH)
      .toString("hex")
      .substring(0, OLX_CONSTANTS.STATE_LENGTH);

    const expiresAt = new Date(Date.now() + OLX_CONSTANTS.STATE_TTL_MS);
    this.pendingStates.set(state, { expiresAt, userId });

    const authUrl = new URL(
      OLX_CONSTANTS.OAUTH_AUTHORIZE_ENDPOINT,
      OLX_CONSTANTS.AUTH_URL,
    );
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", OLX_CONSTANTS.CLIENT_ID!);
    authUrl.searchParams.set("redirect_uri", OLX_CONSTANTS.REDIRECT_URI);
    authUrl.searchParams.set("scope", OLX_CONSTANTS.SCOPES);
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
   * Troca o authorization code por token (x-www-form-urlencoded, conforme doc).
   * Retorna SÓ o access_token — a OLX não fornece refresh_token nem expires_in.
   */
  static async exchangeCodeForTokens(
    code: string,
  ): Promise<{ accessToken: string }> {
    validateOlxConfig();
    try {
      const tokenUrl = new URL(
        OLX_CONSTANTS.OAUTH_TOKEN_ENDPOINT,
        OLX_CONSTANTS.AUTH_URL,
      );

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OLX_CONSTANTS.CLIENT_ID ?? "",
        client_secret: OLX_CONSTANTS.CLIENT_SECRET ?? "",
        code,
        redirect_uri: OLX_CONSTANTS.REDIRECT_URI,
      });

      const response = await axios.post<OlxTokenResponse>(
        tokenUrl.toString(),
        body.toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: OLX_CONSTANTS.REQUEST_TIMEOUT,
        },
      );

      if (!response.data?.access_token) {
        throw new Error("Resposta da OLX sem access_token");
      }

      return { accessToken: response.data.access_token };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao trocar code por token (OLX): ${
            error.response?.data?.error_description ||
            error.response?.data?.message ||
            error.message
          }`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca nome/email da conta (POST /oauth_api/basic_user_info). Usado no
   * callback para nomear a MarketplaceAccount e derivar o externalUserId.
   * Best-effort: se falhar, o callback ainda persiste a conta com fallback.
   */
  static async fetchBasicUserInfo(
    accessToken: string,
  ): Promise<OlxBasicUserInfo> {
    validateOlxConfig();
    const url = new URL(
      OLX_CONSTANTS.BASIC_USER_INFO_ENDPOINT,
      OLX_CONSTANTS.API_URL,
    );
    const response = await axios.post<OlxBasicUserInfo>(
      url.toString(),
      { access_token: accessToken },
      {
        headers: { "Content-Type": "application/json" },
        timeout: OLX_CONSTANTS.REQUEST_TIMEOUT,
      },
    );
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

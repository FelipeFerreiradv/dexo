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
  //
  // `accountEmail` viaja junto porque o callback chega como redirect do
  // navegador, sem corpo: é a única forma de a identidade declarada pelo
  // vendedor sobreviver à ida e volta na OLX. Ver `fetchBasicUserInfo`.
  private static pendingStates = new Map<
    string,
    { expiresAt: Date; userId?: string; accountEmail?: string }
  >();

  /** Formato mínimo de e-mail. Não valida existência — só descarta digitação solta. */
  private static readonly ACCOUNT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /**
   * Normaliza o e-mail declarado da conta OLX para uso como `externalUserId`.
   *
   * Aqui o lowercase é DELIBERADO e não contradiz a regra de e-mail de
   * colaborador (que preserva a caixa): lá o e-mail é dado de exibição e de
   * login; aqui ele é CHAVE de identidade da conta no canal. Sem normalizar,
   * "Loja@x.com" e "loja@x.com" viram duas contas e a trava cross-tenant
   * deixaria de enxergar a colisão que existe para valer.
   */
  static normalizeAccountEmail(raw?: string | null): string {
    return (raw ?? "").trim().toLowerCase();
  }

  static isValidAccountEmail(raw?: string | null): boolean {
    return this.ACCOUNT_EMAIL_PATTERN.test(this.normalizeAccountEmail(raw));
  }

  /**
   * Inicia o fluxo OAuth gerando a URL de consentimento da OLX.
   * Sem PKCE — apenas state (CSRF) + userId e e-mail da conta associados.
   */
  static generateAuthUrl(
    userId?: string,
    accountEmail?: string,
  ): { authUrl: string; state: string } {
    validateOlxConfig();

    const state = randomBytes(OLX_CONSTANTS.STATE_LENGTH)
      .toString("hex")
      .substring(0, OLX_CONSTANTS.STATE_LENGTH);

    const expiresAt = new Date(Date.now() + OLX_CONSTANTS.STATE_TTL_MS);
    this.pendingStates.set(state, {
      expiresAt,
      userId,
      accountEmail: this.normalizeAccountEmail(accountEmail) || undefined,
    });

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
  static validateState(state: string): {
    valid: boolean;
    userId?: string;
    accountEmail?: string;
  } {
    const pendingState = this.pendingStates.get(state);
    if (!pendingState) {
      return { valid: false };
    }
    if (new Date() > pendingState.expiresAt) {
      this.pendingStates.delete(state);
      return { valid: false };
    }
    this.pendingStates.delete(state); // uso único
    return {
      valid: true,
      userId: pendingState.userId,
      accountEmail: pendingState.accountEmail,
    };
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
   *
   * ⚠️ FORA DO AR desde (pelo menos) 12/08/2026: `apps.olx.com.br` devolve 404
   * do nginx de origem neste path, com qualquer método, User-Agent ou corpo —
   * mesmo com a doc oficial (developers.olx.com.br, seção "API olx.com.br")
   * ainda documentando o endpoint. Não é bloqueio de bot: o mesmo host, no
   * mesmo IP, responde 401 com JSON em `/autoupload/v1/published`, e a resposta
   * 404 vem com `cf-cache-status: DYNAMIC` e sem `cf-mitigated`.
   *
   * Por isso a chamada continua BEST-EFFORT e o callback tem uma segunda fonte
   * de identidade: o e-mail declarado pelo vendedor ao conectar. Se a OLX
   * restaurar o endpoint, ele volta a ter precedência sozinho, sem mudar nada.
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

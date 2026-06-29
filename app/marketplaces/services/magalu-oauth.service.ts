import axios from "axios";
import { randomBytes } from "crypto";
import { MAGALU_CONSTANTS, validateMagaluConfig } from "../magalu/magalu-constants";

/**
 * Serviço de OAuth 2.0 com o ID Magalu (Authorization Code).
 *
 * Espelha a estrutura do MLOAuthService (state TTL + uso único, mutex de
 * refresh por conta, circuit breaker para erro terminal), porém:
 *  - SEM PKCE — a Magalu troca code→token server-to-server com client_secret.
 *  - Consent em AUTH_URL/login (?response_type=code&choose_tenants=true).
 *  - Troca de code = JSON; refresh = x-www-form-urlencoded (conforme doc).
 *  - O identificador externo da conta é o tenant_id (UUID), extraído do JWT
 *    do access_token (o webhook resolve a conta por tenant_id).
 */

interface MagaluTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  created_at?: number;
}

export class MagaluOAuthService {
  // Armazenamento temporário in-memory de estados (CSRF). Em produção,
  // idealmente Redis; mantém paridade com ML/Shopee (Map in-memory).
  private static pendingStates = new Map<
    string,
    { expiresAt: Date; userId?: string }
  >();

  /**
   * Inicia o fluxo OAuth gerando a URL de consentimento do ID Magalu.
   * Sem PKCE — apenas state (CSRF) + userId associado.
   */
  static generateAuthUrl(userId?: string): { authUrl: string; state: string } {
    validateMagaluConfig();

    const state = randomBytes(MAGALU_CONSTANTS.STATE_LENGTH)
      .toString("hex")
      .substring(0, MAGALU_CONSTANTS.STATE_LENGTH);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // TTL 10 min
    this.pendingStates.set(state, { expiresAt, userId });

    const authUrl = new URL(
      MAGALU_CONSTANTS.OAUTH_LOGIN_ENDPOINT,
      MAGALU_CONSTANTS.AUTH_URL,
    );
    authUrl.searchParams.set("client_id", MAGALU_CONSTANTS.CLIENT_ID!);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", MAGALU_CONSTANTS.REDIRECT_URI);
    authUrl.searchParams.set("scope", MAGALU_CONSTANTS.SCOPES);
    authUrl.searchParams.set("state", state);
    // Permite o seller escolher o tenant (loja) durante o consentimento.
    authUrl.searchParams.set("choose_tenants", "true");

    return { authUrl: authUrl.toString(), state };
  }

  /**
   * Valida o state recebido no callback (TTL + uso único).
   */
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
   * Troca o authorization code por tokens (JSON, conforme doc do ID Magalu).
   * Retorna também o externalUserId = tenant_id extraído do JWT.
   */
  static async exchangeCodeForTokens(code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    externalUserId: string;
  }> {
    validateMagaluConfig();
    try {
      const tokenUrl = new URL(
        MAGALU_CONSTANTS.OAUTH_TOKEN_ENDPOINT,
        MAGALU_CONSTANTS.AUTH_URL,
      );

      const response = await axios.post<MagaluTokenResponse>(
        tokenUrl.toString(),
        {
          grant_type: "authorization_code",
          client_id: MAGALU_CONSTANTS.CLIENT_ID,
          client_secret: MAGALU_CONSTANTS.CLIENT_SECRET,
          code,
          redirect_uri: MAGALU_CONSTANTS.REDIRECT_URI,
        },
        { headers: { "Content-Type": "application/json" } },
      );

      const externalUserId = this.extractTenantId(response.data.access_token);

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        externalUserId,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao trocar code por token (Magalu): ${
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
   * Circuit breaker in-memory para contas com erro terminal de OAuth
   * (mesmo racional do ML: evita loop de retry em webhooks/sync paralelos).
   */
  private static trippedAccounts = new Map<
    string,
    { errorCode: string; trippedAt: number }
  >();

  /**
   * Mutex em memória: refreshes em voo por accountId. Concurrent callers do
   * mesmo accountId aguardam a mesma Promise (evita invalidar o refresh_token
   * em corrida, igual ao ML).
   */
  private static refreshesInFlight = new Map<
    string,
    Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>
  >();

  static async refreshAccessTokenForAccount(
    accountId: string,
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const existing = this.refreshesInFlight.get(accountId);
    if (existing) {
      return existing;
    }

    const promise = this.doRefreshAccessTokenForAccount(
      accountId,
      refreshToken,
    ).finally(() => {
      this.refreshesInFlight.delete(accountId);
    });

    this.refreshesInFlight.set(accountId, promise);
    return promise;
  }

  private static async doRefreshAccessTokenForAccount(
    accountId: string,
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const tripped = this.trippedAccounts.get(accountId);
    if (tripped) {
      const err = new Error(
        `Erro ao renovar token (Magalu): conta ${accountId} em estado terminal (${tripped.errorCode})`,
      );
      (err as any).errorCode = tripped.errorCode;
      (err as any).circuitBreaker = true;
      throw err;
    }

    // Paridade com ML: suporta credenciais por conta (appClientId/Secret).
    // Para Magalu normalmente são nulas → cai no client do ambiente.
    let perAccountClientId: string | undefined;
    let perAccountClientSecret: string | undefined;
    try {
      const prismaMod = await import("@/app/lib/prisma");
      const prisma = prismaMod.default;
      const acc = await (prisma as any).marketplaceAccount.findUnique({
        where: { id: accountId },
        select: { appClientId: true, appClientSecret: true },
      });
      if (acc?.appClientId && acc?.appClientSecret) {
        perAccountClientId = acc.appClientId;
        perAccountClientSecret = acc.appClientSecret;
      }
    } catch {
      // fallback para credenciais do ambiente
    }

    try {
      return await this.refreshAccessToken(
        refreshToken,
        perAccountClientId,
        perAccountClientSecret,
      );
    } catch (err) {
      const errorCode = (err as any)?.errorCode as string | undefined;
      if (errorCode === "invalid_grant" || errorCode === "unauthorized") {
        this.trippedAccounts.set(accountId, {
          errorCode,
          trippedAt: Date.now(),
        });
        try {
          const prismaMod = await import("@/app/lib/prisma");
          const prisma = prismaMod.default;
          await (prisma as any).marketplaceAccount.update({
            where: { id: accountId },
            data: { status: "ERROR" },
          });
          console.warn(
            JSON.stringify({
              event: "magalu.oauth.account.auto_deactivated",
              accountId,
              errorCode,
              reason: "refresh terminal failure",
            }),
          );
        } catch (dbErr) {
          console.warn(
            `[MagaluOAuthService] failed to auto-deactivate account ${accountId}:`,
            dbErr instanceof Error ? dbErr.message : String(dbErr),
          );
        }
      }
      throw err;
    }
  }

  static clearAccountCircuitBreaker(accountId: string): void {
    this.trippedAccounts.delete(accountId);
  }

  /**
   * Renova o access_token via refresh_token (x-www-form-urlencoded).
   * A resposta pode rotacionar o refresh_token — devolvemos o novo.
   */
  static async refreshAccessToken(
    refreshToken: string,
    overrideClientId?: string,
    overrideClientSecret?: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    validateMagaluConfig();
    try {
      const tokenUrl = new URL(
        MAGALU_CONSTANTS.OAUTH_TOKEN_ENDPOINT,
        MAGALU_CONSTANTS.AUTH_URL,
      );

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: overrideClientId ?? MAGALU_CONSTANTS.CLIENT_ID ?? "",
        client_secret:
          overrideClientSecret ?? MAGALU_CONSTANTS.CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
      });

      const response = await axios.post<MagaluTokenResponse>(
        tokenUrl.toString(),
        body.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );

      return {
        accessToken: response.data.access_token,
        // Se a Magalu não rotacionar, mantém o refresh_token atual.
        refreshToken: response.data.refresh_token ?? refreshToken,
        expiresIn: response.data.expires_in,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const data: any = error.response?.data;
        const rawMessage: string =
          data?.error_description || data?.message || data?.error || error.message;

        let errorCode = "unknown";
        if (/invalid[_\s-]?grant/i.test(rawMessage)) {
          errorCode = "invalid_grant";
        } else if (error.response?.status === 401) {
          errorCode = "unauthorized";
        } else if (error.response?.status === 400) {
          errorCode = "bad_request";
        }

        console.warn(
          JSON.stringify({
            event: "magalu.oauth.refresh.failed",
            errorCode,
            status: error.response?.status,
            message: rawMessage,
          }),
        );

        const wrapped = new Error(`Erro ao renovar token (Magalu): ${rawMessage}`);
        (wrapped as any).cause = error;
        (wrapped as any).errorCode = errorCode;
        throw wrapped;
      }
      throw error;
    }
  }

  /**
   * Extrai o tenant_id do JWT do access_token. A claim exata depende do ID
   * Magalu — tentamos os nomes mais prováveis de forma defensiva. ESTE PONTO
   * deve ser validado contra um token real (sem Sandbox no momento).
   */
  static extractTenantId(accessToken: string): string {
    try {
      const payloadSegment = accessToken.split(".")[1];
      if (!payloadSegment) return "";
      const json = Buffer.from(payloadSegment, "base64").toString("utf-8");
      const payload = JSON.parse(json) as Record<string, any>;

      const candidate =
        payload.tenant_id ??
        payload.tenant ??
        (Array.isArray(payload.tenants)
          ? (payload.tenants[0]?.id ?? payload.tenants[0])
          : undefined) ??
        payload.sub;

      return candidate != null ? String(candidate) : "";
    } catch {
      return "";
    }
  }

  static isTokenExpired(expiresAt: Date): boolean {
    // Margem de 5 min, como a Shopee.
    return new Date(expiresAt.getTime() - 5 * 60 * 1000) <= new Date();
  }

  static calculateExpiryDate(expiresIn: number): Date {
    return new Date(Date.now() + expiresIn * 1000);
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

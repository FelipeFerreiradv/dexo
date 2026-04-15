import axios from "axios";
import { randomBytes } from "crypto";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import { PKCEService } from "./pkce.service";
import {
  MLOAuthTokenResponse,
  MLOAuthInitData,
  MLUserInfo,
} from "../types/ml-oauth.types";

/**
 * Serviço para gerenciar fluxo OAuth com Mercado Livre
 * Responsável por:
 * 1. Gerar URLs de autorização
 * 2. Trocar code por tokens
 * 3. Renovar tokens expirados
 */
export class MLOAuthService {
  // Armazenamento temporário in-memory de estados
  // Em produção, usar Redis ou session storage
  private static pendingStates = new Map<
    string,
    { codeVerifier: string; expiresAt: Date; userId?: string }
  >();

  /**
   * Inicia o fluxo OAuth gerando URL de autorização
   * Retorna: authUrl, state (para validar depois) e codeVerifier (para PKCE)
   * @param userId - ID do usuário (opcional, para associar conta após callback)
   */
  static generateAuthUrl(userId?: string): MLOAuthInitData {
    // Gerar PKCE pair
    const { codeVerifier, codeChallenge } = PKCEService.generatePKCEPair();

    // Gerar state aleatório para CSRF protection
    const state = randomBytes(ML_CONSTANTS.STATE_LENGTH)
      .toString("hex")
      .substring(0, ML_CONSTANTS.STATE_LENGTH);

    // Armazenar state + verifier + userId temporariamente (TTL: 10 minutos)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    this.pendingStates.set(state, { codeVerifier, expiresAt, userId });

    // Montar URL de autorização do Mercado Livre
    const authUrl = new URL(
      ML_CONSTANTS.OAUTH_AUTHORIZE_ENDPOINT,
      ML_CONSTANTS.AUTH_URL,
    );

    authUrl.searchParams.set("client_id", ML_CONSTANTS.CLIENT_ID!);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", ML_CONSTANTS.REDIRECT_URI);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    return {
      authUrl: authUrl.toString(),
      state,
      codeVerifier,
    };
  }

  /**
   * Valida o state recebido do callback
   * Garante que o state que recebemos é o mesmo que enviamos
   */
  static validateState(state: string): {
    valid: boolean;
    codeVerifier?: string;
    userId?: string;
  } {
    const pendingState = this.pendingStates.get(state);

    if (!pendingState) {
      return { valid: false };
    }

    // Verificar se expirou (TTL)
    if (new Date() > pendingState.expiresAt) {
      this.pendingStates.delete(state);
      return { valid: false };
    }

    // Remover state após uso (uma vez)
    this.pendingStates.delete(state);

    return {
      valid: true,
      codeVerifier: pendingState.codeVerifier,
      userId: pendingState.userId,
    };
  }

  /**
   * Troca authorization code por tokens
   * Chamada direta na API do Mercado Livre
   */
  static async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    externalUserId: string;
  }> {
    try {
      const tokenUrl = new URL(
        ML_CONSTANTS.OAUTH_TOKEN_ENDPOINT,
        ML_CONSTANTS.API_URL,
      );

      const response = await axios.post<MLOAuthTokenResponse>(
        tokenUrl.toString(),
        {
          grant_type: "authorization_code",
          client_id: ML_CONSTANTS.CLIENT_ID,
          client_secret: ML_CONSTANTS.CLIENT_SECRET,
          code,
          redirect_uri: ML_CONSTANTS.REDIRECT_URI,
          code_verifier: codeVerifier,
        },
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        externalUserId: response.data.user_id.toString(),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao trocar code por token: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Wrapper em cima de `refreshAccessToken` que, em caso de erro terminal
   * (client_id_mismatch, invalid_grant), marca a conta como ERROR no banco
   * para parar o loop de retry em webhooks/sync/listing. Use este método
   * sempre que houver um `accountId` conhecido.
   */
  static async refreshAccessTokenForAccount(
    accountId: string,
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    try {
      return await this.refreshAccessToken(refreshToken);
    } catch (err) {
      const errorCode = (err as any)?.errorCode as string | undefined;
      if (
        errorCode === "client_id_mismatch" ||
        errorCode === "invalid_grant"
      ) {
        try {
          const prismaMod = await import("@/app/lib/prisma");
          const prisma = prismaMod.default;
          await (prisma as any).marketplaceAccount.update({
            where: { id: accountId },
            data: { status: "ERROR" },
          });
          console.warn(
            JSON.stringify({
              event: "ml.oauth.account.auto_deactivated",
              accountId,
              errorCode,
              reason: "refresh terminal failure",
            }),
          );
        } catch (dbErr) {
          console.warn(
            `[MLOAuthService] failed to auto-deactivate account ${accountId}:`,
            dbErr instanceof Error ? dbErr.message : String(dbErr),
          );
        }
      }
      throw err;
    }
  }

  /**
   * Renova token expirado usando refresh_token
   * Chamada automática quando access_token expira
   */
  static async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    try {
      const tokenUrl = new URL(
        ML_CONSTANTS.OAUTH_TOKEN_ENDPOINT,
        ML_CONSTANTS.API_URL,
      );

      const response = await axios.post<MLOAuthTokenResponse>(
        tokenUrl.toString(),
        {
          grant_type: "refresh_token",
          client_id: ML_CONSTANTS.CLIENT_ID,
          client_secret: ML_CONSTANTS.CLIENT_SECRET,
          refresh_token: refreshToken,
        },
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const data: any = error.response?.data;
        const apiMessage: string =
          data?.message || data?.error_description || data?.error || "";
        const rawMessage = apiMessage || error.message;

        let errorCode: string = "unknown";
        if (/client_id does not match/i.test(rawMessage)) {
          errorCode = "client_id_mismatch";
        } else if (
          /invalid[_\s-]?grant/i.test(rawMessage) ||
          /refresh[_\s-]?token/i.test(rawMessage)
        ) {
          errorCode = "invalid_grant";
        } else if (error.response?.status === 401) {
          errorCode = "unauthorized";
        } else if (error.response?.status === 400) {
          errorCode = "bad_request";
        }

        console.warn(
          JSON.stringify({
            event: "ml.oauth.refresh.failed",
            errorCode,
            status: error.response?.status,
            message: rawMessage,
          }),
        );

        const wrapped = new Error(`Erro ao renovar token: ${rawMessage}`);
        (wrapped as any).cause = error;
        (wrapped as any).errorCode = errorCode;
        throw wrapped;
      }
      throw error;
    }
  }

  /**
   * Obtém informações do usuário/seller do Mercado Livre
   */
  static async getUserInfo(accessToken: string): Promise<MLUserInfo> {
    try {
      const response = await axios.get<MLUserInfo>(
        `${ML_CONSTANTS.API_URL}/users/me`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter informações do usuário: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Limpa estados expirados (cleanup)
   * Pode ser chamado periodicamente
   */
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

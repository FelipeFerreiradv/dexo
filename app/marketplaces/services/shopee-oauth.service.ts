import axios from "axios";
import crypto from "crypto";
import {
  SHOPEE_CONSTANTS,
  validateShopeeConfig,
} from "../shopee/shopee-constants";
import {
  ShopeeAccessToken,
  ShopeeAuthUrl,
  ShopeeRefreshToken,
  ShopeeSignatureParams,
} from "../types/shopee-oauth.types";

/**
 * Servico de autenticacao OAuth do Shopee
 * Baseado em HMAC-SHA256 signatures
 */
export class ShopeeOAuthService {
  // Armazenamento temporário in-memory de estados OAuth (como ML faz)
  // Mapeia stateToken → { userId, expiresAt }
  private static pendingStates = new Map<
    string,
    { userId: string; expiresAt: Date }
  >();

  /**
   * Gera token aleatório, armazena userId associado e retorna o token.
   * TTL: 10 minutos.
   */
  static storeState(userId: string): string {
    this.cleanupExpiredStates();
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    this.pendingStates.set(token, { userId, expiresAt });
    return token;
  }

  /**
   * Valida e consome o state token. Retorna userId ou null.
   * Remove o token após uso (one-time use).
   */
  static consumeState(stateToken: string): string | null {
    const entry = this.pendingStates.get(stateToken);
    if (!entry) return null;
    this.pendingStates.delete(stateToken);
    if (new Date() > entry.expiresAt) return null;
    return entry.userId;
  }

  /** Remove estados expirados para evitar memory leak */
  private static cleanupExpiredStates(): void {
    const now = new Date();
    for (const [key, data] of this.pendingStates.entries()) {
      if (now > data.expiresAt) {
        this.pendingStates.delete(key);
      }
    }
  }
  /**
   * Valida configuracao do Shopee antes de usar
   */
  private static validateConfig(): void {
    validateShopeeConfig();
  }

  /**
   * Assinatura HMAC-SHA256 usada nos endpoints v2 (token, API de negócio).
   */
  static generateSignature(params: ShopeeSignatureParams): string {
    this.validateConfig();

    const { partner_id, api_path, timestamp, access_token, shop_id } = params;

    let baseString = `${partner_id}${api_path}${timestamp}`;
    if (access_token) baseString += access_token;
    if (shop_id) baseString += shop_id.toString();

    const rawKey = SHOPEE_CONSTANTS.PARTNER_KEY!;
    // Shopee docs não dizem para decodificar a chave; assine com a string exata fornecida.
    const signature = crypto
      .createHmac("sha256", rawKey)
      .update(baseString)
      .digest("hex");

    if (process.env.SHOPEE_DEBUG === "1") {
      console.log("[ShopeeSign:HMAC] baseString", baseString);
      console.log(
        "[ShopeeSign:HMAC] sign",
        signature.slice(0, 6),
        "...",
        signature.slice(-6),
      );
    }

    return signature;
  }

  // Assinatura da URL de autorização v2 (shop/auth_partner) — segue a mesma
  // regra HMAC-SHA256 do restante da API (partner_id + api_path + timestamp).
  private static generateAuthUrlSignature(
    partnerId: number,
    apiPath: string,
    timestamp: number,
  ): string {
    // Conforme doc oficial: baseString = partner_id + api_path + timestamp
    // A chave é usada somente como segredo do HMAC, o redirect NÃO entra na assinatura.
    const baseString = `${partnerId}${apiPath}${timestamp}`;
    const rawKey = SHOPEE_CONSTANTS.PARTNER_KEY!;
    const sig = crypto
      .createHmac("sha256", rawKey)
      .update(baseString)
      .digest("hex");

    if (process.env.SHOPEE_DEBUG === "1") {
      console.log("[ShopeeSign:AUTH] baseString", baseString);
      console.log(
        "[ShopeeSign:AUTH] sign",
        sig.slice(0, 6),
        "...",
        sig.slice(-6),
      );
    }

    return sig;
  }

  private static buildSignedUrl(params: {
    apiPath: string;
    partnerId: number;
    timestamp: number;
    signature: string;
    extraQuery?: Record<string, string>;
  }): string {
    const { apiPath, partnerId, timestamp, signature, extraQuery } = params;
    const url = new URL(apiPath, SHOPEE_CONSTANTS.API_URL);
    url.searchParams.set("partner_id", partnerId.toString());
    url.searchParams.set("timestamp", timestamp.toString());
    url.searchParams.set("sign", signature);

    if (extraQuery) {
      for (const [key, value] of Object.entries(extraQuery)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  /**
   * Inicia fluxo de autenticacao com Shopee
   * Retorna URL para redirecionamento do usuario
   */
  static initiateAuth(
    redirectUri?: string,
    stateToken?: string,
  ): ShopeeAuthUrl {
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);
    const redirect = new URL(redirectUri || SHOPEE_CONSTANTS.REDIRECT_URI);

    // Embutir state token na redirect URL para recuperar userId no callback.
    // Shopee preserva query params existentes ao redirecionar de volta.
    if (stateToken) {
      redirect.searchParams.set("state", stateToken);
    }

    const signature = this.generateAuthUrlSignature(
      partnerId,
      "/api/v2/shop/auth_partner",
      timestamp,
    );

    const authUrl = this.buildSignedUrl({
      apiPath: "/api/v2/shop/auth_partner",
      partnerId,
      timestamp,
      signature,
      extraQuery: {
        redirect: redirect.toString(),
        sign_method: "sha256",
      },
    });

    return {
      auth_url: authUrl,
      partner_id: partnerId,
      timestamp,
    };
  }

  /**
   * Troca codigo de autorizacao por tokens de acesso
   */
  static async exchangeCodeForTokens(
    code: string,
    shopId: number,
  ): Promise<ShopeeAccessToken> {
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);
    const apiPath = "/api/v2/auth/token/get";

    const signature = this.generateSignature({
      partner_id: partnerId,
      api_path: apiPath,
      timestamp,
    });

    const url = this.buildSignedUrl({
      apiPath,
      partnerId,
      timestamp,
      signature,
    });

    const body = {
      code,
      shop_id: shopId,
      partner_id: partnerId,
    };

    try {
      const response = await axios.post<ShopeeAccessToken>(url, body, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao trocar codigo por tokens: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Renova token de acesso usando refresh token
   */
  static async refreshAccessToken(
    refreshToken: string,
    shopId: number,
  ): Promise<ShopeeRefreshToken> {
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);
    const apiPath = "/api/v2/auth/access_token/get";

    const signature = this.generateSignature({
      partner_id: partnerId,
      api_path: apiPath,
      timestamp,
    });

    const url = this.buildSignedUrl({
      apiPath,
      partnerId,
      timestamp,
      signature,
    });

    const body = {
      refresh_token: refreshToken,
      shop_id: shopId,
      partner_id: partnerId,
    };

    try {
      const response = await axios.post<ShopeeRefreshToken>(url, body, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao renovar token: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Verifica se token esta expirado
   */
  static isTokenExpired(expiresAt: Date): boolean {
    const safetyMargin = 5 * 60 * 1000;
    return new Date(expiresAt.getTime() - safetyMargin) < new Date();
  }

  /**
   * Calcula data de expiracao baseada no tempo de vida
   */
  static calculateExpiryDate(expiresIn: number): Date {
    return new Date(Date.now() + expiresIn * 1000);
  }
}

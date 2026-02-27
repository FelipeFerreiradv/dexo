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
  /**
   * Valida configuracao do Shopee antes de usar
   */
  private static validateConfig(): void {
    validateShopeeConfig();
  }

  /**
   * Gera assinatura HMAC-SHA256 para requests do Shopee
   */
  static generateSignature(params: ShopeeSignatureParams): string {
    this.validateConfig();

    const { partner_id, api_path, timestamp, access_token, shop_id } = params;

    // Ordem exigida pela Shopee para assinatura v2
    let baseString = `${partner_id}${api_path}${timestamp}`;

    if (access_token) {
      baseString += access_token;
    }

    if (shop_id) {
      baseString += shop_id.toString();
    }

    return crypto
      .createHmac("sha256", SHOPEE_CONSTANTS.PARTNER_KEY!)
      .update(baseString)
      .digest("hex");
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
  static initiateAuth(redirectUri?: string, state?: string): ShopeeAuthUrl {
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);
    const redirect = new URL(redirectUri || SHOPEE_CONSTANTS.REDIRECT_URI);

    // Preserva o userId no callback sem depender de cabecalho customizado
    if (state) {
      redirect.searchParams.set("state", state);
    }

    const signature = this.generateSignature({
      partner_id: partnerId,
      api_path: "/api/v2/shop/auth_partner",
      timestamp,
    });

    const authUrl = this.buildSignedUrl({
      apiPath: "/api/v2/shop/auth_partner",
      partnerId,
      timestamp,
      signature,
      extraQuery: {
        redirect: redirect.toString(),
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

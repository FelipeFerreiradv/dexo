import crypto from "crypto";
import axios from "axios";
import {
  SHOPEE_CONSTANTS,
  validateShopeeConfig,
} from "../shopee/shopee-constants";
import {
  ShopeeAuthParams,
  ShopeeAuthUrl,
  ShopeeAuthCallback,
  ShopeeAccessToken,
  ShopeeRefreshToken,
  ShopeeSignatureParams,
} from "../types/shopee-oauth.types";

/**
 * Serviço de autenticação OAuth do Shopee
 * Baseado em HMAC-SHA256 signatures
 */
export class ShopeeOAuthService {
  /**
   * Valida configuração do Shopee antes de usar
   */
  private static validateConfig(): void {
    validateShopeeConfig();
  }

  /**
   * Gera assinatura HMAC-SHA256 para requests do Shopee
   */
  private static generateSignature(params: ShopeeSignatureParams): string {
    this.validateConfig();

    const { partner_id, api_path, timestamp, access_token, shop_id, body } =
      params;

    // Concatenar parâmetros na ordem específica
    let baseString = `${partner_id}${api_path}${timestamp}`;

    if (access_token) {
      baseString += access_token;
    }

    if (shop_id) {
      baseString += shop_id.toString();
    }

    if (body) {
      baseString += body;
    }

    // debug log baseString
    console.log("[ShopeeOAuth] baseString=", JSON.stringify(baseString));

    // Gerar assinatura HMAC-SHA256
    const signature = crypto
      .createHmac("sha256", SHOPEE_CONSTANTS.PARTNER_KEY!)
      .update(baseString)
      .digest("hex");

    return signature;
  }

  /**
   * Inicia fluxo de autenticação com Shopee
   * Retorna URL para redirecionamento do usuário
   */
  static initiateAuth(redirectUri?: string): ShopeeAuthUrl {
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);
    const redirect = redirectUri || SHOPEE_CONSTANTS.REDIRECT_URI;

    // Gerar assinatura para o endpoint de autorização
    // Shopee exige que o domínio (origin) do redirect esteja no texto assinado.
    const redirectDomain = new URL(redirect).origin;
    const signature = this.generateSignature({
      partner_id: partnerId,
      api_path: "/api/v2/shop/auth_partner",
      timestamp,
      body: redirectDomain, // domain-only
    });

    // Construir URL de autorização
    const authUrl = new URL(
      "/api/v2/shop/auth_partner",
      SHOPEE_CONSTANTS.API_URL,
    );
    authUrl.searchParams.set("partner_id", partnerId.toString());
    authUrl.searchParams.set("redirect", redirect);
    authUrl.searchParams.set("timestamp", timestamp.toString());
    authUrl.searchParams.set("sign", signature);

    return {
      auth_url: authUrl.toString(),
      partner_id: partnerId,
      timestamp,
    };
  }

  /**
   * Troca código de autorização por tokens de acesso
   */
  static async exchangeCodeForTokens(
    code: string,
    shopId: number,
  ): Promise<ShopeeAccessToken> {
    const partnerId = parseInt(SHOPEE_CONSTANTS.PARTNER_ID!);
    const timestamp = Math.floor(Date.now() / 1000);

    const apiPath = "/api/v2/auth/token/get";
    const body = JSON.stringify({
      code,
      shop_id: shopId,
      partner_id: partnerId,
    });

    const signature = this.generateSignature({
      partner_id: partnerId,
      api_path: apiPath,
      timestamp,
      shop_id: shopId,
    });

    const url = `${SHOPEE_CONSTANTS.API_URL}${apiPath}`;

    try {
      const response = await axios.post<ShopeeAccessToken>(url, body, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `SHA256 Credential=${partnerId}, Timestamp=${timestamp}, Signature=${signature}`,
        },
        timeout: SHOPEE_CONSTANTS.REQUEST_TIMEOUT,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao trocar código por tokens: ${error.response?.data?.message || error.message}`,
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
    const body = JSON.stringify({
      refresh_token: refreshToken,
      shop_id: shopId,
      partner_id: partnerId,
    });

    const signature = this.generateSignature({
      partner_id: partnerId,
      api_path: apiPath,
      timestamp,
      shop_id: shopId,
    });

    const url = `${SHOPEE_CONSTANTS.API_URL}${apiPath}`;

    try {
      const response = await axios.post<ShopeeRefreshToken>(url, body, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `SHA256 Credential=${partnerId}, Timestamp=${timestamp}, Signature=${signature}`,
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
   * Verifica se token está expirado
   */
  static isTokenExpired(expiresAt: Date): boolean {
    // Adicionar margem de segurança de 5 minutos
    const safetyMargin = 5 * 60 * 1000;
    return new Date(expiresAt.getTime() - safetyMargin) < new Date();
  }

  /**
   * Calcula data de expiração baseada no tempo de vida
   */
  static calculateExpiryDate(expiresIn: number): Date {
    return new Date(Date.now() + expiresIn * 1000);
  }
}

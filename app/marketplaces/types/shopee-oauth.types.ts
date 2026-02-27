/**
 * Tipos para OAuth e autenticação do Shopee
 */

// Parâmetros para iniciar autenticação
export interface ShopeeAuthParams {
  partner_id: number;
  redirect_uri: string;
  timestamp: number;
  sign: string; // Assinatura HMAC-SHA256
}

// URL de autorização gerada
export interface ShopeeAuthUrl {
  auth_url: string;
  partner_id: number;
  timestamp: number;
}

// Callback do OAuth
export interface ShopeeAuthCallback {
  code: string;
  shop_id: number;
  partner_id: number;
}

// Token de acesso
export interface ShopeeAccessToken {
  access_token: string;
  refresh_token: string;
  expire_in: number; // segundos até expirar
  shop_id: number;
  partner_id: number;
  merchant_id: number;
  request_id: string;
}

// Refresh token
export interface ShopeeRefreshToken {
  access_token: string;
  refresh_token: string;
  expire_in: number;
  shop_id: number;
  partner_id: number;
  merchant_id: number;
  request_id: string;
}

// Informações da loja
export interface ShopeeShopInfo {
  shop_id: number;
  shop_name: string;
  shop_logo: string;
  shop_description: string;
  shop_website: string;
  shop_status: ShopeeShopStatus;
  country: string;
  created_time: number;
  modified_time: number;
}

export type ShopeeShopStatus = "NORMAL" | "BANNED" | "FROZEN" | "CLOSED";

// Parâmetros para gerar assinatura HMAC
export interface ShopeeSignatureParams {
  partner_id: number;
  api_path: string;
  timestamp: number;
  access_token?: string;
  shop_id?: number;
}

// Resposta de erro da API
export interface ShopeeApiError {
  error: string;
  message: string;
  request_id: string;
}

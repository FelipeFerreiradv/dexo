// Tipos específicos para OAuth do Mercado Livre
export interface MLOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
}

export interface MLOAuthInitData {
  authUrl: string;
  state: string;
  codeVerifier: string;
}

export interface MLOAuthCallbackData {
  code: string;
  state: string;
  codeVerifier: string;
}

export interface MLUserInfo {
  id: number;
  nickname: string;
  email: string;
  first_name?: string;
  last_name?: string;
  // Tags da conta (ex.: "user_product_seller"). Opcional: o GET /users/me
  // devolve, mas quem só usa id/nickname não depende disso.
  tags?: string[];
}

export interface PKCEData {
  codeVerifier: string;
  codeChallenge: string;
}

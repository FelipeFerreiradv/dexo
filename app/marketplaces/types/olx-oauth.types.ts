// Tipos do OAuth da OLX. VALIDADO 2026-07-15: a troca de code devolve SOMENTE
// { access_token, token_type }. NÃO há refresh_token nem expires_in — o token é
// salvo e reusado; se morrer, refaz-se o OAuth (re-consent).

/** Resposta de POST /oauth/token (grant_type=authorization_code). */
export interface OlxTokenResponse {
  access_token: string;
  token_type: string; // "Bearer"
}

/** Resposta de POST /oauth_api/basic_user_info { access_token }. */
export interface OlxBasicUserInfo {
  user_name?: string;
  user_email?: string;
  [key: string]: unknown;
}

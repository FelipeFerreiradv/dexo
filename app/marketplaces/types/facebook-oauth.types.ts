// Tipos do OAuth do Facebook/Meta (Graph API). A troca de code devolve um token
// short-lived; trocamos por um long-lived (grant_type=fb_exchange_token, ~60d).
// Ambos os passos usam GET /oauth/access_token na Graph API.

/** Resposta de GET /oauth/access_token (troca de code OU fb_exchange_token). */
export interface FacebookTokenResponse {
  access_token: string;
  token_type?: string; // "bearer"
  // Segundos até expirar. A Meta pode omitir (ex.: alguns long-lived) — nesse
  // caso usa-se o fallback LONG_LIVED_TTL_MS das constantes.
  expires_in?: number;
}

/** Resposta de GET /me?fields=id,name — identifica a conta no callback. */
export interface FacebookMeResponse {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

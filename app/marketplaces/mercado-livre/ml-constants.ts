// Constantes para integração Mercado Livre
export const ML_CONSTANTS = {
  // URLs da API
  AUTH_URL: process.env.ML_AUTH_URL || "https://auth.mercadolibre.com.br",
  API_URL: process.env.ML_API_URL || "https://api.mercadolibre.com",

  // OAuth endpoints
  OAUTH_AUTHORIZE_ENDPOINT: "/authorization",
  OAUTH_TOKEN_ENDPOINT: "/oauth/token",

  // Credenciais
  CLIENT_ID: process.env.ML_CLIENT_ID,
  CLIENT_SECRET: process.env.ML_CLIENT_SECRET,

  // Callback
  REDIRECT_URI: `${process.env.APP_BACKEND_URL || "http://localhost:3333"}/marketplace/ml/callback`,

  // PKCE
  PKCE_CODE_LENGTH: 128,
  PKCE_CODE_ALPHABET:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~",

  // Token
  TOKEN_TYPE: "Bearer",

  // Estado (state) para CSRF
  STATE_LENGTH: 32,
};

// Validar configuração
export function validateMLConfig(): void {
  const requiredEnvVars = ["ML_CLIENT_ID", "ML_CLIENT_SECRET"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Variável de ambiente ${envVar} não configurada`);
    }
  }
}

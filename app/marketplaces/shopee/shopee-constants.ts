// Constantes para integração Shopee
export const SHOPEE_CONSTANTS = {
  // URLs da API
  SANDBOX_URL: "https://partner.test-stable.shopeemobile.com",
  PRODUCTION_URL: "https://partner.shopeemobile.com",

  // Usar produção por padrão (mudar para SANDBOX_URL se necessário)
  API_URL:
    process.env.SHOPEE_SANDBOX === "true"
      ? "https://partner.test-stable.shopeemobile.com"
      : "https://partner.shopeemobile.com",

  // Credenciais
  PARTNER_ID: process.env.SHOPEE_PARTNER_ID,
  PARTNER_KEY: process.env.SHOPEE_PARTNER_KEY,

  // Callback
  REDIRECT_URI: `${process.env.APP_BACKEND_URL || "http://localhost:3333"}/marketplace/shopee/callback`,

  // API Versions
  API_VERSION: "2",

  // Rate Limits (por minuto)
  RATE_LIMIT_ITEM_OPERATIONS: 100,
  RATE_LIMIT_SEARCH: 1000,

  // Timeouts
  REQUEST_TIMEOUT: 30000, // 30 segundos

  // Pagination
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 50,
};

// Validar configuração
export function validateShopeeConfig(): void {
  const requiredEnvVars = ["SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Variável de ambiente ${envVar} não configurada`);
    }
  }
}

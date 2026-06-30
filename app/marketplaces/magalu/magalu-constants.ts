// Constantes para integração Magalu (Plataforma do Grupo Magalu / ID Magalu).
// Espelha o padrão de ml-constants.ts. A integração inteira fica atrás da flag
// NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED; estas constantes só são exercitadas
// quando a flag está ligada e as MAGALU_* env vars estão presentes.

const SANDBOX = process.env.MAGALU_SANDBOX === "true";

export const MAGALU_CONSTANTS = {
  // ID Magalu — OAuth 2.0 (Authorization Code, sem PKCE; troca server-to-server
  // com client_secret). O consent e o token vivem no mesmo host (id.magalu.com).
  AUTH_URL: process.env.MAGALU_AUTH_URL || "https://id.magalu.com",

  // Plataforma de Marketplace (produtos/portfolio, pedidos). Produção
  // api.magalu.com; sandbox api-sandbox.magalu.com (confirmar contra a conta).
  API_URL:
    process.env.MAGALU_API_URL ||
    (SANDBOX ? "https://api-sandbox.magalu.com" : "https://api.magalu.com"),

  SANDBOX,

  // OAuth endpoints (relativos a AUTH_URL)
  OAUTH_LOGIN_ENDPOINT: "/login", // consent do seller (?response_type=code&choose_tenants=true)
  OAUTH_TOKEN_ENDPOINT: "/oauth/token", // troca de code (JSON) e refresh (form-urlencoded)

  // Marketplace endpoints (relativos a API_URL) — confirmar shapes na conta real.
  PORTFOLIO_SKUS_ENDPOINT: "/seller/v1/portfolios/skus",
  PORTFOLIO_PRICES_ENDPOINT: "/seller/v1/portfolios/prices",
  PORTFOLIO_STOCKS_ENDPOINT: "/seller/v1/portfolios/stocks",
  ORDERS_ENDPOINT: "/seller/v1/orders",
  WEBHOOK_SIGNUP_ENDPOINT: "/v1/onboarding/signup", // PUT → devolve segredo whsec_*

  // Credenciais (do app criado no ID Magalu)
  CLIENT_ID: process.env.MAGALU_CLIENT_ID,
  CLIENT_SECRET: process.env.MAGALU_CLIENT_SECRET,

  // Callback OAuth (no backend Fastify)
  REDIRECT_URI:
    process.env.MAGALU_REDIRECT_URI ||
    `${process.env.APP_BACKEND_URL || "http://localhost:3333"}/marketplace/magalu/callback`,

  // Escopos OAuth (separados por espaço) das APIs de MARKETPLACE do seller.
  // VALIDADO contra a API real: `apiin:all` é escopo do Magalu CLOUD (object
  // storage/VM/etc., criado pela CLI `idm`) e NÃO dá acesso ao seller das APIs
  // de marketplace — `/seller/v1/portfolios/*` exige estes `open:*-seller`.
  // O client precisa ser criado COM estes escopos (portal developers.magalu.com)
  // e autorizado com o tenant da LOJA (PJ), não um tenant "person".
  SCOPES:
    process.env.MAGALU_SCOPES ||
    [
      "open:portfolio-skus-seller:read",
      "open:portfolio-skus-seller:write",
      "open:portfolio-prices-seller:read",
      "open:portfolio-prices-seller:write",
      "open:portfolio-stocks-seller:read",
      "open:portfolio-stocks-seller:write",
      "open:portfolio-categories-seller:read",
      "open:order-order-seller:read",
      "open:order-delivery-seller:read",
    ].join(" "),

  // Segredo de assinatura do webhook (whsec_*). Usado para validar X-Signature-256.
  WEBHOOK_SECRET: process.env.MAGALU_WEBHOOK_SECRET,

  // Token
  TOKEN_TYPE: "Bearer",

  // Estado (state) para CSRF
  STATE_LENGTH: 32,

  // Resolução de categoria: viés de domínio. A busca por nome (similaridade)
  // mistura domínios (ex.: "Tampa" devolve itens de cozinha/piscina); como o
  // perfil do Dexo é desmonte/autopeças, filtramos os resultados cujo `path`
  // começa por este hint. Sem match confiável no domínio → SKU fica em DRAFT
  // (melhor que categorizar errado). Vazio/"" desliga o viés (pega o 1º match).
  CATEGORY_ROOT_HINT:
    process.env.MAGALU_CATEGORY_ROOT_HINT ?? "Veículos e Peças",

  // Limites de anúncio — PROVISÓRIOS até confirmar na doc/conta real.
  TITLE_MAX_LENGTH: 150,
  DESCRIPTION_MAX_LENGTH: 8000,
  MIN_IMAGE_DIMENSION_PX: 300,
  MAX_IMAGES_PER_SKU: 10,

  // Timeouts/paginação
  REQUEST_TIMEOUT: 30000,
  DEFAULT_PAGE_SIZE: 50,
} as const;

/**
 * Valida a config do Magalu em RUNTIME (não no boot). Chamar nos serviços
 * magalu-* antes de qualquer chamada à API. Mantém o boot da API intacto
 * mesmo quando a integração não está configurada (flag desligada).
 */
export function validateMagaluConfig(): void {
  const requiredEnvVars = ["MAGALU_CLIENT_ID", "MAGALU_CLIENT_SECRET"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(
        `Variável de ambiente ${envVar} não configurada (integração Magalu)`,
      );
    }
  }
}

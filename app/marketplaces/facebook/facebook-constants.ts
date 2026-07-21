// Constantes da integração Facebook/Meta (Commerce Catalog via Graph API).
// Espelha o padrão de olx-constants.ts + whatsapp-constants.ts. A integração
// inteira fica atrás da flag NEXT_PUBLIC_FACEBOOK_INTEGRATION_ENABLED; estas
// constantes só são exercitadas quando a flag está ligada e as FACEBOOK_* env
// vars estão presentes.
//
// Caminho ESCOLHIDO: Meta Commerce / Catálogo (FB & Instagram Shops). O Facebook
// NÃO tem API pública de Marketplace clássico (Partner API é invite-only). O
// produto vira ITEM DE CATÁLOGO, não anúncio de Marketplace.
//
// Diferenças-chave vs. OLX (moldam o desenho):
//   - API = Graph Catalog Batch: PUT/POST /{catalog_id}/items_batch, síncrono em
//     lote (requests[]), item endereçado por `retailer_id` (= SKU). Não é
//     autoupload async com poll de token (mas há check_batch_request_status).
//   - OAuth = Meta Graph: token EXPIRA (~60d). Troca short-lived → long-lived
//     (grant_type=fb_exchange_token) e salva `expiresAt` REAL. Sem refresh
//     endpoint → re-OAuth quando expira (enxuto como a OLX, sem cron/mutex).
//   - Estoque zero = UPDATE availability='out of stock' (item PERMANECE no
//     catálogo), refill = 'in stock'. NÃO deleta/reinsere como a OLX. DELETE só
//     no desvínculo real (removeFacebookListing).
//   - Token vai no header Authorization: Bearer (Graph aceita), não no corpo.

export const FACEBOOK_CONSTANTS = {
  // Graph API (troca de token, /me, items_batch). Versão fixada por constante
  // (mesma do WhatsApp: v25.0). Override por env para bump sem redeploy.
  GRAPH_BASE_URL:
    process.env.FACEBOOK_GRAPH_BASE_URL || "https://graph.facebook.com",
  API_VERSION: process.env.FACEBOOK_API_VERSION || "v25.0",

  // Host do DIÁLOGO de consentimento OAuth (≠ graph.facebook.com). O consent do
  // usuário mora em www.facebook.com/{version}/dialog/oauth.
  DIALOG_BASE_URL:
    process.env.FACEBOOK_DIALOG_BASE_URL || "https://www.facebook.com",

  // App Meta (tipo Business). Mesmo modelo do app que o WhatsApp já usa.
  APP_ID: process.env.FACEBOOK_APP_ID,
  APP_SECRET: process.env.FACEBOOK_APP_SECRET,

  // ID do Catálogo (Commerce Manager). Alvo do items_batch.
  CATALOG_ID: process.env.FACEBOOK_CATALOG_ID,

  // Endpoints (relativos, montados com GRAPH_BASE_URL/API_VERSION ou DIALOG).
  OAUTH_DIALOG_ENDPOINT: "/dialog/oauth", // GET consent (em DIALOG_BASE_URL)
  OAUTH_TOKEN_ENDPOINT: "/oauth/access_token", // GET troca code→token (em GRAPH)
  ME_ENDPOINT: "/me", // GET id/name da conta

  // Callback OAuth. Prod: https://usedexo.com.br/integracoes/facebook/callback.
  REDIRECT_URI:
    process.env.FACEBOOK_REDIRECT_URI ||
    `${process.env.APP_BACKEND_URL || "http://localhost:3333"}/marketplace/facebook/callback`,

  // Escopos OAuth (separados por vírgula, padrão Meta). `catalog_management`
  // libera escrever no catálogo; `business_management` p/ ler o Business/contas.
  SCOPES:
    process.env.FACEBOOK_SCOPES ||
    ["catalog_management", "business_management"].join(","),

  // URL base da PÁGINA de produto — o item de catálogo EXIGE `link`. Sem ela o
  // build de payload falha com erro claro (pendente de decisão do cliente).
  // link = `${PRODUCT_URL_BASE}/${sku}` quando setada.
  PRODUCT_URL_BASE: process.env.FB_PRODUCT_URL_BASE || "",

  // Moeda dos preços do catálogo (ISO 4217).
  CURRENCY: process.env.FACEBOOK_CURRENCY || "BRL",

  // TTL de fallback do long-lived token quando a Meta não devolve expires_in
  // (~60 dias). O valor real vem de expires_in na troca fb_exchange_token.
  LONG_LIVED_TTL_MS: 60 * 24 * 60 * 60 * 1000,

  // Estado (state) para CSRF do OAuth.
  STATE_LENGTH: 32,
  STATE_TTL_MS: 10 * 60 * 1000,

  // Limites do item de catálogo (Graph Product Item):
  TITLE_MAX_LENGTH: 200, // `name`
  DESCRIPTION_MAX_LENGTH: 9999, // `description`
  RETAILER_ID_MAX_LENGTH: 100, // `retailer_id` (SKU)
  MAX_IMAGES_PER_ITEM: 20, // image_url + additional_image_urls (1ª = principal)
  MAX_REQUESTS_PER_BATCH: 5000, // teto do items_batch

  // Poll do status do batch (check_batch_request_status): a Meta processa o
  // items_batch de forma assíncrona, então erros por-item (categoria/link/imagem
  // inválidos) só aparecem no status — o corpo do POST devolve 200 + handles
  // mesmo quando o item é rejeitado. Espelha o poll do autoupload da OLX.
  BATCH_POLL_INTERVAL_MS: 1500,
  BATCH_POLL_MAX_ATTEMPTS: 8,

  // Timeout por request (espelha OLX/WhatsApp).
  REQUEST_TIMEOUT: 30000,
} as const;

/** Base da Graph API já com versão (ex.: https://graph.facebook.com/v25.0). */
export function facebookGraphBase(): string {
  return `${FACEBOOK_CONSTANTS.GRAPH_BASE_URL}/${FACEBOOK_CONSTANTS.API_VERSION}`;
}

/** Base do diálogo OAuth já com versão. */
export function facebookDialogBase(): string {
  return `${FACEBOOK_CONSTANTS.DIALOG_BASE_URL}/${FACEBOOK_CONSTANTS.API_VERSION}`;
}

/**
 * Valida a config do Facebook em RUNTIME (não no boot). Chamar nos serviços
 * facebook-* antes de qualquer chamada à API. Mantém o boot da API intacto
 * mesmo quando a integração não está configurada (flag desligada / credenciais
 * pendentes) — mesmo contrato de validateOlxConfig/validateMagaluConfig.
 */
export function validateFacebookConfig(): void {
  const requiredEnvVars = [
    "FACEBOOK_APP_ID",
    "FACEBOOK_APP_SECRET",
    "FACEBOOK_CATALOG_ID",
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(
        `Variável de ambiente ${envVar} não configurada (integração Facebook)`,
      );
    }
  }
}

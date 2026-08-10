// Constantes para integração OLX (autoupload / anúncios).
// Espelha o padrão de magalu-constants.ts. A integração inteira fica atrás da
// flag NEXT_PUBLIC_OLX_INTEGRATION_ENABLED; estas constantes só são exercitadas
// quando a flag está ligada e as OLX_* env vars estão presentes.
//
// Contratos VALIDADOS contra os docs oficiais (developers.olx.com.br, portal
// logado, 2026-07-15). Diferenças-chave vs. Magalu (moldam o desenho):
//   - OAuth NÃO devolve refresh_token nem expires_in → salvar access_token e
//     refazer o OAuth se ele morrer (sem refresh/circuit-breaker/mutex).
//   - Hosts SEPARADOS: OAuth em auth.olx.com.br; autoupload em apps.olx.com.br.
//   - API é autoupload assíncrona EM LOTE (PUT /autoupload/import → token; poll
//     de status depois). Não é REST per-SKU.
//   - Operações só insert|delete (editar = insert com o mesmo id; sem "pausar").

const SANDBOX = process.env.OLX_SANDBOX === "true";

export const OLX_CONSTANTS = {
  // OAuth 2.0 (Authorization Code, sem PKCE; troca server-to-server com
  // client_secret). Consent e token vivem no host de AUTENTICAÇÃO auth.olx.com.br.
  AUTH_URL: process.env.OLX_AUTH_URL || "https://auth.olx.com.br",

  // Autoupload / basic_user_info vivem em apps.olx.com.br (host DIFERENTE do OAuth).
  API_URL: process.env.OLX_API_URL || "https://apps.olx.com.br",

  SANDBOX,

  // OAuth endpoints (relativos a AUTH_URL)
  OAUTH_AUTHORIZE_ENDPOINT: "/oauth", // GET consent (?response_type=code&client_id&redirect_uri&scope&state)
  OAUTH_TOKEN_ENDPOINT: "/oauth/token", // POST x-www-form-urlencoded (grant_type=authorization_code)

  // Endpoints de API (relativos a API_URL)
  AUTOUPLOAD_ENDPOINT: "/autoupload/import", // PUT em lote → { token, statusCode, ... }
  IMPORT_STATUS_ENDPOINT: "/autoupload/import", // POST /autoupload/import/{token} (polling)
  BASIC_USER_INFO_ENDPOINT: "/oauth_api/basic_user_info", // POST { access_token } → { user_name, user_email }

  // Credenciais (do app registrado por email em suporteintegrador@olxbr.com —
  // OLX não tem portal self-service de credenciais).
  CLIENT_ID: process.env.OLX_CLIENT_ID,
  CLIENT_SECRET: process.env.OLX_CLIENT_SECRET,

  // Callback OAuth (no backend Fastify). Prod registrado na OLX:
  // https://usedexo.com.br/integracoes/olx/callback
  REDIRECT_URI:
    process.env.OLX_REDIRECT_URI ||
    `${process.env.APP_BACKEND_URL || "http://localhost:3333"}/marketplace/olx/callback`,

  // Escopos OAuth (separados por espaço). `autoupload` é o que libera enviar
  // anúncios; `basic_user_info` p/ ler nome/email da conta no callback.
  SCOPES: process.env.OLX_SCOPES || ["basic_user_info", "autoupload"].join(" "),

  // Dados de contato do VENDEDOR exigidos em cada anúncio (a OLX não os deriva
  // do produto/conta). Configuráveis por env — a Jotabê é o único seller hoje.
  SELLER_PHONE: process.env.OLX_SELLER_PHONE || "",
  SELLER_ZIPCODE: process.env.OLX_SELLER_ZIPCODE || "",

  // Token — OLX devolve só { access_token, token_type:"Bearer" }.
  TOKEN_TYPE: "Bearer",

  // Estado (state) para CSRF do OAuth. `code` da OLX expira em 10 min.
  STATE_LENGTH: 32,
  STATE_TTL_MS: 10 * 60 * 1000,

  // Limites REAIS do anúncio (import.html, v3):
  ID_MAX_LENGTH: 19, // `id` do ad_list: 1-19 chars A-Za-z0-9_{}-
  ID_PATTERN: /^[A-Za-z0-9_{}-]{1,19}$/,
  TITLE_MIN_LENGTH: 2, // Subject 2-90
  TITLE_MAX_LENGTH: 90,
  DESCRIPTION_MIN_LENGTH: 2, // Body 2-6000
  DESCRIPTION_MAX_LENGTH: 6000,
  MAX_IMAGES_PER_AD: 20, // 1ª imagem = principal
  MAX_VIDEOS_PER_AD: 1, // só YouTube
  MAX_PAYLOAD_BYTES: 1024 * 1024, // 1 MB
  // OLX recusa foto pequena (ERROR_IMAGE_TOO_SMALL). Sem validação por fetch: o
  // upload já força lado curto ≥ 1000px (image-resize.service).
  MIN_IMAGE_DIMENSION_PX: 300,

  // Resolução de categoria: viés de domínio (autopeças). Espelha o hint do
  // Magalu. Vazio/"" desliga o viés.
  CATEGORY_ROOT_HINT: process.env.OLX_CATEGORY_ROOT_HINT ?? "Autopeças",

  // Polling do status de import (async: poll até autoupload_status="done").
  IMPORT_POLL_INTERVAL_MS: 2000,
  IMPORT_POLL_MAX_ATTEMPTS: 15,

  // Timeouts
  REQUEST_TIMEOUT: 30000,
} as const;

/**
 * Valida a config da OLX em RUNTIME (não no boot). Chamar nos serviços olx-*
 * antes de qualquer chamada à API. Mantém o boot da API intacto mesmo quando a
 * integração não está configurada (flag desligada / credenciais pendentes).
 */
export function validateOlxConfig(): void {
  const requiredEnvVars = ["OLX_CLIENT_ID", "OLX_CLIENT_SECRET"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(
        `Variável de ambiente ${envVar} não configurada (integração OLX)`,
      );
    }
  }
}

// Constantes para integração Shopee
export const SHOPEE_CONSTANTS = {
  // URLs da API
  SANDBOX_URL: "https://partner.test-stable.shopeemobile.com",
  PRODUCTION_URL: "https://partner.shopeemobile.com",

  // Usar produção por padrão (mudar para SANDBOX_URL se necessário)
  API_URL:
    process.env.SHOPEE_API_URL ||
    (process.env.SHOPEE_SANDBOX === "true"
      ? "https://partner.test-stable.shopeemobile.com"
      : "https://partner.shopeemobile.com"),

  // Credenciais (trim para remover espaços/quebras indesejadas)
  PARTNER_ID: process.env.SHOPEE_PARTNER_ID?.trim(),
  PARTNER_KEY: process.env.SHOPEE_PARTNER_KEY?.trim(),

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

/**
 * Paths da Open Platform v2 usados no fluxo de etiqueta de envio, AGRUPADOS
 * PELO MÓDULO REAL da Shopee.
 *
 * Existem como constantes nomeadas por causa do incidente de 29/07/2026: o
 * `upload_invoice_doc` estava escrito à mão como `/api/v2/logistics/...` por
 * analogia com os vizinhos, mas na Shopee ele pertence ao módulo `order`. O
 * gateway responde 404 `error_not_found` a path inexistente, e o catch de
 * então descartava o corpo — o erro chegava ao usuário como
 * "Request failed with status code 404".
 *
 * Agrupar por módulo torna "endpoint no módulo errado" visível na revisão.
 * Ao acrescentar endpoint aqui, confira o módulo na doc oficial — os nomes
 * NÃO são intercambiáveis entre `order` e `logistics`.
 */
export const SHOPEE_ENDPOINTS = {
  /** Módulo `order` — pedido e documentos fiscais do pedido. */
  order: {
    /**
     * Envia/atualiza a NF-e do pedido (passo fiscal de BR/PH).
     * Verificado contra produção em 04/08/2026 (pedido 2607290P63B8P8):
     * `/api/v2/logistics/upload_invoice_doc` → HTTP 404 `error_not_found`;
     * este path → HTTP 200 com `request_id` (chega à lógica de negócio).
     */
    uploadInvoiceDoc: "/api/v2/order/upload_invoice_doc",
  },

  /** Módulo `logistics` — envio, rastreio e documento de transporte. */
  logistics: {
    getShippingParameter: "/api/v2/logistics/get_shipping_parameter",
    getAddressList: "/api/v2/logistics/get_address_list",
    shipOrder: "/api/v2/logistics/ship_order",
    getTrackingNumber: "/api/v2/logistics/get_tracking_number",
    getShippingDocumentParameter:
      "/api/v2/logistics/get_shipping_document_parameter",
    createShippingDocument: "/api/v2/logistics/create_shipping_document",
    getShippingDocumentResult: "/api/v2/logistics/get_shipping_document_result",
    downloadShippingDocument: "/api/v2/logistics/download_shipping_document",
  },
} as const;

/**
 * `file_type` do upload_invoice_doc. A Shopee exige um INTEIRO aqui — o código
 * anterior mandava a string "normal_invoice" e recebia
 * "parameter type error, normal_invoice can not be parsed to integer".
 *
 * O valor 4 foi determinado empiricamente contra a API de produção em
 * 04/08/2026: varrendo 0..5 e 99, apenas o 4 passa da validação de arquivo e
 * alcança a regra de negócio (os demais param em `order.upload_invoice_error`
 * "File error."; 0 é tratado como ausente).
 *
 * NÃO CONFIRMADO na documentação oficial (open.shopee.com bloqueia acesso
 * automatizado): o significado nominal do 4, e se ele espera o XML autorizado
 * ou o PDF do DANFE — todos os pedidos disponíveis para teste já estavam com
 * `shipment arranged`, e essa regra de negócio responde antes de a validação de
 * conteúdo se manifestar. Mantemos o XML, que é o que o código sempre enviou.
 */
export const SHOPEE_INVOICE_FILE_TYPE_NFE = 4;

// Validar configuração
let shopeeConfigValidated = false;
export function validateShopeeConfig(): void {
  const requiredEnvVars = ["SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Variável de ambiente ${envVar} não configurada`);
    }
  }

  const key = process.env.SHOPEE_PARTNER_KEY || "";
  if (key.length !== 64) {
    throw new Error(
      `SHOPEE_PARTNER_KEY deve ter 64 caracteres (atual: ${key.length}). Copie novamente do console da Shopee.`,
    );
  }

  // debug info — log only once
  if (!shopeeConfigValidated) {
    console.log("[ShopeeConfig] partnerId", process.env.SHOPEE_PARTNER_ID);
    console.log("[ShopeeConfig] key length", key.length);
    shopeeConfigValidated = true;
  }
}

// Tipos da API de Marketplace da Magalu (portfolio/SKUs).
//
// ATENÇÃO: os shapes exatos da Open API da Magalu não puderam ser 100%
// confirmados sem acesso ao Sandbox/conta real (várias páginas de referência
// retornaram 404/auth-gated). As interfaces abaixo são DEFENSIVAS e marcadas
// onde precisam de validação contra a API real. Campos opcionais cobrem
// variações de nomenclatura prováveis.

/** SKU/oferta no portfólio do seller (GET /seller/v1/portfolios/skus[/{id}]). */
export interface MagaluSku {
  // Identificador interno do SKU no portfólio Magalu (usado em stock/price).
  id?: string;
  // Código do seller (nosso SKU) — base para auto-vínculo por SKU.
  sku?: string;
  seller_sku?: string;
  code?: string;
  title?: string;
  status?: string;
  available_quantity?: number;
  quantity?: number;
  price?: number;
  ean?: string | null;
  // URL pública do anúncio, quando a API fornecer.
  permalink?: string;
  url?: string;
  [key: string]: unknown;
}

export interface MagaluSkuListParams {
  limit?: number;
  offset?: number;
  // Cursor de paginação, se a API usar token em vez de offset (TBD).
  cursor?: string;
}

export interface MagaluSkuListResponse {
  results?: MagaluSku[];
  data?: MagaluSku[];
  meta?: {
    total?: number;
    limit?: number;
    offset?: number;
    next?: string | null;
  };
  [key: string]: unknown;
}

/** Corpo do update de estoque (TBD — confirmar endpoint/campo na API real). */
export interface MagaluStockUpdatePayload {
  sku: string;
  quantity: number;
}

/** Corpo do update de preço (TBD — confirmar endpoint/campo na API real). */
export interface MagaluPriceUpdatePayload {
  sku: string;
  price: number;
}

// Tipos da Graph Catalog Batch API (Meta Commerce Catalog).
//
// Fluxo: POST /{catalog_id}/items_batch { item_type, requests[] } → { handles };
// status opcional em GET /{catalog_id}/check_batch_request_status?handle=...
// O item é endereçado por `retailer_id` (= nosso SKU). Editar = método UPDATE
// com o mesmo retailer_id; despublicar (estoque 0) = UPDATE availability;
// remover de verdade = método DELETE.

export type FacebookBatchMethod = "CREATE" | "UPDATE" | "DELETE";

/** Disponibilidade do item no catálogo. */
export type FacebookAvailability =
  "in stock" | "out of stock" | "available for order" | "discontinued";

/** Condição do item (equivalente ao itemCondition do Dexo). */
export type FacebookCondition = "new" | "refurbished" | "used";

/**
 * `data` de um item do catálogo (Product Item). Campos do items_batch. `price`
 * é string no formato "<amount> <currency>" (ex.: "199 BRL"); imagens usam
 * image_url + additional_image_urls (1ª = principal).
 */
export interface FacebookCatalogItemData {
  // Identificador do item no catálogo do vendedor (= SKU). A Meta o exige
  // AQUI, dentro de `data` — ver o comentário de FacebookApiService.montarRequest.
  id?: string;
  name?: string;
  description?: string;
  availability?: FacebookAvailability;
  condition?: FacebookCondition;
  price?: string; // "199 BRL"
  currency?: string; // "BRL"
  link?: string; // URL da página do produto (EXIGIDO no CREATE)
  image_url?: string; // imagem principal
  additional_image_urls?: string[]; // imagens extras
  brand?: string;
  google_product_category?: string;
  quantity_to_sell_on_facebook?: number;
  [key: string]: unknown;
}

/**
 * Uma operação no `requests[]` do items_batch.
 *
 * ⚠️ NÃO existe `retailer_id` no nível do request. O identificador é
 * `data.id`, e `data` é OBRIGATÓRIO até no DELETE — sem ele a Meta responde
 * HTTP 200 com "Can not find required field id" no corpo, e a falha passa
 * despercebida. O campo foi removido daqui de propósito: assim o compilador
 * recusa a forma antiga em vez de deixá-la voltar em silêncio.
 */
export interface FacebookBatchRequest {
  method: FacebookBatchMethod;
  data: FacebookCatalogItemData & { id: string };
}

/** Corpo do POST /{catalog_id}/items_batch. */
export interface FacebookItemsBatchRequest {
  item_type: "PRODUCT_ITEM";
  requests: FacebookBatchRequest[];
  // allow_upsert: CREATE de retailer_id já existente vira update (evita erro).
  allow_upsert?: boolean;
}

/** Resposta do POST /{catalog_id}/items_batch. */
export interface FacebookItemsBatchResponse {
  handles?: string[];
  validation_status?: Array<{
    retailer_id?: string;
    errors?: unknown[];
    warnings?: unknown[];
  }>;
  [key: string]: unknown;
}

/** Entrada da consulta de status do batch (check_batch_request_status). */
export interface FacebookBatchStatusEntry {
  handle: string;
  status: "in_progress" | "finished" | "error" | string;
  errors?: unknown[];
  warnings?: unknown[];
  [key: string]: unknown;
}

/** Resposta do GET /{catalog_id}/check_batch_request_status?handle=... */
export interface FacebookBatchStatusResponse {
  data: FacebookBatchStatusEntry[];
}

/**
 * Item lido em GET /{catalog_id}/products (usado no vínculo por SKU do
 * "Importar anúncios"). `retailer_id` é a chave estável que o Dexo grava = SKU
 * (buildRetailerId); `id` é o id numérico do produto no catálogo Meta.
 */
export interface FacebookCatalogProduct {
  id?: string;
  retailer_id?: string;
  name?: string;
  availability?: string;
  url?: string;
  price?: string | number;
  image_url?: string;
  /**
   * Quantidade real no catálogo. Pode não vir na edge de LEITURA dependendo da
   * versão/permissão do app — por isso é opcional e o import só usa quando
   * presente, sem inventar default.
   */
  quantity_to_sell_on_facebook?: number | string;
  /** Galeria além da capa. Ausente quando o item foi criado só com image_url. */
  additional_image_urls?: string[];
}

/** Resposta paginada do GET /{catalog_id}/products (cursor `after`). */
export interface FacebookCatalogProductsResponse {
  data?: FacebookCatalogProduct[];
  paging?: { cursors?: { after?: string }; next?: string };
}

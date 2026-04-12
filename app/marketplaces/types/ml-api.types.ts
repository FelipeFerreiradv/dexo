/**
 * Tipos para a API de Items do Mercado Livre
 */

// Resposta da busca de items do vendedor
export interface MLItemsSearchResponse {
  seller_id: string;
  query: string | null;
  paging: {
    limit: number;
    offset: number;
    total: number;
  };
  results: string[]; // Array de IDs dos items (ex: ["MLB123", "MLB456"])
  scroll_id?: string; // usado quando search_type=scan
}

// Detalhes de um item do Mercado Livre
export interface MLItemDetails {
  id: string;
  title: string;
  seller_id: number;
  category_id: string;
  price: number;
  base_price: number;
  currency_id: string;
  initial_quantity: number;
  available_quantity: number;
  sold_quantity: number;
  status: "active" | "paused" | "closed" | "under_review" | "inactive";
  sub_status?: string[];
  permalink: string;
  thumbnail: string;
  pictures: MLItemPicture[];
  attributes: MLItemAttribute[];
  seller_custom_field: string | null; // SKU do vendedor
  date_created: string;
  last_updated: string;
}

export interface MLItemPicture {
  id: string;
  url: string;
  secure_url: string;
}

export interface MLItemAttribute {
  id: string;
  name: string;
  value_id: string | null;
  value_name: string | null;
}

// Resposta do multiget de items
export interface MLMultigetResponse {
  code: number;
  body: MLItemDetails;
}

// Payload para atualizar item
export interface MLItemUpdatePayload {
  title?: string;
  family_name?: string;
  price?: number;
  available_quantity?: number;
  status?: "active" | "paused" | "closed";
  pictures?: Array<{
    source: string;
  }>;
  category_id?: string;
  description?: string;
}

// Payload para criar item
export interface MLItemCreatePayload {
  // Em domínios "User Product" (ex.: autopeças com family_name) o ML
  // gera o título automaticamente; nesses casos enviar `title` causa
  // body.invalid_fields. Portanto mantemos como opcional.
  title?: string;
  category_id: string;
  price: number;
  currency_id: string;
  available_quantity: number;
  buying_mode: string;
  listing_type_id: string;
  condition: string;
  family_name?: string; // exigido por algumas categorias (autopeÃ§as)
  pictures: Array<{
    source?: string;
    id?: string;
  }>;
  seller_custom_field?: string;
  attributes?: Array<{
    id: string;
    value_id?: string;
    value_name?: string;
  }>;
  description?: {
    plain_text: string;
  };

  // Optional shipping/package dimensions (cms / kg) — forwarded to ML when set
  shipping?: {
    mode?: string;
    free_shipping?: boolean;
    local_pick_up?: boolean;
    // A API aceita string no formato "HxWxL,weight" ou objeto; usamos string.
    dimensions?:
      | string
      | {
          height?: number; // cm
          width?: number; // cm
          length?: number; // cm
          weight?: number; // kg
        };
  };

  // Termos de venda (garantia, etc.)
  sale_terms?: Array<{
    id: string;
    value_name?: string;
  }>;
}

// =========================================================================
// Compatibilidade nativa do Mercado Livre (autopeças)
// =========================================================================

/** Valor permitido de um atributo dentro de um domínio de catálogo. */
export interface MLCatalogAttributeValue {
  id: string;
  name: string;
}

/** Atributo retornado em GET /catalog_domains/{id}. */
export interface MLCatalogDomainAttribute {
  id: string;
  name: string;
  values?: MLCatalogAttributeValue[] | null;
}

export interface MLCatalogDomainResponse {
  domain_id: string;
  domain_name?: string;
  attributes?: MLCatalogDomainAttribute[];
}

/** Atributo de um catalog product devolvido pelos chunks. */
export interface MLCatalogProductAttribute {
  id: string;
  name?: string;
  value_id?: string | null;
  value_name?: string | null;
  values?: Array<{ id?: string | null; name?: string | null }>;
}

/** Um catalog product dentro de uma página de chunks. */
export interface MLCatalogCompatibilityProduct {
  id?: string;
  name?: string;
  status?: string;
  domain_id?: string;
  attributes?: MLCatalogProductAttribute[];
}

export interface MLCatalogCompatibilityChunkResponse {
  paging?: { total?: number; limit?: number; offset?: number };
  results?: MLCatalogCompatibilityProduct[];
}

/** Opções normalizadas que o backend devolve ao frontend. */
export interface MLCompatibilityBrandOption {
  valueId: string;
  name: string;
}

export interface MLCompatibilityModelOption {
  valueId: string;
  name: string;
  brandValueId: string;
  brandName: string;
}

export interface MLCompatibilityVehicleOption {
  /** Identificador estável: prioriza catalog product id; senão combina atributos. */
  key: string;
  brand: string;
  brandValueId: string;
  model: string;
  modelValueId: string;
  year: number | null;
  /** Versão canônica: TRIM OU `SHORT_VERSION + ENGINE` (sem duplicar motor). */
  version: string;
  /** Rótulo completo usado na UI: `${year} ${version}` ou apenas year/version. */
  label: string;
}

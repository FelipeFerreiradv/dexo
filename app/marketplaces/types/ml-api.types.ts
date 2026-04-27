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
  // Atributos da ficha técnica. ML aceita PUT em parte deles (ignora os
  // imutáveis em catálogo). Caller deve filtrar BRAND/MODEL/YEAR antes de enviar.
  attributes?: Array<{
    id: string;
    value_id?: string;
    value_name?: string;
  }>;
  // Campos editáveis adicionais aceitos pelo PUT /items/{id}
  listing_type_id?: string;
  condition?: string;
  warranty?: string;
  seller_custom_field?: string;
  shipping?: {
    mode?: string;
    free_shipping?: boolean;
    local_pick_up?: boolean;
    methods?: Array<{ id: number; cost?: number }>;
    tags?: string[];
  };
  sale_terms?: Array<{
    id: string;
    value_id?: string;
    value_name?: string;
  }>;
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

  // --- Catalog listing ---
  // Quando o vendedor deseja publicar usando um catalog product do ML em vez
  // de montar atributos manuais, envia o id do catalog product + flag
  // `catalog_listing: true`. Ficha técnica é herdada automaticamente pelo ML.
  // Somente preço, estoque, condição, listing_type, shipping, sale_terms e
  // pictures são enviados pelo seller.
  catalog_product_id?: string;
  catalog_listing?: boolean;
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

// =========================================================================
// Catálogo público de produtos (GET /products/search, GET /products/{id})
// Tipos mínimos, permissivos (campos desconhecidos toleramos como unknown).
// =========================================================================

export interface MLProductPicture {
  id?: string | null;
  url?: string | null;
  secure_url?: string | null;
  max_width?: number | null;
  max_height?: number | null;
}

export interface MLProductAttribute {
  id: string;
  name?: string | null;
  value_id?: string | null;
  value_name?: string | null;
  values?: Array<{ id?: string | null; name?: string | null }> | null;
}

export interface MLProductSearchHit {
  id: string;
  name?: string | null;
  status?: string | null;
  domain_id?: string | null;
  category_id?: string | null;
  site_id?: string | null;
  permalink?: string | null;
  pictures?: MLProductPicture[] | null;
  attributes?: MLProductAttribute[] | null;
  main_features?: Array<{ text?: string | null; type?: string | null }> | null;
}

export interface MLProductSearchResponse {
  paging?: { total?: number; offset?: number; limit?: number };
  keywords?: string | null;
  used_attributes?: MLProductAttribute[] | null;
  results?: MLProductSearchHit[] | null;
}

export interface MLProductDetails {
  id: string;
  catalog_product_id?: string | null;
  status?: string | null;
  domain_id?: string | null;
  name?: string | null;
  family_name?: string | null;
  category_id?: string | null;
  site_id?: string | null;
  type?: string | null;
  permalink?: string | null;
  pictures?: MLProductPicture[] | null;
  attributes?: MLProductAttribute[] | null;
  main_features?: Array<{ text?: string | null; type?: string | null }> | null;
  settings?: Record<string, unknown> | null;
}

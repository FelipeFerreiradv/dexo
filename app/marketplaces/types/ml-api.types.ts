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
  status: "active" | "paused" | "closed" | "under_review";
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
  price?: number;
  available_quantity?: number;
  status?: "active" | "paused" | "closed";
}

/**
 * Tipos para a API do Shopee
 */

// Estrutura base de resposta da API Shopee
export interface ShopeeApiResponse<T = any> {
  error: string | null;
  message: string | null;
  warning: string | null;
  request_id: string;
  response?: T;
}

// Autenticação
export interface ShopeeAuthResponse {
  access_token: string;
  refresh_token: string;
  expire_in: number; // segundos
  shop_id: number;
  partner_id: number;
  merchant_id: number;
}

// Item/Product do Shopee
export interface ShopeeItem {
  item_id: number;
  category_id: number;
  item_name: string;
  description: string;
  item_sku: string;
  create_time: number;
  update_time: number;
  attribute_list: ShopeeItemAttribute[];
  price_info: ShopeeItemPriceInfo[];
  stock_info: ShopeeItemStockInfo[];
  image: ShopeeItemImage;
  weight: number;
  dimension: ShopeeItemDimension;
  logistic_info: ShopeeItemLogisticInfo[];
  status: ShopeeItemStatus;
  has_model: boolean;
  promotion_id: number;
  condition: ShopeeItemCondition;
  video_info: ShopeeItemVideoInfo[];
  brand: ShopeeItemBrand;
  item_rating?: {
    rating_star?: number;
    rating_count?: number[];
    rating_total?: number;
  };
  view_count?: number;
  liked_count?: number;

  item_dangerous: number;
}

export interface ShopeeItemAttribute {
  attribute_id: number;
  attribute_name: string;
  attribute_value_list: ShopeeItemAttributeValue[];
}

export interface ShopeeItemAttributeValue {
  value_id: number;
  value_name: string;
  value_unit: string;
}

export interface ShopeeItemPriceInfo {
  currency: string;
  original_price: number;
  current_price: number;
  inflated_price_of_original_price: number;
  inflated_price_of_current_price: number;
  sip_item_price: number;
  sip_item_price_source: number;
}

export interface ShopeeItemStockInfo {
  stock_type: number;
  stock_quantity: number;
  stock_location_id: string;
  stock_reserved: number;
}

export interface ShopeeItemImage {
  image_url_list: string[];
  image_id_list: string[];
}

export interface ShopeeItemDimension {
  package_length: number;
  package_width: number;
  package_height: number;
}

export interface ShopeeItemLogisticInfo {
  logistic_id: number;
  logistic_name: string;
  enabled: boolean;
  shipping_fee: number;
  size_id: number;
  is_free: boolean;
}

export type ShopeeItemStatus =
  | "NORMAL" // Ativo
  | "BANNED" // Banido
  | "DELETED" // Deletado
  | "UNLIST" // Deslistado
  | "REVIEWING" // Em revisão
  | "SELLER_DELETED"; // Deletado pelo vendedor

export type ShopeeItemCondition =
  | "NEW" // Novo
  | "USED"; // Usado

export interface ShopeeItemVideoInfo {
  video_url: string;
  thumbnail_url: string;
  duration: number;
}

export interface ShopeeItemBrand {
  brand_id: number;
  brand_name: string;
}

// Payload para criar item (Shopee API v2 /product/add_item)
export interface ShopeeItemCreatePayload {
  category_id: number;
  item_name: string;
  description: string;
  item_sku: string;
  original_price: number;
  seller_stock: Array<{ stock: number }>;
  weight: number;
  dimension: {
    package_length: number;
    package_width: number;
    package_height: number;
  };
  image: {
    image_id_list: string[];
  };
  attribute_list?: ShopeeItemAttribute[];
  logistic_info?: Array<{ logistic_id: number; enabled: boolean }>;
  condition?: ShopeeItemCondition;
  brand?: { brand_id: number; original_brand_name: string };
  item_status?: "NORMAL" | "UNLIST";
}

// Payload para atualizar item
export interface ShopeeItemUpdatePayload {
  item_id: number;
  category_id?: number;
  item_name?: string;
  description?: string;
  item_sku?: string;
  original_price?: number;
  seller_stock?: Array<{ stock: number }>;
  weight?: number;
  dimension?: {
    package_length: number;
    package_width: number;
    package_height: number;
  };
  image?: {
    image_id_list: string[];
  };
  attribute_list?: ShopeeItemAttribute[];
  logistic_info?: Array<{ logistic_id: number; enabled: boolean }>;
  condition?: ShopeeItemCondition;
  brand?: { brand_id: number; original_brand_name: string };
}

// Resposta da busca de itens
export interface ShopeeItemListResponse {
  item: ShopeeItem[];
  total_count: number;
  has_next_page: boolean;
  next_offset: number;
}

// Parâmetros para buscar itens
export interface ShopeeItemListParams {
  offset: number;
  page_size: number;
  item_status?: ShopeeItemStatus[];
  update_time_from?: number;
  update_time_to?: number;
}

// Resposta de upload de imagem
export interface ShopeeImageUploadResponse {
  image_info: {
    image_id: string;
    image_url: string;
  };
}

// Categorias do Shopee
export interface ShopeeCategory {
  category_id: number;
  parent_category_id: number;
  category_name: string;
  has_children: boolean;
  children?: ShopeeCategory[];
}

// Resposta das categorias
export interface ShopeeCategoryResponse {
  category_list: ShopeeCategory[];
}

// Atributos de categoria
export interface ShopeeCategoryAttribute {
  attribute_id: number;
  attribute_name: string;
  is_mandatory: boolean;
  input_type: string;
  attribute_unit: string[];
  attribute_value_list: ShopeeCategoryAttributeValue[];
}

export interface ShopeeCategoryAttributeValue {
  value_id: number;
  value_name: string;
  parent_attribute_id: number;
  parent_value_id: number;
}

// Resposta dos atributos de categoria
export interface ShopeeCategoryAttributeResponse {
  attribute_list: ShopeeCategoryAttribute[];
}

// Pedidos
export interface ShopeeOrderListResponse {
  more: boolean;
  next_cursor?: string;
  order_list: {
    order_sn: string;
    order_status: string;
    create_time: number;
    update_time: number;
  }[];
}

export interface ShopeeOrderItem {
  item_id: number;
  item_name: string;
  item_sku?: string;
  model_id?: number;
  model_name?: string;
  model_sku?: string;
  model_original_price?: number;
  model_quantity_purchased: number;
}

export interface ShopeeOrderDetail {
  order_sn: string;
  order_status: string;
  buyer_username?: string;
  buyer_email?: string;
  create_time: number;
  update_time: number;
  total_amount?: number;
  item_list: ShopeeOrderItem[];
}

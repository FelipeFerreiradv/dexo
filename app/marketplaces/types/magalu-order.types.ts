// Tipos de pedidos da Magalu.
//
// ATENÇÃO: o shape EXATO do JSON de GET /seller/v1/orders/{id} da Open API
// nativa da Magalu não pôde ser confirmado sem Sandbox (parte da pesquisa veio
// do IntegraCommerce, um integrador terceiro, NÃO da API nativa). As interfaces
// abaixo são DEFENSIVAS: cobrem nomes de campos prováveis e o mapeamento lê de
// forma resiliente. VALIDAR contra um pedido real antes de produção.

export interface MagaluOrderItem {
  sku?: string;
  seller_sku?: string;
  product_id?: string;
  product_sku?: string;
  quantity?: number;
  qty?: number;
  price?: number;
  unit_price?: number;
  [key: string]: unknown;
}

export interface MagaluOrder {
  // Identificador do pedido (externalOrderId). Tentamos id → code → order_id.
  id?: string;
  code?: string;
  order_id?: string;
  status?: string;
  total?: number;
  total_amount?: number;
  amount?: number;
  customer_name?: string;
  buyer?: { name?: string } | null;
  items?: MagaluOrderItem[];
  [key: string]: unknown;
}

export interface MagaluOrderListResponse {
  results?: MagaluOrder[];
  data?: MagaluOrder[];
  meta?: { total?: number; limit?: number; offset?: number };
  [key: string]: unknown;
}

/**
 * Payload do webhook nativo v1 da Magalu (tópicos orders_order/orders_delivery).
 * A conta é resolvida por `tenant_id`; o id do recurso vem em data.params.id.
 */
export interface MagaluOrderWebhookPayload {
  data?: {
    status?: string;
    params?: { id?: string };
    resource?: string;
  };
  tenant_id?: string;
  topic?: string;
}

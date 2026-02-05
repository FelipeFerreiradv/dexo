/**
 * Tipos para a API de Orders (Pedidos) do Mercado Livre
 * Documentação: https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas
 */

// Status possíveis de uma order no ML
export type MLOrderStatus =
  | "confirmed" // Status inicial, ainda sem pagamento
  | "payment_required" // Aguardando confirmação de pagamento
  | "payment_in_process" // Pagamento em processamento
  | "partially_paid" // Parcialmente pago
  | "paid" // Pago (principal status para processar)
  | "partially_refunded" // Reembolso parcial
  | "pending_cancel" // Cancelamento pendente
  | "cancelled" // Cancelado
  | "invalid"; // Order inválida (comprador malicioso)

// Item dentro de uma order
export interface MLOrderItem {
  item: {
    id: string; // Ex: "MLB12345678"
    title: string;
    category_id: string;
    variation_id: number | null;
    seller_custom_field: string | null; // SKU do vendedor
    seller_sku: string | null; // SKU alternativo
    variation_attributes: {
      id: string;
      name: string;
      value_id: string;
      value_name: string;
    }[];
    warranty: string | null;
    condition: "new" | "used";
  };
  quantity: number;
  requested_quantity?: {
    value: number;
    measure: string;
  };
  unit_price: number;
  full_unit_price: number;
  currency_id: string;
  sale_fee: number; // Comissão do ML
  listing_type_id: string;
  manufacturing_days: number | null;
}

// Pagamento de uma order
export interface MLOrderPayment {
  id: number;
  order_id: number;
  payer_id: number;
  collector: {
    id: number;
  };
  site_id: string;
  reason: string;
  payment_method_id: string;
  currency_id: string;
  installments: number;
  operation_type: string;
  payment_type: string;
  status: "approved" | "pending" | "rejected" | "refunded";
  status_detail: string | null;
  transaction_amount: number;
  transaction_amount_refunded: number;
  taxes_amount: number;
  shipping_cost: number;
  total_paid_amount: number;
  date_approved: string | null;
  date_created: string;
  date_last_modified: string;
  available_actions: string[];
}

// Comprador da order
export interface MLOrderBuyer {
  id: number;
  nickname?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

// Vendedor da order
export interface MLOrderSeller {
  id: number;
  nickname?: string;
}

// Contexto da order (canal de venda)
export interface MLOrderContext {
  channel: "marketplace" | "proximity" | "mp-channel";
  site: string; // Ex: "MLB"
  flows: string[];
}

// Detalhes de uma order do Mercado Livre
export interface MLOrderDetails {
  id: number;
  status: MLOrderStatus;
  status_detail: string | null;
  date_created: string;
  date_closed: string | null;
  last_updated: string;
  manufacturing_ending_date: string | null;
  comment: string | null;
  pack_id: number | null; // ID do carrinho (se fizer parte de um pack)
  pickup_id: number | null;
  fulfilled: boolean | null;
  total_amount: number;
  paid_amount: number;
  currency_id: string;
  order_items: MLOrderItem[];
  payments: MLOrderPayment[];
  shipping: {
    id: number | null;
  };
  buyer: MLOrderBuyer;
  seller: MLOrderSeller;
  feedback: {
    buyer: unknown | null;
    seller: unknown | null;
  };
  context: MLOrderContext;
  tags: string[]; // Ex: ["paid", "delivered", "not_delivered"]
  taxes: {
    amount: number | null;
    currency_id: string | null;
  };
  cancel_detail?: {
    group: string;
    code: string;
    description: string;
    requested_by: string;
    date: string;
  };
  coupon: {
    id: string | null;
    amount: number;
  };
  mediations: unknown[];
}

// Resposta da busca de orders
export interface MLOrdersSearchResponse {
  query: string | null;
  results: MLOrderDetails[];
  sort: {
    id: string;
    name: string;
  };
  available_sorts: {
    id: string;
    name: string;
  }[];
  filters: unknown[];
  paging: {
    total: number;
    offset: number;
    limit: number;
  };
  display: string;
}

// Parâmetros para buscar orders
export interface MLOrdersSearchParams {
  seller: string; // ID do vendedor (obrigatório)
  status?: MLOrderStatus;
  dateCreatedFrom?: string; // ISO date
  dateCreatedTo?: string; // ISO date
  sort?: "date_asc" | "date_desc";
  offset?: number;
  limit?: number;
  tags?: string; // Separados por vírgula
}

/**
 * Tipos para Webhooks do Mercado Livre
 * Documentação: https://developers.mercadolivre.com.br/pt_br/notificacoes
 */

// Tópicos disponíveis para webhooks
export type MLWebhookTopic =
  | "orders_v2" // Notificações de pedidos
  | "items" // Notificações de itens
  | "questions" // Notificações de perguntas
  | "messages" // Notificações de mensagens
  | "payments" // Notificações de pagamentos
  | "shipments" // Notificações de envios
  | "claims" // Notificações de reclamações
  | "invoices"; // Notificações de notas fiscais;

// Payload base de webhook
export interface MLWebhookPayload {
  resource: string; // Ex: "/orders/123456789" ou "/items/MLB12345678"
  user_id: number; // ID do usuário no ML que recebeu a notificação
  topic: MLWebhookTopic;
  application_id: number; // ID da aplicação que registrou o webhook
  attempts: number; // Número de tentativas de envio
  sent: string; // Data/hora de envio (ISO 8601)
  received: string; // Data/hora de recebimento (ISO 8601)
}

// Payload específico para webhooks de orders
export interface MLOrderWebhookPayload extends MLWebhookPayload {
  topic: "orders_v2";
  resource: `/orders/${number}`; // Ex: "/orders/123456789"
}

// Payload específico para webhooks de items
export interface MLItemWebhookPayload extends MLWebhookPayload {
  topic: "items";
  resource: `/items/${string}`; // Ex: "/items/MLB12345678"
}

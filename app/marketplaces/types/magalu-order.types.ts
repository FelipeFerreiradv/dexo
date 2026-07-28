// Tipos de pedidos da Magalu.
//
// VALIDADO em 28/07/2026 contra a API real (GET /seller/v1/orders de uma conta
// de produção). O shape confirmado é BEM diferente do que estas interfaces
// assumiam:
//
//   - o pedido NÃO tem `items`: os itens vivem em `deliveries[].items[]`;
//   - o SKU do vendedor está em `item.info.sku` (não em `item.sku`);
//   - valores são INTEIROS EM CENTAVOS, com o divisor no próprio objeto
//     (`{ value: 19999, normalizer: 100 }` = R$ 199,99);
//   - `status` é string simples ("approved", "cancelled").
//
// Consequência do shape antigo: `mapMagaluOrderItems` lia `order.items`, que
// nunca existe, então TODO pedido caía em `no_products` e nenhuma venda Magalu
// jamais virou Order — nem com o poll ligado.
//
// Os campos legados seguem declarados (opcionais) porque o mapeamento continua
// defensivo: se a Magalu mudar o shape de volta, ou variar por canal, o
// fallback ainda funciona.

/** Valor monetário da Magalu: inteiro + divisor. 19999/100 = R$ 199,99. */
export interface MagaluMoney {
  currency?: string;
  /** Divisor para converter `total`/`value` em reais. Default seguro: 100. */
  normalizer?: number;
  total?: number;
  value?: number;
  [key: string]: unknown;
}

/** Dados do produto dentro do item. `sku` aqui é o SKU do VENDEDOR. */
export interface MagaluOrderItemInfo {
  sku?: string;
  /** Id do produto na Magalu (UUID). */
  id?: string;
  name?: string;
  brand?: string;
  [key: string]: unknown;
}

export interface MagaluOrderItem {
  /** Shape CONFIRMADO. */
  info?: MagaluOrderItemInfo;
  quantity?: number;
  unit_price?: MagaluMoney | number;
  amounts?: MagaluMoney;
  sequencial?: number;

  /** Campos legados/defensivos (nunca observados na API real). */
  sku?: string;
  seller_sku?: string;
  product_id?: string;
  product_sku?: string;
  qty?: number;
  price?: number;
  [key: string]: unknown;
}

/** Uma entrega do pedido. É AQUI que os itens moram. */
export interface MagaluOrderDelivery {
  id?: string;
  code?: string;
  status?: unknown;
  amounts?: MagaluMoney;
  items?: MagaluOrderItem[];
  [key: string]: unknown;
}

export interface MagaluOrder {
  /**
   * `id` é UUID e `code` é o número do pedido. ATENÇÃO: o endpoint de detalhe
   * (`GET /seller/v1/orders/{...}`) aceita o **code**; com o UUID responde 404.
   */
  id?: string;
  code?: string;
  order_id?: string;
  status?: string;
  purchased_at?: string;
  approved_at?: string;
  updated_at?: string;
  /** Totais do pedido, em centavos (inclui frete). */
  amounts?: MagaluMoney;
  deliveries?: MagaluOrderDelivery[];
  customer?: { name?: string; [key: string]: unknown } | null;

  /** Campos legados/defensivos. */
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

/**
 * Converte um valor monetário da Magalu para reais. `{ value: 19999,
 * normalizer: 100 }` → 199.99. Aceita número cru (shape legado) e devolve 0
 * para entrada inválida — nunca NaN, que viraria `Decimal` inválido no Prisma.
 */
export function magaluMoneyToNumber(
  money: MagaluMoney | number | null | undefined,
): number {
  if (money == null) return 0;
  if (typeof money === "number") {
    return Number.isFinite(money) ? money : 0;
  }
  const raw = money.value ?? money.total;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const div =
    typeof money.normalizer === "number" && money.normalizer > 0
      ? money.normalizer
      : 100;
  return raw / div;
}

/**
 * Achata os itens de um pedido. A API real entrega em `deliveries[].items[]`;
 * o `order.items` de topo é aceito como fallback defensivo.
 */
export function extractMagaluOrderItems(
  order: MagaluOrder | null | undefined,
): MagaluOrderItem[] {
  if (!order) return [];
  const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
  const doDelivery = deliveries.flatMap((d) =>
    Array.isArray(d?.items) ? d.items : [],
  );
  if (doDelivery.length > 0) return doDelivery;
  return Array.isArray(order.items) ? order.items : [];
}

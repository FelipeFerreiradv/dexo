const COMMERCIAL_STOCK_LOG =
  /\b(?:venda|vendido|estorno|cancel[a-z0-9]*|pedido|marketplace|mercado livre|shopee|magalu|devolucao|baixa|ml)\b/i;

function normalizeReason(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Defense in depth for reviewed merge plans. Exact StockLog rows are signed by
 * the plan as well; this rejects known commercial semantics even when signed.
 */
export function isSaleLikeStockLogReason(value: unknown): boolean {
  return COMMERCIAL_STOCK_LOG.test(normalizeReason(value));
}

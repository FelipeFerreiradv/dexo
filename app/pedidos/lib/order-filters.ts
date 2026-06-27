/**
 * Estado e serialização dos filtros da área de Pedidos.
 *
 * Espelha o desenho de `app/produtos/lib/product-filters.ts` (sem editar
 * Produtos). Os nomes da UI são mapeados para os query params que a rota
 * `GET /orders` entende: `createdFrom/createdTo` → `dateFrom/dateTo`,
 * `priceMin/priceMax` → `amountMin/amountMax`, `marketplace` → `platform`
 * (vazio = todos). `status` e `search` vão diretos.
 */

export type OrderFilterStatus =
  | "PENDING"
  | "PAID"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

export type OrderFilterMarketplace = "MERCADO_LIVRE" | "SHOPEE";

export interface OrderFiltersState {
  search: string;
  status: OrderFilterStatus | "";
  marketplace: OrderFilterMarketplace | "";
  createdFrom: string;
  createdTo: string;
  priceMin: string;
  priceMax: string;
}

export const DEFAULT_ORDER_FILTERS: OrderFiltersState = {
  search: "",
  status: "",
  marketplace: "",
  createdFrom: "",
  createdTo: "",
  priceMin: "",
  priceMax: "",
};

/**
 * Remove campos vazios e exige busca com ≥ 2 chars (igual Produtos). Já devolve
 * as chaves com os NOMES de query da rota (dateFrom/dateTo/amountMin/amountMax/
 * platform), prontas para o fetch.
 */
export function normalizeOrderFilters(filters: OrderFiltersState) {
  const normalizedSearch = filters.search.trim();
  const normalizedEntries = Object.entries({
    search: normalizedSearch.length >= 2 ? normalizedSearch : "",
    status: filters.status,
    platform: filters.marketplace,
    dateFrom: filters.createdFrom.trim(),
    dateTo: filters.createdTo.trim(),
    amountMin: filters.priceMin.trim(),
    amountMax: filters.priceMax.trim(),
  }).filter(([, value]) => value !== "");

  return Object.fromEntries(normalizedEntries);
}

export function serializeOrderFilters(
  filters: OrderFiltersState,
  options?: { page?: number; limit?: number },
) {
  const params = new URLSearchParams({
    page: String(options?.page ?? 1),
    limit: String(options?.limit ?? 10),
  });

  const normalized = normalizeOrderFilters(filters);
  Object.entries(normalized).forEach(([key, value]) => {
    params.set(key, value as string);
  });

  return params;
}

export function hasActiveOrderFilters(filters: OrderFiltersState) {
  return Object.keys(normalizeOrderFilters(filters)).length > 0;
}

export function countActiveOrderFilters(filters: OrderFiltersState) {
  return Object.keys(normalizeOrderFilters(filters)).length;
}

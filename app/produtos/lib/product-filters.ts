export type ProductFilterPublicationStatus =
  | "ACTIVE"
  | "PAUSED"
  | "PENDING"
  | "ERROR"
  | "CLOSED"
  | "NO_LISTING";
export type ProductFilterStockStatus =
  | "IN_STOCK"
  | "OUT_OF_STOCK"
  | "LOW_STOCK";
export type ProductFilterQuality =
  | "SUCATA"
  | "SEMINOVO"
  | "NOVO"
  | "RECONDICIONADO";
export type ProductPublishedCategoryPlatform = "MERCADO_LIVRE" | "SHOPEE";
export type ProductFilterMarketplace = ProductPublishedCategoryPlatform | "BOTH";

export interface ProductPublishedCategoryOption {
  value: string;
  label: string;
  platform: ProductPublishedCategoryPlatform;
  categoryId: string;
}

export interface ProductFiltersState {
  search: string;
  createdFrom: string;
  createdTo: string;
  publicationStatus: ProductFilterPublicationStatus | "";
  stockStatus: ProductFilterStockStatus | "";
  priceMin: string;
  priceMax: string;
  listingCategory: string;
  brand: string;
  quality: ProductFilterQuality | "";
  locationId: string;
  marketplace: ProductFilterMarketplace | "";
}

export const DEFAULT_PRODUCT_FILTERS: ProductFiltersState = {
  search: "",
  createdFrom: "",
  createdTo: "",
  publicationStatus: "",
  stockStatus: "",
  priceMin: "",
  priceMax: "",
  listingCategory: "",
  brand: "",
  quality: "",
  locationId: "",
  marketplace: "",
};

export function normalizeProductFilters(filters: ProductFiltersState) {
  const normalizedSearch = filters.search.trim();
  const normalizedEntries = Object.entries({
    search: normalizedSearch.length >= 2 ? normalizedSearch : "",
    createdFrom: filters.createdFrom.trim(),
    createdTo: filters.createdTo.trim(),
    publicationStatus: filters.publicationStatus,
    stockStatus: filters.stockStatus,
    priceMin: filters.priceMin.trim(),
    priceMax: filters.priceMax.trim(),
    listingCategory: filters.listingCategory.trim(),
    brand: filters.brand.trim(),
    quality: filters.quality,
    locationId: filters.locationId.trim(),
    marketplace: filters.marketplace,
  }).filter(([, value]) => value !== "");

  return Object.fromEntries(normalizedEntries);
}

export function serializeProductFilters(
  filters: ProductFiltersState,
  options?: { page?: number; limit?: number },
) {
  const params = new URLSearchParams({
    page: String(options?.page ?? 1),
    limit: String(options?.limit ?? 10),
  });

  const normalized = normalizeProductFilters(filters);
  Object.entries(normalized).forEach(([key, value]) => {
    params.set(key, value);
  });

  return params;
}

export function hasActiveProductFilters(filters: ProductFiltersState) {
  return Object.keys(normalizeProductFilters(filters)).length > 0;
}

export function filterPublishedCategories(
  options: ProductPublishedCategoryOption[],
  marketplace?: ProductFilterMarketplace | "",
) {
  if (!marketplace || marketplace === "BOTH") {
    return options;
  }

  return options.filter((option) => option.platform === marketplace);
}

export function getCompatibleListingCategoryValue(
  listingCategory: string,
  options: ProductPublishedCategoryOption[],
  marketplace?: ProductFilterMarketplace | "",
) {
  if (!listingCategory) {
    return "";
  }

  const compatibleOptions = filterPublishedCategories(options, marketplace);
  return compatibleOptions.some((option) => option.value === listingCategory)
    ? listingCategory
    : "";
}

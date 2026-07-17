import { Platform } from "@prisma/client";

export type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";
export type ProductPublicationStatus =
  | "ACTIVE"
  | "PAUSED"
  | "PENDING"
  | "ERROR"
  | "CLOSED"
  | "NO_LISTING";
export type ProductStockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "LOW_STOCK";
export type ProductMarketplaceFilter = Platform | "BOTH";

export interface ProductListingSummary {
  platform: Platform;
  marketplaceAccountId: string;
  accountIds: string[];
  categoryId?: string;
  status?: string;
  externalListingId?: string;
  permalink?: string;
  shopId?: number;
  updatedAt?: Date;
}

export interface ProductListFilters {
  search?: string;
  page?: number;
  limit?: number;
  createdFrom?: Date;
  createdTo?: Date;
  publicationStatus?: ProductPublicationStatus;
  stockStatus?: ProductStockStatus;
  priceMin?: number;
  priceMax?: number;
  listingCategory?: string;
  brand?: string;
  quality?: Quality;
  locationId?: string;
  marketplace?: ProductMarketplaceFilter;
}

export interface ProductPublishedCategoryFilterOption {
  value: string;
  label: string;
  platform: Platform;
  categoryId: string;
}

export interface ProductFilterOptions {
  brands: string[];
  publishedCategories: ProductPublishedCategoryFilterOption[];
}

export interface Product {
  id: string;
  userId?: string;
  sku: string;
  name: string;
  description?: string;
  stock: number;
  price: number;
  createdAt: Date;
  updatedAt: Date;

  costPrice?: number;
  markup?: number;
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  category?: string;
  location?: string;
  locationId?: string;
  partNumber?: string;
  quality?: Quality;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
  mlCategory?: string;
  mlCategoryId?: string;
  mlCategorySource?: "auto" | "manual" | "imported";
  mlCategoryChosenAt?: Date;

  shopeeCategoryId?: string;
  shopeeCategorySource?: "auto" | "manual" | "imported";
  shopeeCategoryChosenAt?: Date;

  magaluCategoryId?: string;
  magaluCategorySource?: "auto" | "manual" | "imported";
  magaluCategoryChosenAt?: Date;

  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  imageUrl?: string;
  imageUrls?: string[];

  // Ficha técnica secundária por categoria (Mercado Livre).
  // Mapa { [attributeId]: { value_id?, value_name? } } — preenchido pela UI dinâmica
  // a partir de GET /categories/{id}/attributes do ML.
  attributes?: Record<string, { value_id?: string; value_name?: string }>;

  // Vínculo opcional ao catálogo do Mercado Livre (ex.: "MLB19765739").
  // Quando presente, indica que o produto foi originado de uma sugestão de catálogo.
  mlCatalogProductId?: string | null;
  mlCatalogSnapshot?: Record<string, unknown> | null;

  // Origem do produto: quando true, foi criado automaticamente a partir de um
  // anúncio detectado no marketplace (não criado direto na Dexo). Aditivo, default
  // false — todo produto pré-existente continua false e idêntico ao de hoje.
  createdFromMarketplace?: boolean;
  originPlatform?: Platform;

  scrapId?: string;
  productLocation?: {
    id: string;
    code: string;
    description?: string;
  };
  listings?: ProductListingSummary[];
  compatibilities?: Array<{
    brand: string;
    model: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }>;
}

export interface ProductCreate {
  userId: string;
  sku: string;
  name: string;
  description?: string;
  stock: number;
  price: number;

  costPrice?: number;
  markup?: number;
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  category?: string;
  location?: string;
  locationId?: string;
  partNumber?: string;
  quality?: Quality;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
  mlCategory?: string;
  mlCategoryId?: string;
  mlCategorySource?: "auto" | "manual" | "imported";
  mlCategoryChosenAt?: Date;

  shopeeCategoryId?: string;
  shopeeCategorySource?: "auto" | "manual" | "imported";
  shopeeCategoryChosenAt?: Date;

  magaluCategoryId?: string;
  magaluCategorySource?: "auto" | "manual" | "imported";
  magaluCategoryChosenAt?: Date;

  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  imageUrl: string;
  imageUrls?: string[];

  // Ficha técnica secundária por categoria (ML)
  attributes?: Record<string, { value_id?: string; value_name?: string }>;

  // Vínculo opcional ao catálogo do Mercado Livre
  mlCatalogProductId?: string | null;
  mlCatalogSnapshot?: Record<string, unknown> | null;

  // Origem = anúncio do marketplace detectado automaticamente. Aditivo, default
  // false; só o caminho de auto-detecção seta true. Ver ListingAutodetectUseCase.
  createdFromMarketplace?: boolean;
  originPlatform?: Platform;

  scrapId?: string;

  // Opt-in: quando true, o servidor reserva o próximo SKU sequencial de forma
  // atômica no momento de salvar (ignorando qualquer `sku` enviado pelo
  // cliente). Sem a flag, o comportamento é o de hoje (sku explícito).
  autoSku?: boolean;

  createListing?: boolean;
  createListingCategoryId?: string;

  listings?: Array<{
    platform: Platform;
    accountIds: string[];
    categoryId?: string;
    listingType?: string;
    hasWarranty?: boolean;
    warrantyUnit?: string;
    warrantyDuration?: number;
    itemCondition?: string;
    shippingMode?: string;
    freeShipping?: boolean;
    localPickup?: boolean;
    manufacturingTime?: number;
  }>;

  compatibilities?: Array<{
    brand: string;
    model: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }>;
}

export interface ProductUpdate {
  name?: string;
  description?: string;
  stock?: number;
  price?: number;

  // Vínculo do produto à sucata de origem (religa produto JÁ existente —
  // usado por ProductUseCase.linkScrap e pela importação de dados legados).
  // Aditivo: ausente (undefined) = não mexe (byte-compatível com todos os
  // chamadores atuais); null = desvincula. O repositório valida que a sucata
  // pertence ao mesmo tenant (mesma guarda do create).
  scrapId?: string | null;

  costPrice?: number;
  markup?: number;
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  category?: string;
  location?: string;
  locationId?: string;
  partNumber?: string;
  quality?: Quality;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
  mlCategory?: string;
  mlCategoryId?: string;
  mlCategorySource?: "auto" | "manual" | "imported";
  mlCategoryChosenAt?: Date;

  shopeeCategoryId?: string;
  shopeeCategorySource?: "auto" | "manual" | "imported";
  shopeeCategoryChosenAt?: Date;

  magaluCategoryId?: string;
  magaluCategorySource?: "auto" | "manual" | "imported";
  magaluCategoryChosenAt?: Date;

  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  imageUrl?: string;
  imageUrls?: string[];

  // Ficha técnica secundária por categoria (ML)
  attributes?: Record<string, { value_id?: string; value_name?: string }>;

  // Vínculo opcional ao catálogo do Mercado Livre
  mlCatalogProductId?: string | null;
  mlCatalogSnapshot?: Record<string, unknown> | null;

  compatibilities?: Array<{
    brand: string;
    model: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }>;
}

export interface ProductUpdateResult {
  product: Product;
  syncResults?: {
    totalListings: number;
    successful: number;
    failed: number;
    results: Array<{
      success: boolean;
      productId: string;
      externalListingId: string;
      previousStock?: number;
      newStock?: number;
      previousPrice?: number;
      newPrice?: number;
      error?: string;
    }>;
  };
}

export interface ProductRepository {
  create(data: ProductCreate): Promise<Product>;
  findBySku(sku: string, userId: string): Promise<Product | null>;
  /**
   * Só a existência (SELECT id) — evita puxar o Product inteiro (com colunas
   * JSONB) quando o chamador usa o retorno apenas como booleano. Ver findBySku.
   */
  existsBySku(sku: string, userId: string): Promise<boolean>;
  findById(id: string, userId?: string): Promise<Product | null>;
  findAll(
    filters?: ProductListFilters,
    userId?: string,
  ): Promise<{ products: Product[]; total: number }>;
  findPublishedCategories(
    userId: string,
  ): Promise<ProductPublishedCategoryFilterOption[]>;
  delete(id: string, userId?: string): Promise<void>;
  update(id: string, data: ProductUpdate, userId?: string): Promise<Product>;
  count(userId?: string): Promise<number>;
  getMaxSkuNumber(userId?: string): Promise<number>;
}

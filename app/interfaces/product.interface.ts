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

  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  imageUrl?: string;
  imageUrls?: string[];

  scrapId?: string;
  listings?: ProductListingSummary[];
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

  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  imageUrl: string;
  imageUrls?: string[];

  scrapId?: string;

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

  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  imageUrl?: string;
  imageUrls?: string[];

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

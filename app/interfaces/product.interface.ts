// Enum de qualidade da peça
export type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

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

  // Campos de autopeças (opcionais)
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
  mlCategory?: string; // external id enviado pelo front
  mlCategoryId?: string; // FK to MarketplaceCategory (Mercado Livre)
  mlCategorySource?: "auto" | "manual" | "imported";
  mlCategoryChosenAt?: Date;

  // Shopee (preparação futura)
  shopeeCategoryId?: string;
  shopeeCategorySource?: "auto" | "manual" | "imported";
  shopeeCategoryChosenAt?: Date;

  // Medidas / peso (nova funcionalidade) — unidades: cm / kg
  heightCm?: number; // altura em centímetros
  widthCm?: number; // largura em centímetros
  lengthCm?: number; // comprimento em centímetros
  weightKg?: number; // peso em quilogramas

  // Imagem do produto
  imageUrl?: string;
  imageUrls?: string[];

  // Sucata vinculada
  scrapId?: string;
}

import { Platform } from "@prisma/client";

export interface ProductCreate {
  userId: string; // Adicionado para buscar descrição padrão do usuário
  sku: string;
  name: string;
  description?: string;
  stock: number;
  price: number;

  // Campos de autopeças (opcionais)
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

  // Medidas / peso (nova funcionalidade) — unidades: cm / kg
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  // Imagem do produto (obrigatória)
  imageUrl: string;
  imageUrls?: string[];

  // Sucata vinculada (opcional)
  scrapId?: string;

  // Opção para criar anúncio no ML automaticamente
  createListing?: boolean;
  createListingCategoryId?: string;

  // Novo: criação de anúncios multi-contas/plataformas
  listings?: Array<{
    platform: Platform;
    accountIds: string[];
    categoryId?: string;
    // Configurações de anúncio ML (override por listagem)
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

  // Compatibilidades veiculares (criadas junto com o produto)
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

  // Campos de autopeças (opcionais)
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

  // Medidas / peso (nova funcionalidade) — unidades: cm / kg
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;

  // Imagem do produto
  imageUrl?: string;
  imageUrls?: string[];

  // Compatibilidades veiculares
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
  findBySku(sku: string, userId?: string): Promise<Product | null>;
  findById(id: string, userId?: string): Promise<Product | null>;
  findAll(
    options?: {
      search?: string;
      page?: number;
      limit?: number;
    },
    userId?: string,
  ): Promise<{ products: Product[]; total: number }>;
  delete(id: string, userId?: string): Promise<void>;
  update(id: string, data: ProductUpdate, userId?: string): Promise<Product>;
  count(userId?: string): Promise<number>;
  getMaxSkuNumber(userId?: string): Promise<number>;
}

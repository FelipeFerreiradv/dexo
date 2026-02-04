// Enum de qualidade da peça
export type Quality = "SUCATA" | "SEMINOVO" | "NOVO" | "RECONDICIONADO";

export interface Product {
  id: string;
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
  partNumber?: string;
  quality?: Quality;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
}

export interface ProductCreate {
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
  partNumber?: string;
  quality?: Quality;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
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
  partNumber?: string;
  quality?: Quality;
  isSecurityItem?: boolean;
  isTraceable?: boolean;
  sourceVehicle?: string;
}

export interface ProductRepository {
  create(data: ProductCreate): Promise<Product>;
  findBySku(sku: string): Promise<Product | null>;
  findById(id: string): Promise<Product | null>;
  findAll(options?: {
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ products: Product[]; total: number }>;
  delete(id: string): Promise<void>;
  update(id: string, data: ProductUpdate): Promise<Product>;
  count(): Promise<number>;
  getMaxSkuNumber(): Promise<number>;
}

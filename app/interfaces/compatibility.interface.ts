export interface ProductCompatibility {
  id: string;
  productId: string;
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductCompatibilityCreate {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

export interface ProductCompatibilityRepository {
  findByProductId(productId: string): Promise<ProductCompatibility[]>;
  create(
    productId: string,
    data: ProductCompatibilityCreate,
  ): Promise<ProductCompatibility>;
  createMany(
    productId: string,
    data: ProductCompatibilityCreate[],
  ): Promise<ProductCompatibility[]>;
  delete(id: string): Promise<void>;
  deleteByProductId(productId: string): Promise<void>;
  replaceAll(
    productId: string,
    data: ProductCompatibilityCreate[],
  ): Promise<ProductCompatibility[]>;
}

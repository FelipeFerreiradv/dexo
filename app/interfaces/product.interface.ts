export interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string;
  stock: number;
  price: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductCreate {
  sku: string;
  name: string;
  description?: string;
  stock: number;
  price: number;
}

export interface ProductRepository {
  create(data: ProductCreate): Promise<Product>;
  findBySku(sku: string): Promise<Product | null>;
  findAll(options?: {
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ products: Product[]; total: number }>;
  delete(id: string): Promise<void>;
}

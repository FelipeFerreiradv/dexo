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

// SEGURANÇA (multi-tenant): `userId` é obrigatório em todas as operações —
// elas são escopadas pelo dono do produto (product.userId). Antes nenhuma rota
// de compatibilidade verificava posse => IDOR de leitura e escrita por id.
export interface ProductCompatibilityRepository {
  findByProductId(
    productId: string,
    userId: string,
  ): Promise<ProductCompatibility[]>;
  create(
    productId: string,
    data: ProductCompatibilityCreate,
    userId: string,
  ): Promise<ProductCompatibility>;
  createMany(
    productId: string,
    data: ProductCompatibilityCreate[],
    userId: string,
  ): Promise<ProductCompatibility[]>;
  delete(id: string, userId: string): Promise<void>;
  deleteByProductId(productId: string, userId: string): Promise<void>;
  replaceAll(
    productId: string,
    data: ProductCompatibilityCreate[],
    userId: string,
  ): Promise<ProductCompatibility[]>;
}

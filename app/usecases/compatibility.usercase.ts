import {
  ProductCompatibility,
  ProductCompatibilityCreate,
  ProductCompatibilityRepository,
} from "../interfaces/compatibility.interface";

// Todas as operações exigem `userId` (dono do produto) — escopo multi-tenant.
export class CompatibilityUseCase {
  constructor(private repository: ProductCompatibilityRepository) {}

  async getByProductId(
    productId: string,
    userId: string,
  ): Promise<ProductCompatibility[]> {
    return this.repository.findByProductId(productId, userId);
  }

  async addOne(
    productId: string,
    data: ProductCompatibilityCreate,
    userId: string,
  ): Promise<ProductCompatibility> {
    return this.repository.create(productId, data, userId);
  }

  async addMany(
    productId: string,
    data: ProductCompatibilityCreate[],
    userId: string,
  ): Promise<ProductCompatibility[]> {
    return this.repository.createMany(productId, data, userId);
  }

  async remove(id: string, userId: string): Promise<void> {
    return this.repository.delete(id, userId);
  }

  async removeAll(productId: string, userId: string): Promise<void> {
    return this.repository.deleteByProductId(productId, userId);
  }

  async replaceAll(
    productId: string,
    data: ProductCompatibilityCreate[],
    userId: string,
  ): Promise<ProductCompatibility[]> {
    return this.repository.replaceAll(productId, data, userId);
  }
}

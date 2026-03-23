import {
  ProductCompatibility,
  ProductCompatibilityCreate,
  ProductCompatibilityRepository,
} from "../interfaces/compatibility.interface";

export class CompatibilityUseCase {
  constructor(private repository: ProductCompatibilityRepository) {}

  async getByProductId(productId: string): Promise<ProductCompatibility[]> {
    return this.repository.findByProductId(productId);
  }

  async addOne(
    productId: string,
    data: ProductCompatibilityCreate,
  ): Promise<ProductCompatibility> {
    return this.repository.create(productId, data);
  }

  async addMany(
    productId: string,
    data: ProductCompatibilityCreate[],
  ): Promise<ProductCompatibility[]> {
    return this.repository.createMany(productId, data);
  }

  async remove(id: string): Promise<void> {
    return this.repository.delete(id);
  }

  async removeAll(productId: string): Promise<void> {
    return this.repository.deleteByProductId(productId);
  }

  async replaceAll(
    productId: string,
    data: ProductCompatibilityCreate[],
  ): Promise<ProductCompatibility[]> {
    return this.repository.replaceAll(productId, data);
  }
}

import { string } from "zod";
import {
  Product,
  ProductCreate,
  ProductUpdate,
  ProductRepository,
} from "../interfaces/product.interface";
import { ProductRepositoryPrisma } from "../repositories/product.repository";

export class ProductUseCase {
  private productRepository: ProductRepository;
  constructor() {
    this.productRepository = new ProductRepositoryPrisma();
  }

  async create(productData: ProductCreate): Promise<Product> {
    const existsProduct = await this.productRepository.findBySku(
      productData.sku,
    );
    if (existsProduct) {
      throw new Error("Produto com esse sku já existe");
    }
    const data = await this.productRepository.create(productData);
    return data;
  }

  async listProducts(options?: {
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ products: Product[]; total: number; totalPages: number }> {
    const data = await this.productRepository.findAll(options);
    return {
      ...data,
      totalPages: Math.ceil(data.total / (options?.limit || 10)),
    };
  }

  async delete(id: string): Promise<void> {
    await this.productRepository.delete(id);
  }

  async update(id: string, data: ProductUpdate): Promise<Product> {
    const product = await this.productRepository.findById(id);
    if (!product) {
      throw new Error("Produto não encontrado");
    }

    const updated = await this.productRepository.update(id, data);
    return updated;
  }

  /**
   * Gera o próximo SKU disponível
   * Formato: PROD-001, PROD-002, etc.
   */
  async getNextSku(): Promise<string> {
    const maxNumber = await this.productRepository.getMaxSkuNumber();
    const nextNumber = maxNumber + 1;
    return `PROD-${nextNumber.toString().padStart(3, "0")}`;
  }
}

import {
  Product,
  ProductCreate,
  ProductRepository,
} from "../interfaces/product.interface";
import { ProductRepositoryPrisma } from "../repositories/product.repository";

export class ProductUseCase {
  private productRepository: ProductRepository;
  constructor() {
    this.productRepository = new ProductRepositoryPrisma();
  }

  async create({
    sku,
    name,
    description,
    stock,
    price,
  }: ProductCreate): Promise<Product> {
    const existsProduct = await this.productRepository.findBySku(sku);
    if (existsProduct) {
      throw new Error("Produto com esse sku já existe");
    }
    const data = await this.productRepository.create({
      sku,
      name,
      description,
      stock,
      price,
    });
    return data;
  }
}

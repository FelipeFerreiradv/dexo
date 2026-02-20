import { describe, it, expect, vi, afterEach } from "vitest";
import { ProductUseCase } from "../app/usecases/product.usercase";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";

describe("ProductUseCase — default description handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies user's defaultProductDescription when creating a product without description", async () => {
    const usecase = new ProductUseCase();

    // mock user repo to return a user with defaultProductDescription
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "user-1",
      defaultProductDescription: "Descricao padrao do usuario",
    } as any);

    // ensure SKU check returns null (no duplicate)
    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null as any,
    );

    // capture created product
    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => ({ id: "prod-x", ...data }) as any,
    );

    const result = await usecase.create({
      sku: "S1",
      name: "Produto Teste",
      price: 10,
      stock: 1,
      userId: "user-1",
    } as any);

    expect(result.description).toBe("Descricao padrao do usuario");
  });

  it("keeps provided description when creating a product", async () => {
    const usecase = new ProductUseCase();

    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "user-1",
      defaultProductDescription: "Descricao padrao",
    } as any);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null as any,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => ({ id: "prod-x", ...data }) as any,
    );

    const result = await usecase.create({
      sku: "S2",
      name: "Produto Teste",
      description: "Minha descricao",
      price: 10,
      stock: 1,
      userId: "user-1",
    } as any);

    expect(result.description).toBe("Minha descricao");
  });
});

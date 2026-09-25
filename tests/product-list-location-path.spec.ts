import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `locationPath` da listagem de Produtos (card, lista, detalhe). Em 7 clientes
// o código da localização já é o caminho inteiro e a tela mostrava
// "BARR. > BARR. > CORR.-B > BARR. > CORR.-B > PRT.-57 > …".

const { locationFindManyMock } = vi.hoisted(() => ({
  locationFindManyMock: vi.fn(),
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    location: { findMany: locationFindManyMock },
    product: { findMany: vi.fn(), count: vi.fn() },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    location: { findMany: locationFindManyMock },
    product: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  maskCorruptVehicleCategoriesInProducts: vi.fn(async (p: unknown) => p),
  CategoryResolutionService: {},
}));

import { ProductUseCase } from "../app/usecases/product.usercase";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

const produto = (id: string, locationId: string | null, location: string | null) =>
  ({ id, sku: id, name: id, price: 1, stock: 1, locationId, location }) as any;

describe("listProducts — caminho da localização", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locationFindManyMock.mockResolvedValue([
      { id: "barr", code: "BARR.", parentId: null },
      { id: "corr", code: "BARR. > CORR.-B", parentId: "barr" },
      { id: "prt", code: "BARR. > CORR.-B > PRT.-57", parentId: "corr" },
      { id: "cx", code: "BARR. > CORR.-B > PRT.-57 > CXA 13 - CHAVE SETA", parentId: "prt" },
      { id: "g", code: "Galpão 1", parentId: null },
      { id: "a", code: "Andar 1", parentId: "g" },
      { id: "c212", code: "Caixa 212", parentId: "a" },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("não repete trechos quando o código já é o caminho; mantém o resto igual", async () => {
    vi.spyOn(ProductRepositoryPrisma.prototype, "findAll").mockResolvedValue({
      products: [
        produto("p1", "cx", "BARR. > CORR.-B > PRT.-57 > CXA 13 - CHAVE SETA"),
        produto("p2", "c212", "Caixa 212"),
        produto("p3", null, "Prateleira solta"),
      ],
      total: 3,
    } as any);

    const { products } = await new ProductUseCase().listProducts({
      userId: "owner-1",
      page: 1,
      limit: 10,
    } as any);

    expect((products[0] as any).locationPath).toBe(
      "BARR. > CORR.-B > PRT.-57 > CXA 13 - CHAVE SETA",
    );
    expect((products[1] as any).locationPath).toBe("Galpão 1 > Andar 1 > Caixa 212");
    // Sem vínculo: nada de locationPath; o texto livre segue intocado.
    expect((products[2] as any).locationPath).toBeUndefined();
    expect(products.map((p: any) => p.location)).toEqual([
      "BARR. > CORR.-B > PRT.-57 > CXA 13 - CHAVE SETA",
      "Caixa 212",
      "Prateleira solta",
    ]);
    expect(locationFindManyMock).toHaveBeenCalledWith({
      where: { userId: "owner-1" },
      select: { id: true, code: true, parentId: true },
    });
  });

  it("página sem localização vinculada não consulta Location", async () => {
    vi.spyOn(ProductRepositoryPrisma.prototype, "findAll").mockResolvedValue({
      products: [produto("p3", null, "Prateleira solta")],
      total: 1,
    } as any);
    await new ProductUseCase().listProducts({ userId: "owner-1", page: 1, limit: 10 } as any);
    expect(locationFindManyMock).not.toHaveBeenCalled();
  });
});

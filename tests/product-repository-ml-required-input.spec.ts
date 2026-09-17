import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * findMlRequiredAttrsInput — o que o endpoint de checagem de obrigatórios do
 * ML lê do banco. O filtro de DONO mora aqui (`where.userId`): sem ele o
 * endpoint avaliaria produto de outro tenant e devolveria categoria e nomes de
 * atributos em vez de product_not_found. O teste da rota espiona este método,
 * então a query só é provada aqui.
 */

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findMany: mockFindMany },
  },
}));

const repo = new ProductRepositoryPrisma();

describe("ProductRepositoryPrisma.findMlRequiredAttrsInput", () => {
  beforeEach(() => {
    mockFindMany.mockReset();
  });

  it("filtra por ids E dono, numa query só, com o select enxuto (sem imagens nem compatibilidades)", async () => {
    mockFindMany.mockResolvedValue([]);
    await repo.findMlRequiredAttrsInput(["p1", "p2"], "dono-1");
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const arg = mockFindMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: { in: ["p1", "p2"] }, userId: "dono-1" });
    expect(arg.select).toEqual({
      id: true,
      name: true,
      sku: true,
      brand: true,
      model: true,
      year: true,
      partNumber: true,
      quality: true,
      attributes: true,
      mlCategoryId: true,
      mlCatalogProductId: true,
    });
    expect(arg).not.toHaveProperty("include");
  });

  it("lista vazia → [] sem tocar no banco", async () => {
    expect(await repo.findMlRequiredAttrsInput([], "dono-1")).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("nulos viram undefined (como o mapPrismaToProduct que o create lê)", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "p1",
        name: "Farol",
        sku: "S1",
        brand: null,
        model: null,
        year: null,
        partNumber: null,
        quality: null,
        attributes: null,
        mlCategoryId: null,
        mlCatalogProductId: null,
      },
      {
        id: "p2",
        name: "Sensor",
        sku: "S2",
        brand: "VW",
        model: "Gol",
        year: "2014",
        partNumber: "PN-1",
        quality: "ORIGINAL",
        attributes: { SIDE: { value_id: "1" } },
        mlCategoryId: "MLB1",
        mlCatalogProductId: "MLB-CAT",
      },
    ]);
    const out = await repo.findMlRequiredAttrsInput(["p1", "p2"], "dono-1");
    expect(out[0]).toEqual({
      id: "p1",
      name: "Farol",
      sku: "S1",
      brand: undefined,
      model: undefined,
      year: undefined,
      partNumber: undefined,
      quality: undefined,
      attributes: undefined,
      mlCategoryId: undefined,
      mlCatalogProductId: undefined,
    });
    expect(out[1]).toEqual({
      id: "p2",
      name: "Sensor",
      sku: "S2",
      brand: "VW",
      model: "Gol",
      year: "2014",
      partNumber: "PN-1",
      quality: "ORIGINAL",
      attributes: { SIDE: { value_id: "1" } },
      mlCategoryId: "MLB1",
      mlCatalogProductId: "MLB-CAT",
    });
  });
});

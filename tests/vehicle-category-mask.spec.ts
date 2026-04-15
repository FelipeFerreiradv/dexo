import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  __esModule: true,
  default: {
    listWithParents: vi.fn(),
    findByExternalId: vi.fn(),
    findById: vi.fn(),
  },
  CategoryRepository: {
    listWithParents: vi.fn(),
    findByExternalId: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { getCategory: vi.fn() },
}));

import {
  maskCorruptVehicleCategoriesInProducts,
  __resetCategoryGuardCacheForTests,
} from "../app/marketplaces/services/category-resolution.service";
import CategoryRepository from "../app/marketplaces/repositories/category.repository";

const TREE = [
  { externalId: "MLB5672", fullPath: "Acessórios para Veículos", parentExternalId: null },
  { externalId: "MLB22648", fullPath: "Acessórios para Veículos > Peças de Carros > Suspensão", parentExternalId: "MLB5672" },
  { externalId: "MLB191703", fullPath: "Acessórios para Veículos > Peças de Carros > Mangueiras", parentExternalId: "MLB5672" },
  { externalId: "MLB1403", fullPath: "Alimentos e Bebidas", parentExternalId: null },
  { externalId: "MLB269510", fullPath: "Alimentos e Bebidas > Bebidas > Gin", parentExternalId: "MLB1403" },
];

describe("maskCorruptVehicleCategoriesInProducts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCategoryGuardCacheForTests();
    (CategoryRepository.listWithParents as any).mockResolvedValue(TREE);
  });

  it("nulls out mlCategory for vehicular product with off-domain (Gin) category", async () => {
    const products = [
      {
        id: "p1",
        brand: "ford",
        model: "ka",
        year: "2017",
        mlCategory: "MLB269510",
        mlCategoryId: "MLB269510",
        mlCategorySource: "auto",
      },
    ];
    await maskCorruptVehicleCategoriesInProducts(products as any);
    expect(products[0].mlCategory).toBeNull();
    expect(products[0].mlCategoryId).toBeNull();
    expect(products[0].mlCategorySource).toBeNull();
  });

  it("preserves vehicular product with valid vehicle-root category", async () => {
    const products = [
      {
        id: "p2",
        brand: "vw",
        model: "gol",
        year: "2015",
        mlCategory: "MLB22648",
        mlCategoryId: "MLB22648",
        mlCategorySource: "manual",
      },
    ];
    await maskCorruptVehicleCategoriesInProducts(products as any);
    expect(products[0].mlCategory).toBe("MLB22648");
    expect(products[0].mlCategoryId).toBe("MLB22648");
    expect(products[0].mlCategorySource).toBe("manual");
  });

  it("does not mask non-vehicular products (no brand/model/year)", async () => {
    const products = [
      {
        id: "p3",
        mlCategory: "MLB269510",
        mlCategoryId: "MLB269510",
        mlCategorySource: "manual",
      },
    ];
    await maskCorruptVehicleCategoriesInProducts(products as any);
    expect(products[0].mlCategory).toBe("MLB269510");
  });

  it("fail-open when category tree is empty (not yet synced)", async () => {
    (CategoryRepository.listWithParents as any).mockResolvedValue([]);
    const products = [
      {
        id: "p4",
        brand: "ford",
        model: "ka",
        year: "2017",
        mlCategory: "MLB269510",
      },
    ];
    await maskCorruptVehicleCategoriesInProducts(products as any);
    expect(products[0].mlCategory).toBe("MLB269510");
  });

  it("caches tree load across multiple invocations", async () => {
    const batch1 = [
      { brand: "ford", model: "ka", year: "2017", mlCategory: "MLB269510" },
    ];
    const batch2 = [
      { brand: "vw", model: "gol", year: "2015", mlCategory: "MLB22648" },
    ];
    await maskCorruptVehicleCategoriesInProducts(batch1 as any);
    await maskCorruptVehicleCategoriesInProducts(batch2 as any);
    expect((CategoryRepository.listWithParents as any).mock.calls.length).toBe(1);
  });

  it("skips DB load entirely when no product has vehicle signals", async () => {
    const products = [{ id: "p5", mlCategory: "MLB269510" }];
    await maskCorruptVehicleCategoriesInProducts(products as any);
    expect((CategoryRepository.listWithParents as any).mock.calls.length).toBe(0);
  });
});

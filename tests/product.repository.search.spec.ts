import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

// Shared mocks for prisma client methods used in repository
const mockQueryRaw = vi.fn();
const mockExecuteRawUnsafe = vi.fn();
const mockFindMany = vi.fn();
const mockCount = vi.fn();

vi.mock("../app/lib/prisma", () => ({
  default: {
    $queryRaw: mockQueryRaw,
    $executeRawUnsafe: mockExecuteRawUnsafe,
    product: {
      findMany: mockFindMany,
      count: mockCount,
      findFirst: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    orderItem: { count: vi.fn() },
    stockLog: { deleteMany: vi.fn() },
    productListing: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// Helper to mimic Prisma Decimal-like objects
const money = (value: number) => ({ toNumber: () => value });

const baseProduct = {
  userId: "user-1",
  description: null,
  costPrice: null,
  markup: null,
  brand: null,
  model: null,
  year: null,
  version: null,
  category: null,
  location: null,
  locationId: null,
  partNumber: null,
  quality: null,
  isSecurityItem: false,
  isTraceable: false,
  sourceVehicle: null,
  mlCategoryId: null,
  mlCategorySource: null,
  mlCategoryChosenAt: null,
  shopeeCategoryId: null,
  shopeeCategorySource: null,
  shopeeCategoryChosenAt: null,
  heightCm: null,
  widthCm: null,
  lengthCm: null,
  weightKg: money(0),
  scrapId: null,
  imageUrl: null,
  imageUrls: [],
  listings: [],
};

describe("ProductRepositoryPrisma.findAll - fuzzy search", () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockExecuteRawUnsafe.mockReset();
    mockFindMany.mockReset();
    mockCount.mockReset();
  });

  it("orders results by trigram score while returning hydrated products", async () => {
    const repo = new ProductRepositoryPrisma();

    mockQueryRaw
      .mockResolvedValueOnce([
        { id: "prod-a", score: 0.9 },
        { id: "prod-b", score: 0.4 },
      ])
      .mockResolvedValueOnce([{ count: BigInt(2) }]);

    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-b",
        sku: "CBO-002",
        name: "Cubo traseiro",
        price: money(120),
        stock: 5,
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-03"),
      },
      {
        ...baseProduct,
        id: "prod-a",
        sku: "CUBO-001",
        name: "Cubo de roda dianteiro",
        price: money(100),
        stock: 10,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      },
    ]);

    const result = await repo.findAll(
      { search: "CBO de roda", page: 1, limit: 10 },
      "user-1",
    );

    expect(mockExecuteRawUnsafe).toHaveBeenCalled(); // extensions/indexes ensured once
    expect(mockQueryRaw).toHaveBeenCalledTimes(2); // ranked ids + total
    expect(result.total).toBe(2);
    expect(result.products.map((p) => p.id)).toEqual(["prod-a", "prod-b"]); // keeps ranking order
    expect(result.products[0]).toMatchObject({ sku: "CUBO-001" });
  });

  it("falls back to simple list when search is empty", async () => {
    const repo = new ProductRepositoryPrisma();

    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-c",
        sku: "SKU-003",
        name: "PivÃ´ de suspensÃ£o",
        price: money(50),
        stock: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCount.mockResolvedValue(1);

    const result = await repo.findAll({ search: "", page: 1, limit: 10 }, "user-1");

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result.products).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("when search is purely numeric, performs exact SKU match (no fuzzy)", async () => {
    const repo = new ProductRepositoryPrisma();
    mockQueryRaw.mockResolvedValue([]); // should not be called
    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-sku",
        sku: "12345",
        name: "Filtro de óleo",
        price: money(20),
        stock: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCount.mockResolvedValue(1);

    const result = await repo.findAll({ search: "12345", page: 1, limit: 10 }, "user-1");

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result.products[0].sku).toBe("12345");
    expect(result.total).toBe(1);
  });
});

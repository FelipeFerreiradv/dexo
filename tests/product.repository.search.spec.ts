import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

// Shared mocks for prisma client methods used in repository
const {
  mockQueryRaw,
  mockExecuteRawUnsafe,
  mockFindMany,
  mockCount,
  mockProductListingFindMany,
  mockMarketplaceCategoryFindMany,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockExecuteRawUnsafe: vi.fn(),
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
  mockProductListingFindMany: vi.fn(),
  mockMarketplaceCategoryFindMany: vi.fn(),
}));

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
    productListing: {
      deleteMany: vi.fn(),
      findMany: mockProductListingFindMany,
    },
    marketplaceCategory: {
      findMany: mockMarketplaceCategoryFindMany,
    },
    $transaction: vi.fn(),
  },
}));

// Helper to mimic Prisma Decimal-like objects
const money = (value: number) => ({ toNumber: () => value });

function flattenAndClauses<T extends { AND?: T[] }>(clause: T): T[] {
  if (!clause.AND || clause.AND.length === 0) {
    return [clause];
  }

  return clause.AND.flatMap((item) => flattenAndClauses(item));
}

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
    mockProductListingFindMany.mockReset();
    mockMarketplaceCategoryFindMany.mockReset();
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

    const result = await repo.findAll(
      { search: "", page: 1, limit: 10 },
      "user-1",
    );

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result.products).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("returns listing link metadata in the hydrated products payload", async () => {
    const repo = new ProductRepositoryPrisma();
    const listingUpdatedAt = new Date("2026-04-08T12:34:56.000Z");

    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-links",
        sku: "SKU-LINK",
        name: "Produto com anuncio",
        price: money(150),
        stock: 7,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-02T00:00:00.000Z"),
        listings: [
          {
            marketplaceAccountId: "acc-ml",
            requestedCategoryId: "MLB123",
            externalListingId: "MLB999",
            permalink: "https://produto.mercadolivre.com.br/MLB999",
            status: "active",
            updatedAt: listingUpdatedAt,
            marketplaceAccount: {
              platform: "MERCADO_LIVRE",
              shopId: null,
            },
          },
          {
            marketplaceAccountId: "acc-shp",
            requestedCategoryId: "SHP_456",
            externalListingId: "44556677:889900",
            permalink: null,
            status: "normal",
            updatedAt: listingUpdatedAt,
            marketplaceAccount: {
              platform: "SHOPEE",
              shopId: 778899,
            },
          },
        ],
      },
    ]);
    mockCount.mockResolvedValue(1);

    const result = await repo.findAll(
      { search: "", page: 1, limit: 10 },
      "user-1",
    );

    expect(result.products[0].listings).toEqual([
      {
        platform: "MERCADO_LIVRE",
        marketplaceAccountId: "acc-ml",
        accountIds: ["acc-ml"],
        categoryId: "MLB123",
        externalListingId: "MLB999",
        permalink: "https://produto.mercadolivre.com.br/MLB999",
        shopId: undefined,
        status: "active",
        updatedAt: listingUpdatedAt,
      },
      {
        platform: "SHOPEE",
        marketplaceAccountId: "acc-shp",
        accountIds: ["acc-shp"],
        categoryId: "SHP_456",
        externalListingId: "44556677:889900",
        permalink: undefined,
        shopId: 778899,
        status: "normal",
        updatedAt: listingUpdatedAt,
      },
    ]);
  });

  it("applies scalar and relational filters to the base prisma query", async () => {
    const repo = new ProductRepositoryPrisma();
    const createdFrom = new Date("2026-01-01T00:00:00.000Z");
    const createdTo = new Date("2026-01-31T23:59:59.999Z");

    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    await repo.findAll(
      {
        search: "",
        page: 1,
        limit: 10,
        createdFrom,
        createdTo,
        publicationStatus: "ACTIVE",
        stockStatus: "LOW_STOCK",
        priceMin: 50,
        priceMax: 200,
        listingCategory: "MERCADO_LIVRE:MLB123",
        brand: "Fiat",
        quality: "SEMINOVO",
        locationId: "loc-1",
        marketplace: "MERCADO_LIVRE",
      },
      "user-1",
    );

    const where = mockFindMany.mock.calls[0][0].where;
    const clauses = flattenAndClauses(where);

    expect(clauses).toEqual(
      expect.arrayContaining([
        { userId: "user-1" },
        { createdAt: { gte: createdFrom, lte: createdTo } },
        { stock: { lte: 10 } },
        { price: { gte: 50, lte: 200 } },
        { quality: "SEMINOVO" },
        { locationId: "loc-1" },
        {
          listings: {
            some: {
              marketplaceAccount: {
                is: {
                  platform: "MERCADO_LIVRE",
                },
              },
            },
          },
        },
        {
          listings: {
            none: {
              marketplaceAccount: {
                is: {
                  platform: "SHOPEE",
                },
              },
            },
          },
        },
      ]),
    );

    const brandClause = clauses.find((clause: any) => clause.OR);
    expect(brandClause).toMatchObject({
      OR: expect.arrayContaining([
        { brand: { equals: "Fiat", mode: "insensitive" } },
        {
          compatibilities: {
            some: {
              brand: { equals: "Fiat", mode: "insensitive" },
            },
          },
        },
      ]),
    });

    const listingClause = clauses.find(
      (clause: any) => clause.listings?.some?.AND,
    );
    expect(listingClause).toMatchObject({
      listings: {
        some: {
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                {
                  requestedCategoryId: {
                    equals: "MLB123",
                    mode: "insensitive",
                  },
                },
              ]),
            },
            {
              marketplaceAccount: {
                is: {
                  platform: "MERCADO_LIVRE",
                },
              },
            },
          ]),
        },
      },
    });
  });

  it("keeps advanced filters when hydrating fuzzy-search results", async () => {
    const repo = new ProductRepositoryPrisma();

    mockQueryRaw
      .mockResolvedValueOnce([{ id: "prod-fuzzy", score: 0.88 }])
      .mockResolvedValueOnce([{ count: BigInt(1) }]);
    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-fuzzy",
        sku: "CUBO-777",
        name: "Cubo Shopee Fiat",
        brand: "Fiat",
        price: money(77),
        stock: 4,
        createdAt: new Date("2026-01-10"),
        updatedAt: new Date("2026-01-10"),
      },
    ]);

    const result = await repo.findAll(
      {
        search: "cubo",
        page: 1,
        limit: 10,
        publicationStatus: "ACTIVE",
        marketplace: "SHOPEE",
        brand: "Fiat",
      },
      "user-1",
    );

    expect(result.total).toBe(1);
    expect(result.products[0]).toMatchObject({
      id: "prod-fuzzy",
      sku: "CUBO-777",
    });
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);

    const hydrationWhere = mockFindMany.mock.calls[0][0].where;
    const hydrationClauses = flattenAndClauses(hydrationWhere);

    expect(hydrationClauses).toEqual(
      expect.arrayContaining([
        { userId: "user-1" },
        { id: { in: ["prod-fuzzy"] } },
      ]),
    );

    const brandClause = hydrationClauses.find((clause: any) => clause.OR);
    expect(brandClause).toMatchObject({
      OR: expect.arrayContaining([
        { brand: { equals: "Fiat", mode: "insensitive" } },
        {
          compatibilities: {
            some: {
              brand: { equals: "Fiat", mode: "insensitive" },
            },
          },
        },
      ]),
    });

    expect(hydrationClauses).toEqual(
      expect.arrayContaining([
        {
          listings: {
            some: {
              marketplaceAccount: {
                is: {
                  platform: "SHOPEE",
                },
              },
            },
          },
        },
        {
          listings: {
            none: {
              marketplaceAccount: {
                is: {
                  platform: "MERCADO_LIVRE",
                },
              },
            },
          },
        },
      ]),
    );

    const listingClause = hydrationClauses.find(
      (clause: any) => clause.listings?.some?.AND,
    );
    expect(listingClause).toMatchObject({
      listings: {
        some: {
          AND: expect.arrayContaining([
            {
              marketplaceAccount: {
                is: {
                  platform: "SHOPEE",
                },
              },
            },
          ]),
        },
      },
    });
  });

  it("filters by marketplace even when no publication status is provided", async () => {
    const repo = new ProductRepositoryPrisma();

    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    await repo.findAll(
      {
        search: "",
        page: 1,
        limit: 10,
        marketplace: "MERCADO_LIVRE",
      },
      "user-1",
    );

    const where = mockFindMany.mock.calls[0][0].where;
    const clauses = flattenAndClauses(where);

    expect(clauses).toEqual(
      expect.arrayContaining([
        {
          listings: {
            some: {
              marketplaceAccount: {
                is: {
                  platform: "MERCADO_LIVRE",
                },
              },
            },
          },
        },
        {
          listings: {
            none: {
              marketplaceAccount: {
                is: {
                  platform: "SHOPEE",
                },
              },
            },
          },
        },
      ]),
    );
  });

  it("filters by BOTH when the product must exist in both marketplaces", async () => {
    const repo = new ProductRepositoryPrisma();

    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);

    await repo.findAll(
      {
        search: "",
        page: 1,
        limit: 10,
        marketplace: "BOTH",
      },
      "user-1",
    );

    const where = mockFindMany.mock.calls[0][0].where;
    const clauses = flattenAndClauses(where);

    expect(clauses).toEqual(
      expect.arrayContaining([
        {
          listings: {
            some: {
              marketplaceAccount: {
                is: {
                  platform: "MERCADO_LIVRE",
                },
              },
            },
          },
        },
        {
          listings: {
            some: {
              marketplaceAccount: {
                is: {
                  platform: "SHOPEE",
                },
              },
            },
          },
        },
      ]),
    );
  });

  it("lists published categories with shopee normalization and grouped labels", async () => {
    const repo = new ProductRepositoryPrisma();

    mockProductListingFindMany.mockResolvedValue([
      {
        requestedCategoryId: "MLB114766",
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
      {
        requestedCategoryId: "12345",
        marketplaceAccount: { platform: "SHOPEE" },
      },
      {
        requestedCategoryId: "SHP_12345",
        marketplaceAccount: { platform: "SHOPEE" },
      },
    ]);
    mockMarketplaceCategoryFindMany.mockResolvedValue([
      {
        externalId: "MLB114766",
        fullPath: "Peças > Motor",
        name: "Motor",
      },
      {
        externalId: "SHP_12345",
        fullPath: "Auto > Cubos de roda",
        name: "Cubos de roda",
      },
    ]);

    const result = await repo.findPublishedCategories("user-1");

    expect(mockProductListingFindMany).toHaveBeenCalledWith({
      where: {
        requestedCategoryId: { not: null },
        product: { userId: "user-1" },
        marketplaceAccount: {
          is: {
            platform: {
              in: ["MERCADO_LIVRE", "SHOPEE"],
            },
          },
        },
      },
      select: {
        requestedCategoryId: true,
        marketplaceAccount: {
          select: {
            platform: true,
          },
        },
      },
    });

    expect(result).toEqual([
      {
        value: "MERCADO_LIVRE:MLB114766",
        label: "Mercado Livre • Peças > Motor",
        platform: "MERCADO_LIVRE",
        categoryId: "MLB114766",
      },
      {
        value: "SHOPEE:SHP_12345",
        label: "Shopee • Auto > Cubos de roda",
        platform: "SHOPEE",
        categoryId: "SHP_12345",
      },
    ]);
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

    const result = await repo.findAll(
      { search: "12345", page: 1, limit: 10 },
      "user-1",
    );

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result.products[0].sku).toBe("12345");
    expect(result.total).toBe(1);
  });
});

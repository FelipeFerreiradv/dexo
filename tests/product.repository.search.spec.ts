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

  it("uses the plain listing path (no fuzzy search) when search is empty", async () => {
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

    // Busca vazia segue o caminho de LISTAGEM (nao o fuzzy): $queryRaw devolve
    // os ids ja ordenados por (stock > 0) DESC, createdAt DESC + o total, e a
    // hidratacao vem do findMany. A ordenacao por estoque exige SQL bruto
    // (ver comentario em product.repository.findAll).
    mockQueryRaw
      .mockResolvedValueOnce([{ id: "prod-c" }])
      .mockResolvedValueOnce([{ count: BigInt(1) }]);

    const result = await repo.findAll(
      { search: "", page: 1, limit: 10 },
      "user-1",
    );

    // NAO deve acionar o caminho fuzzy (que garante extensoes pg_trgm/unaccent
    // via executeRawUnsafe). Usa 2 queries brutas: ids ordenados + total.
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ id: "prod-c", sku: "SKU-003" });
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
              in: ["MERCADO_LIVRE", "SHOPEE", "MAGALU"],
            },
          },
        },
      },
      distinct: ["marketplaceAccountId", "requestedCategoryId"],
      select: {
        marketplaceAccountId: true,
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

  it("guarda multi-termo: 2+ grupos sem match exato no Tier 1 retornam vazio sem rodar o fuzzy", async () => {
    const repo = new ProductRepositoryPrisma();

    // Tier 1 (runTokenSearch): ranked ids vazio + total 0 → multi-termo.
    mockQueryRaw
      .mockResolvedValueOnce([]) // ranked ids
      .mockResolvedValueOnce([{ count: BigInt(0) }]); // total

    const result = await repo.findAll(
      { search: "mola dianteira gol", page: 1, limit: 10 },
      "user-1",
    );

    // Só o Tier 1 rodou (2 queries). Se o fuzzy de frase inteira tivesse
    // rodado, seriam 4 chamadas — é o ruído dos "763" que a guarda corta.
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(mockFindMany).not.toHaveBeenCalled(); // sem hidratação (vazio)
    expect(result).toEqual({ products: [], total: 0 });
  });

  it("termo único sem match exato no Tier 1 ainda cai no fuzzy (tolerância a digitação preservada)", async () => {
    const repo = new ProductRepositoryPrisma();

    mockQueryRaw
      .mockResolvedValueOnce([]) // Tier 1 ranked ids vazio
      .mockResolvedValueOnce([{ count: BigInt(0) }]) // Tier 1 total 0
      .mockResolvedValueOnce([{ id: "prod-molla", score: 0.5 }]) // fuzzy ranked ids
      .mockResolvedValueOnce([{ count: BigInt(1) }]); // fuzzy total

    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-molla",
        sku: "MOLA-1",
        name: "Mola dianteira Gol",
        price: money(80),
        stock: 2,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      },
    ]);

    const result = await repo.findAll(
      { search: "molla", page: 1, limit: 10 },
      "user-1",
    );

    // Tier 1 (2 queries) + fuzzy (2 queries) = 4; o fuzzy foi alcançado.
    expect(mockQueryRaw).toHaveBeenCalledTimes(4);
    expect(result.total).toBe(1);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      id: "prod-molla",
      sku: "MOLA-1",
    });
  });

  it("busca numérica sem SKU exato cai para o Tier 1 (guarda não interfere)", async () => {
    const repo = new ProductRepositoryPrisma();

    // Tier 0 (SKU exato): nenhum match → cai para o Tier 1.
    mockFindMany
      .mockResolvedValueOnce([]) // findMany do match exato de SKU
      .mockResolvedValueOnce([
        {
          ...baseProduct,
          id: "prod-208",
          sku: "PECA-208",
          name: "Bico injetor",
          partNumber: "208",
          price: money(60),
          stock: 4,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-02"),
        },
      ]); // hidratação do Tier 1
    mockCount.mockResolvedValue(0); // count do SKU exato = 0

    // Tier 1 (1 grupo: "208") acha por partNumber.
    mockQueryRaw
      .mockResolvedValueOnce([{ id: "prod-208", score: 3 }]) // ranked ids
      .mockResolvedValueOnce([{ count: BigInt(1) }]); // total

    const result = await repo.findAll(
      { search: "208", page: 1, limit: 10 },
      "user-1",
    );

    expect(result.total).toBe(1);
    expect(result.products[0]).toMatchObject({ id: "prod-208" });
  });

  it("código alfanumérico com match exato de SKU retorna só ele (sem fuzzy)", async () => {
    const repo = new ProductRepositoryPrisma();
    mockQueryRaw.mockResolvedValue([]); // não deve ser chamado
    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-abc",
        sku: "ABC-1",
        name: "Farol dianteiro",
        price: money(50),
        stock: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCount.mockResolvedValue(1);

    const result = await repo.findAll(
      { search: "ABC-1", page: 1, limit: 10 },
      "user-1",
    );

    // Match exato (skuNormalized/sku) curto-circuita: nenhum SQL raw (Tier 1/fuzzy).
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.products[0].sku).toBe("ABC-1");
  });

  it("part number exato casa no Tier 0 com o MESMO tratamento do SKU (case-insensitive)", async () => {
    const repo = new ProductRepositoryPrisma();
    mockQueryRaw.mockResolvedValue([]); // não deve rodar (short-circuit no Tier 0)
    mockFindMany.mockResolvedValue([
      {
        ...baseProduct,
        id: "prod-pn",
        sku: "SKU-OUTRO",
        name: "Bomba d'água",
        partNumber: "PN-XY-9",
        price: money(90),
        stock: 6,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockCount.mockResolvedValue(1);

    // Busca em CAIXA ALTA: o normalizado (pn-xy-9) casa o partNumberNormalized.
    const result = await repo.findAll(
      { search: "PN-XY-9", page: 1, limit: 10 },
      "user-1",
    );

    // Match exato tem prioridade e curto-circuita — nenhum SQL raw (Tier 1/fuzzy).
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.products[0]).toMatchObject({
      id: "prod-pn",
      partNumber: "PN-XY-9",
    });

    // O tier exato passou a cobrir part number com a MESMA forma do SKU:
    // partNumber cru (case-sensitive) + partNumberNormalized (case-insensitive).
    const where = mockFindMany.mock.calls[0][0].where;
    const orClause = flattenAndClauses(where).find((c: any) => c.OR) as any;
    expect(orClause.OR).toEqual(
      expect.arrayContaining([
        { sku: "PN-XY-9" },
        { skuNormalized: "pn-xy-9" },
        { partNumber: "PN-XY-9" },
        { partNumberNormalized: "pn-xy-9" },
      ]),
    );
  });

  it("SKU/código numérico INEXISTENTE retorna vazio sem cair no fuzzy", async () => {
    const repo = new ProductRepositoryPrisma();
    // Tier 0 (exato): sem match.
    mockFindMany.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
    // Tier 1 (1 grupo "99999"): ranked vazio + total 0.
    mockQueryRaw
      .mockResolvedValueOnce([]) // Tier 1 ranked ids
      .mockResolvedValueOnce([{ count: BigInt(0) }]); // Tier 1 total

    const result = await repo.findAll(
      { search: "99999", page: 1, limit: 10 },
      "user-1",
    );

    // Só o Tier 1 rodou (2 queries). A guarda code-like cortou o fuzzy — se
    // ele tivesse rodado seriam 4 chamadas, trazendo SKUs aleatórios.
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ products: [], total: 0 });
  });
});

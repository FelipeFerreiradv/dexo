import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * Persistência e leitura do autor real (createdByUserId) no repositório:
 * - create grava o campo quando informado e NULL quando ausente (fluxos de
 *   sistema — imports/autodetect/scripts — não passam nada e ficam idênticos).
 * - findByIdDetailed expõe o autor no campo NOVO `createdBy` SEM alterar o
 *   `creator` existente (que segue = dono/tenant, contrato preservado), e o
 *   autor por anúncio em detailedListings[].createdBy.
 */

const { mockProductCreate, mockProductFindFirst, mockStockLogFindMany } =
  vi.hoisted(() => ({
    mockProductCreate: vi.fn(),
    mockProductFindFirst: vi.fn(),
    mockStockLogFindMany: vi.fn(),
  }));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { create: mockProductCreate, findFirst: mockProductFindFirst },
    scrap: { findFirst: vi.fn() },
    stockLog: { findMany: mockStockLogFindMany },
    $transaction: vi.fn(),
  },
}));

const repo = new ProductRepositoryPrisma();

const base = {
  userId: "owner-1",
  sku: "SKU-1",
  name: "Pastilha de freio",
  stock: 1,
  price: 10,
} as any;

// Linha "raw" mínima que o mapPrismaToProduct consegue mapear (price.toNumber()).
function makeRow(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    userId: "owner-1",
    sku: "SKU-1",
    name: "Pastilha de freio",
    stock: 1,
    price: { toNumber: () => 10 },
    createdAt: new Date(),
    updatedAt: new Date(),
    imageUrls: [],
    compatibilities: [],
    ...over,
  };
}

// Row completa p/ findByIdDetailed (include de user/createdBy/listings/etc).
function makeDetailedRow(over: Record<string, unknown> = {}) {
  return makeRow({
    listings: [],
    scrap: null,
    user: { id: "owner-1", name: "Admin Dono", email: "dono@ex.com" },
    createdBy: null,
    productLocation: null,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStockLogFindMany.mockResolvedValue([]);
});

describe("ProductRepository.create — createdByUserId", () => {
  it("grava o autor quando informado", async () => {
    mockProductCreate.mockResolvedValue(makeRow());

    await repo.create({ ...base, createdByUserId: "collab-1" });

    const arg = mockProductCreate.mock.calls[0][0];
    expect(arg.data.createdByUserId).toBe("collab-1");
    // Escopo por tenant intacto.
    expect(arg.data.userId).toBe("owner-1");
  });

  it("sem autor (fluxos de sistema): grava NULL — comportamento atual intacto", async () => {
    mockProductCreate.mockResolvedValue(makeRow());

    await repo.create({ ...base });

    const arg = mockProductCreate.mock.calls[0][0];
    expect(arg.data.createdByUserId).toBeNull();
  });
});

describe("ProductRepository.findByIdDetailed — createdBy aditivo", () => {
  it("expõe o autor em `createdBy` SEM alterar `creator` (dono/tenant)", async () => {
    mockProductFindFirst.mockResolvedValue(
      makeDetailedRow({
        createdBy: {
          id: "collab-1",
          name: "Colaborador Autor",
          email: "collab@ex.com",
        },
      }),
    );

    const result = await repo.findByIdDetailed("p-1", "owner-1");

    // Contrato existente preservado: creator segue vindo de `user` (tenant).
    expect(result?.creator).toEqual({
      id: "owner-1",
      name: "Admin Dono",
      email: "dono@ex.com",
    });
    // Campo NOVO com o autor real.
    expect(result?.createdBy).toEqual({
      id: "collab-1",
      name: "Colaborador Autor",
      email: "collab@ex.com",
    });
    // O include pede a relação nova (e mantém `user`).
    const arg = mockProductFindFirst.mock.calls[0][0];
    expect(arg.include.createdBy).toEqual({
      select: { id: true, name: true, email: true },
    });
    expect(arg.include.user).toEqual({
      select: { id: true, name: true, email: true },
    });
  });

  it("legado sem autor: createdBy = null (UI cai no fallback '—') e creator intacto", async () => {
    mockProductFindFirst.mockResolvedValue(makeDetailedRow());

    const result = await repo.findByIdDetailed("p-1", "owner-1");

    expect(result?.createdBy).toBeNull();
    expect(result?.creator).toEqual({
      id: "owner-1",
      name: "Admin Dono",
      email: "dono@ex.com",
    });
  });

  it("detailedListings: autor por anúncio quando presente, null p/ fluxo de sistema", async () => {
    const listingBase = {
      id: "l-1",
      marketplaceAccountId: "acc-1",
      externalListingId: "MLB123",
      status: "active",
      permalink: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      marketplaceAccount: {
        id: "acc-1",
        platform: "MERCADO_LIVRE",
        accountName: "Conta ML",
        shopId: null,
      },
    };
    mockProductFindFirst.mockResolvedValue(
      makeDetailedRow({
        listings: [
          {
            ...listingBase,
            createdBy: {
              id: "collab-1",
              name: "Colaborador Autor",
              email: "collab@ex.com",
            },
          },
          {
            ...listingBase,
            id: "l-2",
            externalListingId: "MLB456",
            createdBy: null, // autodetect/sync — sem ator
          },
        ],
      }),
    );

    const result = await repo.findByIdDetailed("p-1", "owner-1");

    expect(result?.detailedListings?.[0]?.createdBy).toEqual({
      id: "collab-1",
      name: "Colaborador Autor",
      email: "collab@ex.com",
    });
    expect(result?.detailedListings?.[1]?.createdBy).toBeNull();
  });
});

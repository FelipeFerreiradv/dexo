import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// Mocks devem vir ANTES de importar a rota (Vitest hoisting equivalente).
const removeListingMock = vi.fn().mockResolvedValue({
  success: true,
  closedOnMarketplace: true,
} as {
  success: boolean;
  closedOnMarketplace: boolean;
  error?: string;
  retryable?: boolean;
});

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: async () => ({ id: "MLB-T", permalink: "https://x" }),
    removeListing: (id: string) => removeListingMock(id),
  },
}));

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: "anything" }),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn(), deleteMany: vi.fn() },
    orderItem: { count: vi.fn().mockResolvedValue(0) },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (ops: any[]) => {
      if (Array.isArray(ops)) {
        return Promise.all(ops);
      }
      return ops;
    }),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: "anything" }),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn(), deleteMany: vi.fn() },
    orderItem: { count: vi.fn().mockResolvedValue(0) },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (ops: any[]) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      return ops;
    }),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
    logProductCreate: vi.fn(),
    logProductDelete: vi.fn(),
    logProductUpdate: vi.fn(),
    logListingDeleteFailed: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
      source: "explicit",
    }),
    ensureLeafLocalOnly: vi
      .fn()
      .mockResolvedValue({ externalId: "MLB-MOCK", fullPath: "Mock > Category" }),
  },
}));

vi.mock("../app/marketplaces/repositories/category.repository", () => {
  const cat = (id?: string) =>
    Promise.resolve({
      id: `cat-${id || "mock"}`,
      externalId: id || "MLB-MOCK",
      fullPath: "Mock > Category",
    });
  return {
    CategoryRepository: {
      findByExternalId: vi.fn(cat),
      findById: vi.fn(cat),
      listFlattenedOptions: vi.fn().mockResolvedValue([]),
    },
    default: {
      findByExternalId: vi.fn(cat),
      findById: vi.fn(cat),
      listFlattenedOptions: vi.fn().mockResolvedValue([]),
    },
  };
});

import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { BULK_DELETE_MAX_IDS } from "../app/usecases/product.usercase";

describe("POST /products/bulk-delete", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
    } as any);
    removeListingMock.mockClear();
    removeListingMock.mockResolvedValue({
      success: true,
      closedOnMarketplace: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("rejects empty body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects ids array with non-string entries with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: { ids: ["p-1", 42, ""] },
    });
    expect(res.statusCode).toBe(400);
  });

  it(`rejects more than ${BULK_DELETE_MAX_IDS} ids with 400`, async () => {
    const ids = Array.from({ length: BULK_DELETE_MAX_IDS + 1 }, (_, i) => `p-${i}`);
    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: { ids },
    });
    expect(res.statusCode).toBe(400);
  });

  it("dedupes repeated ids before processing", async () => {
    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockResolvedValue([]);
    const deleteSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "delete")
      .mockResolvedValue(undefined as any);

    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: { ids: ["p-1", "p-1", "p-2"] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.summary.total).toBe(2);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  it("returns 200 with deleted=true for all products on happy path", async () => {
    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockImplementation(({ where }) =>
      Promise.resolve([
        {
          id: `listing-of-${where.productId}`,
          externalListingId: `EXT-${where.productId}`,
          marketplaceAccountId: "acc-ml",
          marketplaceAccount: { id: "acc-ml", platform: "MERCADO_LIVRE" },
        },
      ]),
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "delete").mockResolvedValue(
      undefined as any,
    );

    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: { ids: ["p-1", "p-2", "p-3"] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.summary).toEqual({ total: 3, deleted: 3, failed: 0 });
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r: any) => r.deleted === true)).toBe(true);
    expect(removeListingMock).toHaveBeenCalledTimes(3);
  });

  it("marks failing product as deleted=false without touching ProductRepository.delete", async () => {
    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockImplementation(({ where }) =>
      Promise.resolve([
        {
          id: `listing-of-${where.productId}`,
          externalListingId: `EXT-${where.productId}`,
          marketplaceAccountId: "acc-shopee",
          marketplaceAccount: { id: "acc-shopee", platform: "SHOPEE" },
        },
      ]),
    );
    const deleteSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "delete")
      .mockResolvedValue(undefined as any);

    removeListingMock.mockClear();
    removeListingMock
      .mockResolvedValueOnce({ success: true, closedOnMarketplace: true })
      .mockResolvedValueOnce({
        success: false,
        closedOnMarketplace: false,
        retryable: false,
        error: "item still active",
      });

    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: { ids: ["p-ok", "p-fail"] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.summary).toEqual({ total: 2, deleted: 1, failed: 1 });

    const okEntry = body.results.find((r: any) => r.productId === "p-ok");
    const failEntry = body.results.find((r: any) => r.productId === "p-fail");
    expect(okEntry.deleted).toBe(true);
    expect(failEntry.deleted).toBe(false);
    expect(failEntry.listingResults[0].error).toBe("item still active");

    // ProductRepository.delete chamado exatamente UMA vez (só para p-ok)
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("p-ok", "user-1");
  });

  it("serializes removeListing calls per marketplaceAccountId (semaphore)", async () => {
    // Cria 4 listings em 2 contas — duas a/cada. Esperado: 2 pares
    // concurrent (por conta), nunca mais de 1 simultâneo na mesma conta.
    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockImplementation(({ where }) =>
      Promise.resolve(
        where.productId === "p-A"
          ? [
              {
                id: "l-A1",
                externalListingId: "EXT-A1",
                marketplaceAccountId: "acc-1",
                marketplaceAccount: { id: "acc-1", platform: "MERCADO_LIVRE" },
              },
              {
                id: "l-A2",
                externalListingId: "EXT-A2",
                marketplaceAccountId: "acc-2",
                marketplaceAccount: { id: "acc-2", platform: "SHOPEE" },
              },
            ]
          : [
              {
                id: "l-B1",
                externalListingId: "EXT-B1",
                marketplaceAccountId: "acc-1",
                marketplaceAccount: { id: "acc-1", platform: "MERCADO_LIVRE" },
              },
              {
                id: "l-B2",
                externalListingId: "EXT-B2",
                marketplaceAccountId: "acc-2",
                marketplaceAccount: { id: "acc-2", platform: "SHOPEE" },
              },
            ],
      ),
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "delete").mockResolvedValue(
      undefined as any,
    );

    // Instrumenta o mock pra registrar timestamps de start/end de cada chamada
    const callsByAccount = new Map<string, Array<{ start: number; end: number }>>();
    const listingToAccount: Record<string, string> = {
      "l-A1": "acc-1",
      "l-B1": "acc-1",
      "l-A2": "acc-2",
      "l-B2": "acc-2",
    };
    removeListingMock.mockClear();
    removeListingMock.mockImplementation(async (listingId: string) => {
      const account = listingToAccount[listingId];
      const start = Date.now();
      // Delay artificial para que sobreposição seja observável
      await new Promise((r) => setTimeout(r, 30));
      const end = Date.now();
      const arr = callsByAccount.get(account) ?? [];
      arr.push({ start, end });
      callsByAccount.set(account, arr);
      return { success: true, closedOnMarketplace: true };
    });

    const res = await app.inject({
      method: "POST",
      url: "/products/bulk-delete",
      headers: { email: "test@example.com", "content-type": "application/json" },
      payload: { ids: ["p-A", "p-B"] },
    });

    expect(res.statusCode).toBe(200);

    for (const [, calls] of callsByAccount) {
      // Ordena por início e verifica que cada chamada subsequente começou
      // depois do fim da anterior (= serialização) para a MESMA conta.
      const sorted = [...calls].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
      }
    }
  });
});

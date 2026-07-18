import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

/**
 * POST /products — cascata de preço escalonado lida de QUALQUER entrada do
 * listings[] (não só da entrada ML). O modal replica o controle nas seções
 * Shopee/Magalu (estado compartilhado) e anexa a config em todas as entradas;
 * a rota lê a 1ª habilitada. Clientes antigos (config só na entrada ML)
 * seguem byte-idênticos — coberto pelo teste de regressão abaixo e por
 * tests/product-routes-listing-price.spec.ts (intocado).
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: async () => ({ success: true, listingId: "l-1" }),
    removeListing: vi.fn(),
    updateListingFields: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
      source: "explicit",
    }),
    ensureLeafLocalOnly: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
    }),
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

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
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

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  dataOwnerId: "user-1",
} as any;

/** Payload mínimo do modal com listings[] customizado. */
const payloadWithListings = (listings: unknown[]) => ({
  sku: "PROD-STAGGER",
  name: "Farol Dianteiro Gol",
  price: 100.0,
  stock: 5,
  imageUrl: "http://localhost:3333/uploads/test.jpg",
  category: "Carroceria e Lataria",
  heightCm: 25,
  widthCm: 25,
  lengthCm: 45,
  weightKg: 10,
  listings,
});

const dispatchedTemplate = () =>
  (ListingDispatcher.dispatch as any).mock.calls[0]?.[0]?.overrideTemplate;

describe("POST /products — cascata lida de qualquer entrada do listings[]", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    (CategoryResolutionService.resolveMLCategory as any).mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
      source: "explicit",
    });
    (CategoryResolutionService.ensureLeafLocalOnly as any).mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
    });

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "existsBySku").mockResolvedValue(
      false,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) =>
        ({
          id: "prod-1",
          sku: data.sku,
          name: data.name,
          price: data.price ?? 0,
          stock: data.stock ?? 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as any,
    );
    vi.spyOn(ListingDispatcher, "dispatch").mockReturnValue({
      queued: [],
    } as any);
    vi.spyOn(ListingDispatcher, "resolveCrossAccountPercent").mockResolvedValue(
      10,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: payload as any,
    });

  it("só Shopee (2 contas) com config na entrada Shopee ⇒ escada Shopee, sem mapa ML", async () => {
    const res = await post(
      payloadWithListings([
        {
          platform: "SHOPEE",
          accountIds: ["s-1", "s-2"],
          categoryId: "100636",
          crossAccountIncrease: { enabled: true, percent: 10 },
        },
      ]),
    );

    expect(res.statusCode, res.payload).toBe(201);
    const tpl = dispatchedTemplate();
    expect(tpl?.crossAccountIncrease).toEqual({
      enabled: true,
      percent: 10,
      shopeeIndexByAccountId: { "s-1": 0, "s-2": 1 },
    });
  });

  it("só Magalu (2 contas) com config na entrada Magalu ⇒ escada Magalu", async () => {
    const res = await post(
      payloadWithListings([
        {
          platform: "MAGALU",
          accountIds: ["m-1", "m-2"],
          crossAccountIncrease: { enabled: true, percent: 10 },
        },
      ]),
    );

    expect(res.statusCode, res.payload).toBe(201);
    expect(dispatchedTemplate()?.crossAccountIncrease).toEqual({
      enabled: true,
      percent: 10,
      magaluIndexByAccountId: { "m-1": 0, "m-2": 1 },
    });
  });

  it("REGRESSÃO: config só na entrada ML (cliente antigo) ⇒ mapa ML idêntico ao de antes", async () => {
    const res = await post(
      payloadWithListings([
        {
          platform: "MERCADO_LIVRE",
          accountIds: ["acc-1", "acc-2"],
          categoryId: "MLB1744",
          crossAccountIncrease: { enabled: true, percent: 10 },
        },
      ]),
    );

    expect(res.statusCode, res.payload).toBe(201);
    expect(dispatchedTemplate()?.crossAccountIncrease).toEqual({
      enabled: true,
      percent: 10,
      indexByAccountId: { "acc-1": 0, "acc-2": 1 },
    });
  });

  it("sem config em nenhuma entrada ⇒ template null (dispatch idêntico ao atual)", async () => {
    const res = await post(
      payloadWithListings([
        { platform: "SHOPEE", accountIds: ["s-1", "s-2"], categoryId: "100636" },
        { platform: "MAGALU", accountIds: ["m-1"] },
      ]),
    );

    expect(res.statusCode, res.payload).toBe(201);
    expect(dispatchedTemplate()).toBeFalsy();
  });

  it("config habilitada mas só 1 conta por marketplace ⇒ template null (nada a escalonar)", async () => {
    const res = await post(
      payloadWithListings([
        {
          platform: "SHOPEE",
          accountIds: ["s-1"],
          categoryId: "100636",
          crossAccountIncrease: { enabled: true, percent: 10 },
        },
        {
          platform: "MAGALU",
          accountIds: ["m-1"],
          crossAccountIncrease: { enabled: true, percent: 10 },
        },
      ]),
    );

    expect(res.statusCode, res.payload).toBe(201);
    expect(dispatchedTemplate()).toBeFalsy();
  });
});

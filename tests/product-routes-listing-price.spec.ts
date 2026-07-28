import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

/**
 * "Valor do Anúncio" (mlListingPrice) no modal "Novo produto".
 *
 * O modal envia `listings[].listingPrice`, mas a rota só lia
 * `crossAccountIncrease` ao montar o overrideTemplate — o preço digitado era
 * descartado no servidor e o anúncio saía sempre com o preço do produto. O
 * fluxo em massa (Revisão individual) já fazia isso certo via
 * `perProductOverrides`; aqui o single passa a usar o mesmo caminho.
 *
 * Regra: preço do ML > 0 sobrescreve; vazio/zero herda o preço do produto
 * (nunca publica por R$ 0).
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

/** Payload mínimo do modal "Novo produto" com um anúncio ML. */
const payloadWith = (mlListing: Record<string, unknown>) => ({
  sku: "PROD-PRICE",
  name: "Farol Dianteiro Gol",
  price: 100.0,
  stock: 5,
  imageUrl: "http://localhost:3333/uploads/test.jpg",
  category: "Carroceria e Lataria",
  heightCm: 25,
  widthCm: 25,
  lengthCm: 45,
  weightKg: 10,
  listings: [
    {
      platform: "MERCADO_LIVRE",
      accountIds: ["acc-1"],
      categoryId: "MLB1744",
      ...mlListing,
    },
  ],
});

const dispatchedTemplate = () =>
  (ListingDispatcher.dispatch as any).mock.calls[0]?.[0]?.overrideTemplate;

describe("POST /products — Valor do Anúncio (ML) do fluxo individual", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    // Re-arma os mocks do módulo: o restoreAllMocks do afterEach limpa as
    // implementações definidas na factory do vi.mock.
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

  it("leva o preço do anúncio para perProductOverrides quando > 0", async () => {
    const res = await post(payloadWith({ listingPrice: 150.5 }));

    expect(res.statusCode, res.payload).toBe(201);
    expect(ListingDispatcher.dispatch).toHaveBeenCalled();
    expect(dispatchedTemplate()?.perProductOverrides?.["prod-1"]?.ml).toEqual(
      expect.objectContaining({ listingPrice: 150.5 }),
    );
  });

  it("não monta override quando o Valor do Anúncio vem vazio (herda o produto)", async () => {
    const res = await post(payloadWith({}));

    expect(res.statusCode, res.payload).toBe(201);
    // Sem preço e sem cascata, o template segue null — dispatch idêntico ao
    // comportamento anterior.
    expect(dispatchedTemplate()).toBeFalsy();
  });

  it("não monta override quando o Valor do Anúncio é zero (herda o produto)", async () => {
    const res = await post(payloadWith({ listingPrice: 0 }));

    expect(res.statusCode, res.payload).toBe(201);
    expect(dispatchedTemplate()).toBeFalsy();
  });

  it("preserva a cascata entre contas e compõe com o preço do anúncio", async () => {
    vi.spyOn(
      ListingDispatcher,
      "resolveCrossAccountPercent",
    ).mockResolvedValue(10);

    const res = await post(
      payloadWith({
        accountIds: ["acc-1", "acc-2"],
        listingPrice: 150.5,
        crossAccountIncrease: { enabled: true, percent: 10 },
      }),
    );

    expect(res.statusCode, res.payload).toBe(201);
    const tpl = dispatchedTemplate();
    // A cascata continua no template (não foi sobrescrita pelo spread)...
    expect(tpl?.crossAccountIncrease).toEqual(
      expect.objectContaining({ enabled: true, percent: 10 }),
    );
    // ...e o preço do anúncio viaja junto.
    expect(tpl?.perProductOverrides?.["prod-1"]?.ml?.listingPrice).toBe(150.5);
  });
});

// ──────────────────────────────────────────────────────────
// Bloco B — o mesmo campo passa a valer para Shopee e Magalu.
//
// A rota lia `listingPrice` APENAS da entrada MERCADO_LIVRE e gravava em `ml`
// hardcoded; o preço digitado nas outras seções era descartado no servidor.
// ──────────────────────────────────────────────────────────
describe("POST /products — Valor do Anúncio nas 3 plataformas", () => {
  let app: ReturnType<typeof fastify>;

  const payloadMultiplataforma = (
    precos: Partial<Record<"ml" | "shopee" | "magalu", number>>,
  ) => ({
    sku: "PROD-MULTI",
    name: "Farol Dianteiro Gol",
    price: 100.0,
    stock: 5,
    imageUrl: "http://localhost:3333/uploads/test.jpg",
    category: "Carroceria e Lataria",
    heightCm: 25,
    widthCm: 25,
    lengthCm: 45,
    weightKg: 10,
    listings: [
      {
        platform: "MERCADO_LIVRE",
        accountIds: ["acc-ml"],
        categoryId: "MLB1744",
        ...(precos.ml !== undefined ? { listingPrice: precos.ml } : {}),
      },
      {
        platform: "SHOPEE",
        accountIds: ["acc-shp"],
        categoryId: "SHP_102298",
        ...(precos.shopee !== undefined
          ? { listingPrice: precos.shopee }
          : {}),
      },
      {
        platform: "MAGALU",
        accountIds: ["acc-mgl"],
        ...(precos.magalu !== undefined
          ? { listingPrice: precos.magalu }
          : {}),
      },
    ],
  });

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
    // ProductUseCase.create busca o dono por id (sem preloadedOwner na rota).
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

  it("preço 150 nas 3 entradas vira override nas 3 chaves", async () => {
    const res = await post(
      payloadMultiplataforma({ ml: 150, shopee: 150, magalu: 150 }),
    );

    expect(res.statusCode, res.payload).toBe(201);
    const ov = dispatchedTemplate()?.perProductOverrides?.["prod-1"];
    expect(ov?.ml?.listingPrice).toBe(150);
    expect(ov?.shopee?.listingPrice).toBe(150);
    expect(ov?.magalu?.listingPrice).toBe(150);
  });

  it("preço só na Shopee não contamina ML nem Magalu", async () => {
    const res = await post(payloadMultiplataforma({ shopee: 199.9 }));

    expect(res.statusCode, res.payload).toBe(201);
    const ov = dispatchedTemplate()?.perProductOverrides?.["prod-1"];
    expect(ov?.shopee?.listingPrice).toBe(199.9);
    expect(ov?.ml).toBeUndefined();
    expect(ov?.magalu).toBeUndefined();
  });

  it("preços diferentes por plataforma são preservados", async () => {
    const res = await post(
      payloadMultiplataforma({ ml: 100, shopee: 120, magalu: 140 }),
    );

    expect(res.statusCode, res.payload).toBe(201);
    const ov = dispatchedTemplate()?.perProductOverrides?.["prod-1"];
    expect(ov?.ml?.listingPrice).toBe(100);
    expect(ov?.shopee?.listingPrice).toBe(120);
    expect(ov?.magalu?.listingPrice).toBe(140);
  });

  it("zero e negativo não viram override (herdam o produto)", async () => {
    const res = await post(
      payloadMultiplataforma({ ml: 0, shopee: 0, magalu: -10 }),
    );

    expect(res.statusCode, res.payload).toBe(201);
    // Sem nenhum preço válido e sem cascata, o template segue nulo.
    expect(dispatchedTemplate()).toBeFalsy();
  });

  it("nenhum preço informado mantém o dispatch idêntico ao de hoje", async () => {
    const res = await post(payloadMultiplataforma({}));

    expect(res.statusCode, res.payload).toBe(201);
    expect(dispatchedTemplate()).toBeFalsy();
  });
});

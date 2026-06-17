import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import FormData from "form-data";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ProductUseCase } from "../app/usecases/product.usercase";

// Prevent heavy marketplace/usecase imports from pulling prisma alias in this test
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
    createMLListing: async () => ({
      id: "MLB-TEST",
      permalink: "https://ml.test/MLB-TEST",
    }),
    removeListing: (id: string) => removeListingMock(id),
  },
}));

// Mock prisma alias module to avoid alias resolution problems in some imported files
vi.mock("@/app/lib/prisma", () => ({
  default: {
    // minimal prisma stubs used by repositories when mocked
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
  },
}));

// Always resolve ML category in tests (avoid hitting DB/ML)
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

// Mock CategoryRepository to satisfy imports if reached
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

// Mock direct relative prisma import used by repositories
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
    systemLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// Mock SystemLogService to avoid hitting prisma during tests
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

describe("POST /products (integration)", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    // register only the product routes (unit-tested in isolation)
    await app.register(productRoutes, { prefix: "/products" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("creates a product when payload is valid and user exists", async () => {
    // Mock authenticated user lookup (auth.middleware uses findByEmail)
    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
      defaultProductDescription: "Descrição padrão",
    } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );

    // Ensure SKU uniqueness check returns null (no existing product)
    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );

    // Spy on repository.create to return a Product-like object
    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => {
        return {
          id: "prod-1",
          sku: data.sku,
          name: data.name,
          description: data.description ?? undefined,
          stock: data.stock ?? 0,
          price: data.price ?? 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          costPrice: data.costPrice ?? undefined,
          markup: data.markup ?? undefined,
          brand: data.brand ?? undefined,
          model: data.model ?? undefined,
          year: data.year ?? undefined,
          version: data.version ?? undefined,
          category: data.category ?? undefined,
          location: data.location ?? undefined,
          partNumber: data.partNumber ?? undefined,
          quality: data.quality ?? undefined,
          isSecurityItem: data.isSecurityItem ?? undefined,
          isTraceable: data.isTraceable ?? undefined,
          sourceVehicle: data.sourceVehicle ?? undefined,
          heightCm: data.heightCm ?? undefined,
          widthCm: data.widthCm ?? undefined,
          lengthCm: data.lengthCm ?? undefined,
          weightKg: data.weightKg ?? undefined,
          imageUrl: data.imageUrl ?? undefined,
        } as any;
      },
    );

    const payload = {
      sku: "PROD-999",
      name: "Roda Fiat Uno 2017",
      description: "",
      price: 100.0,
      stock: 5,
      imageUrl: "http://localhost:3333/uploads/test.jpg",
      category: "Carroceria e Lataria",
      heightCm: 25,
      widthCm: 25,
      lengthCm: 45,
      weightKg: 10,
    };

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("id", "prod-1");
    expect(body).toHaveProperty("sku", payload.sku);
    expect(body).toHaveProperty("name", payload.name);
    expect(body).toHaveProperty("heightCm", 25);
    expect(body).toHaveProperty("category", payload.category);
  });

  it("autoSku=true: servidor atribui o SKU sequencial e o retorna (cliente não envia sku)", async () => {
    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    // Contador já populado → pula o seed sob demanda.
    vi.spyOn(
      UserRepositoryPrisma.prototype,
      "getLastSkuSequential",
    ).mockResolvedValue(300);
    // Reserva atômica: spy no prototype porque o $queryRaw cru NÃO está no
    // mock de prisma deste suite (se executasse, estouraria).
    vi.spyOn(
      UserRepositoryPrisma.prototype,
      "reserveNextSkuSequential",
    ).mockResolvedValue(301);
    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(
        async (data: any) =>
          ({
            id: "prod-auto",
            sku: data.sku,
            name: data.name,
            stock: data.stock,
            price: data.price,
            imageUrl: data.imageUrl,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as any,
      );

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        // Sem `sku` — o servidor atribui.
        autoSku: true,
        name: "Roda Auto",
        price: 100,
        stock: 1,
        imageUrl: "http://localhost/x.jpg",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("sku", "301");
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sku: "301" }),
    );
  });

  it("forwards compatibilities to repository exactly once on create", async () => {
    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );

    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(
        async (data: any) =>
          ({
            id: "prod-compat-1",
            sku: data.sku,
            name: data.name,
            stock: data.stock,
            price: data.price,
            imageUrl: data.imageUrl,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as any,
      );

    const payload = {
      sku: "PROD-COMPAT-1",
      name: "Amortecedor dianteiro",
      price: 250,
      stock: 3,
      imageUrl: "http://localhost/img.jpg",
      compatibilities: [
        {
          brand: "Fiat",
          model: "Stilo",
          yearFrom: 2008,
          yearTo: 2011,
          version: "Attractive 1.8 8V Flex",
        },
        {
          brand: "Fiat",
          model: "Stilo",
          yearFrom: 2008,
          yearTo: 2011,
          version: "Blackmotion 1.8 8V Flex",
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as any;
    expect(arg.compatibilities).toHaveLength(2);
    expect(arg.compatibilities[0]).toMatchObject({
      brand: "Fiat",
      model: "Stilo",
      yearFrom: 2008,
      yearTo: 2011,
      version: "Attractive 1.8 8V Flex",
    });
  });

  it("drops malformed compatibilities entries on create", async () => {
    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(
        async () =>
          ({
            id: "prod-compat-2",
            sku: "PROD-COMPAT-2",
            name: "X",
            stock: 1,
            price: 10,
            imageUrl: "http://x/y.jpg",
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as any,
      );

    await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "PROD-COMPAT-2",
        name: "X",
        price: 10,
        stock: 1,
        imageUrl: "http://x/y.jpg",
        compatibilities: [
          { brand: "", model: "Stilo" },
          { brand: "Fiat", model: "" },
          { brand: "Fiat", model: "Stilo" },
          null,
          { brand: "Honda", model: "Civic", yearFrom: "2018" },
        ],
      },
    });

    const arg = createSpy.mock.calls[0][0] as any;
    expect(arg.compatibilities).toHaveLength(2);
    expect(arg.compatibilities[0].model).toBe("Stilo");
    expect(arg.compatibilities[1]).toMatchObject({
      brand: "Honda",
      model: "Civic",
      yearFrom: 2018,
    });
  });

  it.skip("creates product and triggers listing creation when createListing is true", async () => {
    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
      defaultProductDescription: "Descrição padrão",
    } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => ({ id: "prod-2", ...data }) as any,
    );

    // Mock ListingUseCase.createMLListing to simulate successful ML creation
    const listingMock =
      await import("../app/marketplaces/usecases/listing.usercase");
    vi.spyOn(listingMock.ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      listingId: "pl-1",
      externalListingId: "MLB999",
      permalink: "https://ml.ai/item/MLB999",
    } as any);

    const payload = {
      sku: "PROD-1000",
      name: "Teste com anúncio",
      description: "Descr de teste",
      price: 50,
      stock: 1,
      imageUrl: "http://localhost:3333/uploads/test.jpg",
      createListing: true,
      createListingCategoryId: "MLB271107",
    };

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("id", "prod-2");
    expect(body).toHaveProperty("listing");
    expect(body.listing.success).toBe(true);
    expect(body.listing.externalListingId).toBe("MLB999");
  });

  it.skip("retries listing once when first attempt is skipped and account recheck becomes ACTIVE", async () => {
    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => ({ id: "prod-3", ...data }) as any,
    );

    const listingModule =
      await import("../app/marketplaces/usecases/listing.usercase");

    // First call -> skipped; Second call -> success
    const createSpy = vi
      .spyOn(listingModule.ListingUseCase, "createMLListing")
      .mockResolvedValueOnce({
        success: false,
        skipped: true,
        error: "Conta do Mercado Livre com restrição",
      } as any)
      .mockResolvedValueOnce({
        success: true,
        listingId: "pl-2",
        externalListingId: "MLB1000",
        permalink: "https://ml.ai/item/MLB1000",
      } as any);

    const marketplaceModule =
      await import("../app/marketplaces/usecases/marketplace.usercase");

    // Simulate that on recheck the account is ACTIVE
    vi.spyOn(
      marketplaceModule.MarketplaceUseCase,
      "getAccountStatus",
    ).mockResolvedValue({
      connected: true,
      account: { status: "ACTIVE" },
      message: "Conta ativa",
    } as any);

    const payload = {
      sku: "PROD-1001",
      name: "Teste retry anúncio",
      price: 75,
      stock: 1,
      imageUrl: "http://localhost:3333/uploads/test.jpg",
      createListing: true,
      createListingCategoryId: "MLB271107",
    };

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("id", "prod-3");
    expect(body).toHaveProperty("listing");
    expect(body.listing.success).toBe(true);
    expect(body.listing.externalListingId).toBe("MLB1000");
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it.skip("rechecks multiple times and succeeds when account becomes ACTIVE after a short delay", async () => {
    const fakeUser = { id: "user-2", email: "test2@example.com" } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => ({ id: "prod-4", ...data }) as any,
    );

    const listingModule =
      await import("../app/marketplaces/usecases/listing.usercase");

    // First call -> skipped; Second call -> success
    const createSpy = vi
      .spyOn(listingModule.ListingUseCase, "createMLListing")
      .mockResolvedValueOnce({ success: false, skipped: true } as any)
      .mockResolvedValueOnce({
        success: true,
        externalListingId: "MLB2000",
      } as any);

    const marketplaceModule =
      await import("../app/marketplaces/usecases/marketplace.usercase");

    // getAccountStatus: first call -> still INACTIVE, second call -> ACTIVE
    const statusSpy = vi
      .spyOn(marketplaceModule.MarketplaceUseCase, "getAccountStatus")
      .mockResolvedValueOnce({
        connected: false,
        account: { status: "INACTIVE" },
      } as any)
      .mockResolvedValue({
        connected: true,
        account: { status: "ACTIVE" },
      } as any);

    const payload = {
      sku: "PROD-1002",
      name: "Teste retry delay",
      price: 80,
      stock: 1,
      imageUrl: "http://localhost:3333/uploads/test.jpg",
      createListing: true,
      createListingCategoryId: "MLB271107",
    };

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test2@example.com" },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.listing.success).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(statusSpy).toHaveBeenCalled();
  });

  it.skip("does NOT perform vacation rechecks when skipped due to ML policy restriction (restrictions_coliving)", async () => {
    const fakeUser = { id: "user-3", email: "test3@example.com" } as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );

    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) => ({ id: "prod-5", ...data }) as any,
    );

    const listingModule =
      await import("../app/marketplaces/usecases/listing.usercase");

    // Simulate ML returning a policy restriction cause on the first (and only) create attempt
    const createSpy = vi
      .spyOn(listingModule.ListingUseCase, "createMLListing")
      .mockResolvedValueOnce({
        success: false,
        skipped: true,
        error: "Conta do Mercado Livre com restrição",
        mlError:
          '{"message":"seller.unable_to_list","cause":["restrictions_coliving"]}',
      } as any);

    const marketplaceModule =
      await import("../app/marketplaces/usecases/marketplace.usercase");

    const statusSpy = vi.spyOn(
      marketplaceModule.MarketplaceUseCase,
      "getAccountStatus",
    );

    const payload = {
      sku: "PROD-1003",
      name: "Teste policy skip",
      price: 90,
      stock: 1,
      imageUrl: "http://localhost:3333/uploads/test.jpg",
      createListing: true,
      createListingCategoryId: "MLB271107",
    };

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test3@example.com" },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.listing.skipped).toBe(true);
    // should NOT have attempted rechecks when the skip was caused by a policy restriction
    expect(statusSpy).not.toHaveBeenCalled();
    // createMLListing should be called exactly once
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when required fields are missing or invalid", async () => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
    } as any);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "",
        name: "",
        price: -10,
        stock: -1,
        imageUrl: "",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("error");
  });

  it("parses advanced list filters and forwards userId to the use case", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com" } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );

    const listSpy = vi
      .spyOn(ProductUseCase.prototype, "listProducts")
      .mockResolvedValue({
        products: [],
        total: 0,
        totalPages: 0,
      });

    const res = await app.inject({
      method: "GET",
      url: "/products?search=cubo&page=2&limit=25&createdFrom=2026-01-01&createdTo=2026-01-31&publicationStatus=ACTIVE&stockStatus=LOW_STOCK&priceMin=10&priceMax=20.5&listingCategory=SHOPEE:SHP_12345&brand=Fiat&quality=SEMINOVO&locationId=loc-1&marketplace=SHOPEE",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(1);

    const filters = listSpy.mock.calls[0][0];
    expect(filters).toMatchObject({
      userId: "user-1",
      search: "cubo",
      page: 2,
      limit: 25,
      publicationStatus: "ACTIVE",
      stockStatus: "LOW_STOCK",
      priceMin: 10,
      priceMax: 20.5,
      listingCategory: "SHOPEE:SHP_12345",
      brand: "Fiat",
      quality: "SEMINOVO",
      locationId: "loc-1",
      marketplace: "SHOPEE",
    });
    expect(filters.createdFrom).toBeInstanceOf(Date);
    expect(filters.createdTo).toBeInstanceOf(Date);
  });

  it("accepts BOTH as explicit marketplace filter without rejecting listing categories", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com" } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );

    const listSpy = vi
      .spyOn(ProductUseCase.prototype, "listProducts")
      .mockResolvedValue({
        products: [],
        total: 0,
        totalPages: 0,
      });

    const res = await app.inject({
      method: "GET",
      url: "/products?marketplace=BOTH&listingCategory=SHOPEE:SHP_12345",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0][0]).toMatchObject({
      userId: "user-1",
      marketplace: "BOTH",
      listingCategory: "SHOPEE:SHP_12345",
    });
  });

  it("returns 400 when a list filter query param is invalid", async () => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
    } as any);

    const listSpy = vi.spyOn(ProductUseCase.prototype, "listProducts");

    const res = await app.inject({
      method: "GET",
      url: "/products?publicationStatus=INVALID_STATUS",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
    expect(JSON.parse(res.payload)).toHaveProperty("error");
  });

  it("returns product filter options for dynamic category and brand selects", async () => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
    } as any);

    const optionsSpy = vi
      .spyOn(ProductUseCase.prototype, "getFilterOptions")
      .mockResolvedValue({
        brands: ["Fiat", "Ford"],
        publishedCategories: [
          {
            value: "MERCADO_LIVRE:MLB114766",
            label: "Mercado Livre • Peças > Motor",
            platform: "MERCADO_LIVRE",
            categoryId: "MLB114766",
          },
        ],
      });

    const res = await app.inject({
      method: "GET",
      url: "/products/filter-options",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(optionsSpy).toHaveBeenCalledWith("user-1");
    expect(JSON.parse(res.payload)).toEqual({
      brands: ["Fiat", "Ford"],
      publishedCategories: [
        {
          value: "MERCADO_LIVRE:MLB114766",
          label: "Mercado Livre • Peças > Motor",
          platform: "MERCADO_LIVRE",
          categoryId: "MLB114766",
        },
      ],
    });
  });

  it("deletes a product when authenticated and product exists", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com" } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );

    // Ensure no marketplace listings are returned (avoid calling external remove)
    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockResolvedValue([]);

    // Spy repository delete to confirm it was called
    const deleteSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "delete")
      .mockResolvedValue(undefined as any);

    const res = await app.inject({
      method: "DELETE",
      url: "/products/prod-123",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(deleteSpy).toHaveBeenCalledWith("prod-123", "user-1");
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("message");
  });

  it("cascades listing removal for ML and Shopee when deleting a product", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com" } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );

    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockResolvedValue([
      {
        id: "listing-ml-1",
        externalListingId: "MLB123",
        marketplaceAccountId: "acc-ml",
        marketplaceAccount: { id: "acc-ml", platform: "MERCADO_LIVRE" },
      },
      {
        id: "listing-shopee-1",
        externalListingId: "987654321",
        marketplaceAccountId: "acc-shopee",
        marketplaceAccount: { id: "acc-shopee", platform: "SHOPEE" },
      },
    ]);

    const deleteSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "delete")
      .mockResolvedValue(undefined as any);

    removeListingMock.mockClear();
    removeListingMock.mockResolvedValue({
      success: true,
      closedOnMarketplace: true,
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/products/prod-123",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(removeListingMock).toHaveBeenCalledTimes(2);
    expect(removeListingMock).toHaveBeenCalledWith("listing-ml-1");
    expect(removeListingMock).toHaveBeenCalledWith("listing-shopee-1");
    expect(deleteSpy).toHaveBeenCalledWith("prod-123", "user-1");
    const body = JSON.parse(res.payload);
    expect(body.listingResults).toHaveLength(2);
    expect(body.listingResults.every((r: any) => r.closed === true)).toBe(true);
  });

  it("returns 409 and does NOT delete locally when a marketplace removal fails permanently", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com" } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );

    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockResolvedValue([
      {
        id: "listing-shopee-1",
        externalListingId: "987654321",
        marketplaceAccountId: "acc-shopee",
        marketplaceAccount: { id: "acc-shopee", platform: "SHOPEE" },
      },
    ]);

    const deleteSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "delete")
      .mockResolvedValue(undefined as any);

    removeListingMock.mockClear();
    removeListingMock.mockResolvedValueOnce({
      success: false,
      closedOnMarketplace: false,
      retryable: false,
      error: "item still active",
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/products/prod-123",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(409);
    expect(deleteSpy).not.toHaveBeenCalled();
    const body = JSON.parse(res.payload);
    expect(body.listingResults).toHaveLength(1);
    expect(body.listingResults[0].closed).toBe(false);
    expect(body.listingResults[0].error).toBe("item still active");
    expect(body.message).toMatch(/marketplace/);
  });

  it("returns 409 with retryable=true when failure is transient (retryable)", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com" } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );

    const prismaMock = (await import("@/app/lib/prisma")).default as any;
    prismaMock.productListing.findMany = vi.fn().mockResolvedValue([
      {
        id: "listing-ml-1",
        externalListingId: "MLB123",
        marketplaceAccountId: "acc-ml",
        marketplaceAccount: { id: "acc-ml", platform: "MERCADO_LIVRE" },
      },
    ]);

    const deleteSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "delete")
      .mockResolvedValue(undefined as any);

    removeListingMock.mockClear();
    removeListingMock.mockResolvedValueOnce({
      success: false,
      closedOnMarketplace: false,
      retryable: true,
      error: "rate limited after retries",
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/products/prod-123",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(409);
    expect(deleteSpy).not.toHaveBeenCalled();
    const body = JSON.parse(res.payload);
    expect(body.listingResults[0].retryable).toBe(true);
  });
});

describe("POST /products — auto-fill de dimensões via CSV + 400 só se CSV não cobre", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    const fakeUser = {
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    } as any;
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "findBySku").mockResolvedValue(
      null,
    );
    // Re-mock CategoryResolutionService: o vi.mock module-level (topo do
    // arquivo) usa vi.fn().mockResolvedValue(...), e vi.restoreAllMocks() em
    // afterEach de outros describes faz mockReset desses fns, zerando o
    // retorno e quebrando a resolução de categoria no nosso flow.
    const catModule = await import(
      "../app/marketplaces/services/category-resolution.service"
    );
    (catModule.CategoryResolutionService.resolveMLCategory as any) = vi
      .fn()
      .mockResolvedValue({
        externalId: "MLB-MOCK",
        fullPath: "Mock > Category",
        source: "explicit",
      });
    (catModule.CategoryResolutionService.ensureLeafLocalOnly as any) = vi
      .fn()
      .mockResolvedValue({
        externalId: "MLB-MOCK",
        fullPath: "Mock > Category",
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("auto-fill via weight: ML com weightKg + categoria fora do CSV deriva H/W/L do peso (Slice 2c)", async () => {
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(async (data: any) => ({
        ...data,
        id: "prod-weight-derived",
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as any);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "PROD-NO-DIMS-1",
        name: "Sonda Lambda Sem Dimensões",
        price: 99,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/x.jpg",
        // heightCm/widthCm/lengthCm OMITIDOS — só weightKg cadastrado
        weightKg: 8,
        listings: [
          {
            platform: "MERCADO_LIVRE",
            categoryId: "MLB123",
            accountIds: ["acc-ml-1"],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as any;
    // weightKg=8 cai na faixa "5 <= w < 15" → base { h:25, w:30, l:40 } + jitter
    expect(arg.heightCm).toBeGreaterThanOrEqual(5);
    expect(arg.widthCm).toBeGreaterThanOrEqual(5);
    expect(arg.lengthCm).toBeGreaterThanOrEqual(5);
    expect(arg.weightKg).toBe(8); // preservado
    // Sanidade: não pode ter caído no fallback fixo 10x10x10 (anti-pattern ML).
    const allTen =
      arg.heightCm === 10 && arg.widthCm === 10 && arg.lengthCm === 10;
    expect(allTen).toBe(false);
  });

  it("default fallback (Slice 2d): ML sem nada NUNCA mais retorna 400 — aplica autopeça pequena com jitter", async () => {
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(async (data: any) => ({
        ...data,
        id: "prod-default-fallback",
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as any);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "PROD-NO-ANYTHING-1",
        name: "Produto Sem Nada",
        price: 99,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/x.jpg",
        // SEM heightCm/widthCm/lengthCm E SEM weightKg
        listings: [
          {
            platform: "MERCADO_LIVRE",
            categoryId: "MLB123",
            accountIds: ["acc-ml-1"],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as any;
    // Fallback default: base 15x15x10 cm + jitter, peso 0.5-0.99kg
    expect(arg.heightCm).toBeGreaterThanOrEqual(5);
    expect(arg.widthCm).toBeGreaterThanOrEqual(5);
    expect(arg.lengthCm).toBeGreaterThanOrEqual(5);
    expect(arg.weightKg).toBeGreaterThan(0);
    expect(arg.weightKg).toBeLessThan(1.0);
    // Não pode ser 10x10x10 (padrão fixo que ML detecta)
    expect(
      arg.heightCm === 10 && arg.widthCm === 10 && arg.lengthCm === 10,
    ).toBe(false);
  });

  it("default fallback: weightKg=0 também recebe valores default (peso e dimensões)", async () => {
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(async (data: any) => ({
        ...data,
        id: "prod-zero-w",
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as any);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "PROD-ZERO-WEIGHT-1",
        name: "Produto Peso Zero",
        price: 50,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/x.jpg",
        heightCm: 10,
        widthCm: 10,
        lengthCm: 10,
        weightKg: 0,
        listings: [
          {
            platform: "MERCADO_LIVRE",
            categoryId: "MLB123",
            accountIds: ["acc-ml-1"],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const arg = createSpy.mock.calls[0][0] as any;
    // weightKg=0 deve ser substituído por fallback (0.5-0.99kg)
    expect(arg.weightKg).toBeGreaterThan(0);
    expect(arg.weightKg).toBeLessThan(1.0);
  });

  it("permite criação SEM ML mesmo quando dimensões faltam (Shopee tem fallback hardcoded — não regrediu)", async () => {
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockResolvedValue({
        id: "prod-shopee-no-dims",
        sku: "PROD-SHP-1",
        name: "Produto só Shopee",
        stock: 1,
        price: 99,
        imageUrl: "http://localhost/x.jpg",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "PROD-SHP-1",
        name: "Produto só Shopee",
        price: 99,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/x.jpg",
        // sem dimensões — Shopee tem fallback (10x10x10/1kg) internamente
        listings: [
          {
            platform: "SHOPEE",
            categoryId: "102340",
            accountIds: ["acc-shp-1"],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("permite criação SEM listings nenhum mesmo sem dimensões (caminho de cadastro puro)", async () => {
    const createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockResolvedValue({
        id: "prod-only-record",
        sku: "PROD-ONLY-1",
        name: "Produto Cadastro Puro",
        stock: 1,
        price: 99,
        imageUrl: "http://localhost/x.jpg",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: {
        sku: "PROD-ONLY-1",
        name: "Produto Cadastro Puro",
        price: 99,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/x.jpg",
        // sem dimensões, sem listings — só cadastrar
      },
    });

    expect(res.statusCode).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  // Nota: o "caminho feliz" com dimensões já preenchidas pelo client
  // é coberto pelo teste "creates a product when payload is valid and user exists"
  // do describe principal.

  it("smoke do CSV de auto-fill: getMeasurementsForCategory cobre categorias comuns de autopeça", async () => {
    // Sanity check direto da lib (sem rota HTTP), pra garantir que o CSV
    // resolve categorias frequentes do Dexo. Se isso quebrar, é regressão
    // no CSV (app/lib/ml-measurements.ts) — investigar lá.
    const mod = await import("@/app/lib/ml-measurements");
    const { getMeasurementsForCategory } = mod;

    // Categoria que aparece nos logs de criação (Sonda Lambda → Injeção)
    // não está literalmente no CSV mas o nome do produto contendo "Sonda"
    // ou similares pode dar match. Quando não dá, a rota retorna 400 com
    // mensagem clara — comportamento já coberto pelos testes acima.

    // Categoria explicitamente no CSV: "Calotas" (linha do CSV: 35;35;35;2)
    const calotas = getMeasurementsForCategory("Calotas");
    expect(calotas).toBeDefined();
    expect(calotas?.heightCm).toBeGreaterThan(0);
    expect(calotas?.widthCm).toBeGreaterThan(0);
    expect(calotas?.lengthCm).toBeGreaterThan(0);
    expect(calotas?.weightKg).toBeGreaterThan(0);

    // Categoria com fullPath (formato que o backend usa)
    const composta = getMeasurementsForCategory(
      "Acessórios para Veículos > Calotas",
    );
    expect(composta).toBeDefined();
  });
});

describe("POST /products/nfe/parse (integration)", () => {
  let nfeApp: ReturnType<typeof fastify>;

  const VALID_NFE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe versao="4.00">
    <ide><mod>55</mod><nNF>1</nNF></ide>
    <emit><xNome>FORNECEDOR TESTE</xNome></emit>
    <det nItem="1"><prod>
      <cProd>ABC123</cProd><cEAN>7890000000017</cEAN>
      <xProd>PASTILHA DE FREIO DIANTEIRA</xProd>
      <uCom>UN</uCom><qCom>5.0000</qCom><vUnCom>45.9000</vUnCom><vProd>229.50</vProd>
    </prod></det>
  </infNFe></NFe>
</nfeProc>`;

  const DOCTYPE_NFE = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<nfeProc><NFe><infNFe><ide><mod>55</mod></ide></infNFe></NFe></nfeProc>`;

  beforeEach(async () => {
    nfeApp = fastify();
    await nfeApp.register(fastifyMultipart, {
      limits: { fileSize: 5 * 1024 * 1024 },
    });
    await nfeApp.register(productRoutes, { prefix: "/products" });
    // authMiddleware resolve o usuário autenticado por email.
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await nfeApp.close();
  });

  const injectXml = (xml: string) => {
    const form = new FormData();
    form.append("file", xml, {
      filename: "nota.xml",
      contentType: "application/xml",
    });
    return nfeApp.inject({
      method: "POST",
      url: "/products/nfe/parse",
      headers: { email: "test@example.com", ...form.getHeaders() },
      payload: form,
    });
  };

  it("retorna 200 e itens normalizados para um XML válido", async () => {
    const res = await injectXml(VALID_NFE);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: "PASTILHA DE FREIO DIANTEIRA",
      costPrice: 45.9,
      quantity: 5,
      unit: "UN",
    });
    expect(body.meta.groupedCount).toBe(1);
  });

  it("bloqueia XXE (DOCTYPE) com status 400", async () => {
    const res = await injectXml(DOCTYPE_NFE);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/DOCTYPE/i);
  });

  it("retorna 400 quando nenhum arquivo é enviado", async () => {
    const form = new FormData();
    form.append("naoArquivo", "x");
    const res = await nfeApp.inject({
      method: "POST",
      url: "/products/nfe/parse",
      headers: { email: "test@example.com", ...form.getHeaders() },
      payload: form,
    });
    expect(res.statusCode).toBe(400);
  });

  it("retorna 400 para conteúdo não-multipart", async () => {
    const res = await nfeApp.inject({
      method: "POST",
      url: "/products/nfe/parse",
      headers: {
        email: "test@example.com",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ foo: "bar" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

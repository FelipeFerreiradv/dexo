import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

// Prevent heavy marketplace/usecase imports from pulling prisma alias in this test
vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: async () => ({
      id: "MLB-TEST",
      permalink: "https://ml.test/MLB-TEST",
    }),
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

  it("creates product and triggers listing creation when createListing is true", async () => {
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

  it("retries listing once when first attempt is skipped and account recheck becomes ACTIVE", async () => {
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

  it("rechecks multiple times and succeeds when account becomes ACTIVE after a short delay", async () => {
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

  it("does NOT perform vacation rechecks when skipped due to ML policy restriction (restrictions_coliving)", async () => {
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
    expect(deleteSpy).toHaveBeenCalledWith("prod-123");
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("message");
  });
});

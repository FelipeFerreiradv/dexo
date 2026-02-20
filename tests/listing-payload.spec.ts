import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the MarketplaceRepository module (avoids loading prisma via @/ alias in tests)
vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByUserIdAndPlatform: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

// Mock CategoryRepository to avoid loading prisma when modules import it
vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  CategoryRepository: {
    findByFullPath: vi.fn().mockResolvedValue(null),
    findByExternalId: vi.fn().mockResolvedValue(null),
    listFlattenedOptions: vi.fn().mockResolvedValue([]),
  },
  default: {
    findByFullPath: vi.fn().mockResolvedValue(null),
    findByExternalId: vi.fn().mockResolvedValue(null),
    listFlattenedOptions: vi.fn().mockResolvedValue([]),
  },
}));

import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";

// Import the usecase after the mock is set up
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

describe("ListingUseCase → ML payload with measurements", () => {
  const mockAccount = {
    id: "acct-1",
    accessToken: "fake-token",
    accountName: "MLB",
  } as any;

  const mockProduct = {
    id: "prod-1",
    sku: "SKU-1",
    name: "Calota Exemplo",
    description: "Descrição da calota",
    price: 100,
    stock: 5,
    imageUrl: "/uploads/calota.jpg",
    heightCm: 35,
    widthCm: 35,
    lengthCm: 35,
    weightKg: 2,
  } as any;

  beforeEach(() => {
    (MarketplaceRepository.findByUserIdAndPlatform as unknown as jest.Mock) = vi
      .spyOn(MarketplaceRepository, "findByUserIdAndPlatform")
      .mockResolvedValue(mockAccount as any);

    // Default: pre-check should succeed unless overridden by a specific test
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 123,
      nickname: "seller",
    } as any);
    vi.spyOn(MLApiService, "getSellerItemIds").mockResolvedValue([] as any);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
      mockProduct as any,
    );
    vi.spyOn(ListingRepository, "createListing").mockResolvedValue({
      id: "listing-1",
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends shipping.dimensions when product has measurements", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB123",
      permalink: "https://ml.ai/item/MLB123",
    } as any);

    const updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );
    expect(res.success).toBe(true);

    expect(createSpy).toHaveBeenCalled();
    const payload = (createSpy.mock as any).calls[0][1];
    expect(payload).toBeDefined();
    expect(payload.shipping).toBeDefined();
    expect(payload.shipping.dimensions).toEqual({
      height: mockProduct.heightCm,
      width: mockProduct.widthCm,
      length: mockProduct.lengthCm,
      weight: mockProduct.weightKg,
    });

    // description must be pushed after creation
    expect(updateSpy).toHaveBeenCalled();
    const updateArgs = (updateSpy.mock as any).calls[0];
    expect(updateArgs[1]).toBe("MLB123");
    expect(updateArgs[2]).toHaveProperty("description");
    expect((updateArgs[2] as any).description).toContain("SKU: SKU-1");
  });

  it("resolves internal ML child id (MLB1765-01) to external category id before sending to ML API (on-demand sync when DB missing)", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB555",
      permalink: "https://ml.ai/item/MLB555",
    } as any);

    // Simulate DB missing mapping initially, then being available after a sync.
    const categoryRepo =
      await import("../app/marketplaces/repositories/category.repository");
    // Spy both the named export and the default export (listing.usercase imports default)
    const findSpyNamed = vi
      .spyOn(categoryRepo.CategoryRepository, "findByFullPath")
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({
        externalId: "MLB271107",
        fullPath:
          "Acessórios para Veículos > Peças de Carros e Caminhonetes > Suspensão e Direção > Cubo de Roda",
      } as any);

    const findSpyDefault = vi
      .spyOn(categoryRepo.default as any, "findByFullPath")
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({
        externalId: "MLB271107",
        fullPath:
          "Acessórios para Veículos > Peças de Carros e Caminhonetes > Suspensão e Direção > Cubo de Roda",
      } as any);

    // Mock the SyncUseCase module (avoid loading prisma during tests) and assert it gets called
    vi.mock("../app/marketplaces/usecases/sync.usercase", () => ({
      SyncUseCase: {
        syncMLCategories: vi
          .fn()
          .mockResolvedValue({ success: true, categories: 1 }),
      },
    }));
    const sync = await import("../app/marketplaces/usecases/sync.usercase");
    const syncSpy = sync.SyncUseCase.syncMLCategories;

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1765-01",
    );

    expect(res.success).toBe(true);
    expect(syncSpy).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalled();
    const payload = (createSpy.mock as any).calls[0][1];
    // payload must use resolved external category id
    expect(payload.category_id).toBe("MLB271107");
  });

  it("falls back to default ML category when internal child id cannot be resolved", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB999",
      permalink: "https://ml.ai/item/MLB999",
    } as any);

    // Ensure DB has no mapping and on-demand sync doesn't populate it
    const categoryRepo =
      await import("../app/marketplaces/repositories/category.repository");
    vi.spyOn(
      categoryRepo.CategoryRepository,
      "findByFullPath",
    ).mockResolvedValue(null as any);
    vi.spyOn(categoryRepo.default as any, "findByFullPath").mockResolvedValue(
      null as any,
    );

    // Mock SyncUseCase to be a no-op (simulates failure or no categories available)
    vi.mock("../app/marketplaces/usecases/sync.usercase", () => ({
      SyncUseCase: {
        syncMLCategories: vi
          .fn()
          .mockResolvedValue({ success: false, categories: 0 }),
      },
    }));

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1765-01",
    );

    expect(res.success).toBe(true);
    expect(createSpy).toHaveBeenCalled();

    const payload = (createSpy.mock as any).calls[0][1];
    // when mapping can't be resolved we must NOT send the internal id — use fallback
    expect(payload.category_id).toBe("MLB271107");
  });

  it("does not accept hyphenated/internal-looking categoryId as an external id (prevents sending synthetic IDs to ML)", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB999",
      permalink: "https://ml.ai/item/MLB999",
    } as any);

    // Simulate DB incorrectly containing a hyphenated 'externalId' (from fallback sync)
    const categoryRepo =
      await import("../app/marketplaces/repositories/category.repository");
    vi.spyOn(
      categoryRepo.CategoryRepository,
      "findByExternalId",
    ).mockResolvedValue({
      externalId: "MLB1765-01",
      fullPath:
        "Acessórios para Veículos > Peças de Carros e Caminhonetes > Suspensão e Direção > Cubo de Roda",
    } as any);

    // Ensure no fullPath resolution and no sync will populate a proper external id
    vi.spyOn(
      categoryRepo.CategoryRepository,
      "findByFullPath",
    ).mockResolvedValue(null as any);
    vi.mock("../app/marketplaces/usecases/sync.usercase", () => ({
      SyncUseCase: {
        syncMLCategories: vi
          .fn()
          .mockResolvedValue({ success: false, categories: 0 }),
      },
    }));

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1765-01",
    );

    expect(res.success).toBe(true);
    expect(createSpy).toHaveBeenCalled();

    const payload = (createSpy.mock as any).calls[0][1];
    // Must NOT send the hyphenated id to ML even if DB contains it
    expect(payload.category_id).not.toBe("MLB1765-01");
    expect(payload.category_id).toBe("MLB271107");
  });

  it("ignores DB mapping whose externalId looks synthetic/hyphenated when resolving by fullPath", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB999",
      permalink: "https://ml.ai/item/MLB999",
    } as any);

    // Simulate CategoryRepository.findByFullPath returning a record but with a hyphenated externalId (invalid for ML)
    const categoryRepo =
      await import("../app/marketplaces/repositories/category.repository");
    vi.spyOn(
      categoryRepo.CategoryRepository,
      "findByFullPath",
    ).mockResolvedValue({
      externalId: "MLB1765-01",
      fullPath:
        "Acessórios para Veículos > Peças de Carros e Caminhonetes > Suspensão e Direção > Cubo de Roda",
    } as any);

    // Mock SyncUseCase to be a no-op
    vi.mock("../app/marketplaces/usecases/sync.usercase", () => ({
      SyncUseCase: {
        syncMLCategories: vi
          .fn()
          .mockResolvedValue({ success: false, categories: 0 }),
      },
    }));

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1765-01",
    );

    expect(res.success).toBe(true);
    expect(createSpy).toHaveBeenCalled();

    const payload = (createSpy.mock as any).calls[0][1];
    // DB mapping externalId is synthetic/hyphenated -> must be ignored and fallback used
    expect(payload.category_id).toBe("MLB271107");
  });

  it("returns error and marks account when ML returns seller.unable_to_list", async () => {
    const err = new Error(
      'Erro ao criar item: {"message":"seller.unable_to_list","error":"User is unable to list.","status":403,"cause":["restrictions_coliving"]}',
    );

    vi.spyOn(MLApiService, "createItem").mockRejectedValue(err);

    const updateStatusSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const logSpy = vi
      .spyOn(
        (await import("../app/services/system-log.service")).SystemLogService,
        "logError",
      )
      .mockResolvedValue(undefined as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    // must NOT mark the account as ERROR for seller.unable_to_list (policy restriction)
    expect(updateStatusSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      "ERROR",
    );
    expect(logSpy).toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(
      /restri[cç]ão|impossibilitado|Seller Center|restrictions_coliving/i,
    );
  }, 15000);

  it("pre-check detects seller restriction before createItem", async () => {
    // ensure getUserInfo returns a seller id
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 123,
      nickname: "seller",
    } as any);

    // simulate ML indicating seller is unable to list during capability check
    vi.spyOn(MLApiService, "getSellerItemIds").mockRejectedValue(
      new Error(
        '{"message":"seller.unable_to_list","error":"User is unable to list.","status":403}',
      ),
    );

    const updateStatusSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);
    const logSpy = vi
      .spyOn(
        (await import("../app/services/system-log.service")).SystemLogService,
        "logError",
      )
      .mockResolvedValue(undefined as any);

    const createSpy = vi.spyOn(MLApiService, "createItem");

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(updateStatusSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(
      /restri[cç]ão|impossibilitado|restrictions_coliving/i,
    );
  }, 15000);

  it("pre-check transient seller restriction recovers on retry and proceeds to create", async () => {
    // simulate transient failure on first capability check, success on retry
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 123,
    } as any);
    const getSellerSpy = vi
      .spyOn(MLApiService, "getSellerItemIds")
      .mockRejectedValueOnce(
        new Error('{"message":"seller.unable_to_list","status":403}'),
      )
      .mockResolvedValueOnce([] as any);

    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB-TRANSIENT",
      permalink: "https://ml.ai/item/MLB-TRANSIENT",
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(getSellerSpy).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.externalListingId).toBe("MLB-TRANSIENT");
  });

  it("returns error when product has no image", async () => {
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "findById",
    ).mockResolvedValueOnce({
      id: "prod-1",
      sku: "SKU-1",
      name: "Calota Exemplo",
      description: "Descrição da calota",
      price: 100,
      stock: 5,
      imageUrl: undefined,
    } as any);

    const createSpy = vi.spyOn(MLApiService, "createItem");

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/imagem/i);
  });

  it("refreshes expired ML token before creating listing", async () => {
    // expired account returned by repository
    const expiredAccount = {
      id: "acct-exp",
      accessToken: "old-token",
      refreshToken: "rt-old",
      accountName: "MLB",
      expiresAt: new Date(Date.now() - 1000),
    } as any;

    vi.spyOn(
      MarketplaceRepository,
      "findByUserIdAndPlatform",
    ).mockResolvedValueOnce(expiredAccount as any);

    // Mock refresh to return new tokens
    const refreshSpy = vi
      .spyOn(MLOAuthService, "refreshAccessToken")
      .mockResolvedValue({
        accessToken: "fresh-token",
        refreshToken: "rt-new",
        expiresIn: 3600,
      } as any);

    // Ensure updateTokens writes the refreshed token back
    const updatedAccount = {
      ...expiredAccount,
      accessToken: "fresh-token",
      refreshToken: "rt-new",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    } as any;
    const updateTokensSpy = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValueOnce(updatedAccount as any);

    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB321",
      permalink: "https://ml.ai/item/MLB321",
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    console.log("TEST-DEBUG res=>", res);

    expect(refreshSpy).toHaveBeenCalledWith("rt-old");
    expect(updateTokensSpy).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith("fresh-token", expect.any(Object));
    expect(res.success).toBe(true);
  });

  it("reactivates INACTIVE account when capability re-check succeeds", async () => {
    const inactiveAccount = {
      id: "acct-inactive",
      accessToken: "ok-token",
      refreshToken: "rt-ok",
      accountName: "MLB",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      status: "INACTIVE",
    } as any;

    vi.spyOn(
      MarketplaceRepository,
      "findByUserIdAndPlatform",
    ).mockResolvedValueOnce(inactiveAccount as any);

    // capability check succeeds
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 123,
    } as any);
    vi.spyOn(MLApiService, "getSellerItemIds").mockResolvedValue([] as any);

    const updateStatusSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({ ...inactiveAccount, status: "ACTIVE" } as any);

    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB777",
      permalink: "https://ml.ai/item/MLB777",
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(updateStatusSpy).toHaveBeenCalledWith("acct-inactive", "ACTIVE");
    expect(createSpy).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it("retries on seller.unable_to_list from createItem and succeeds on retry", async () => {
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 123,
    } as any);

    // First createItem call fails with seller.unable_to_list, second succeeds
    const createSpy = vi
      .spyOn(MLApiService, "createItem")
      .mockRejectedValueOnce(
        new Error('{"message":"seller.unable_to_list","status":403}'),
      )
      .mockResolvedValueOnce({
        id: "MLB-Retry",
        permalink: "https://ml.ai/item/MLB-Retry",
      } as any);

    // getSellerItemIds used for quick re-check should succeed
    vi.spyOn(MLApiService, "getSellerItemIds").mockResolvedValue([] as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(res.success).toBe(true);
    expect(res.externalListingId).toBe("MLB-Retry");
  });

  it("returns error when ML token expired and refresh fails", async () => {
    const expiredAccount = {
      id: "acct-exp-2",
      accessToken: "old-token",
      refreshToken: "rt-old",
      accountName: "MLB",
      expiresAt: new Date(Date.now() - 1000),
    } as any;

    vi.spyOn(
      MarketplaceRepository,
      "findByUserIdAndPlatform",
    ).mockResolvedValueOnce(expiredAccount as any);

    // Fail refresh
    vi.spyOn(MLOAuthService, "refreshAccessToken").mockRejectedValue(
      new Error("refresh failed"),
    );
    const updateStatusSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const createSpy = vi.spyOn(MLApiService, "createItem");

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(updateStatusSpy).toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/reconecte/i);
  });
});

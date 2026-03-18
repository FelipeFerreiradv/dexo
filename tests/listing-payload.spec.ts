import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the MarketplaceRepository module (avoids loading prisma via @/ alias in tests)
vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByUserIdAndPlatform: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findByIdAndUser: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

// Mock SystemLogService to avoid prisma writes
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

// Mock CategoryRepository to avoid loading prisma when modules import it
vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  CategoryRepository: {
    findByFullPath: vi.fn().mockResolvedValue(null),
    findByExternalId: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    listFlattenedOptions: vi.fn().mockResolvedValue([]),
  },
  default: {
    findByFullPath: vi.fn().mockResolvedValue(null),
    findByExternalId: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    listFlattenedOptions: vi.fn().mockResolvedValue([]),
  },
}));

import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";

// Import the usecase after the mock is set up
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

describe("ListingUseCase → ML payload with measurements", () => {
  const mockAccount = {
    id: "acct-1",
    accessToken: "fake-token",
    accountName: "MLB",
    status: "ACTIVE",
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
    vi.spyOn(MarketplaceRepository, "findByUserIdAndPlatform").mockResolvedValue(
      mockAccount as any,
    );
    vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
    ).mockResolvedValue(mockAccount as any);
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      mockAccount as any,
    );

    // Default: pre-check should succeed unless overridden by a specific test
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 123,
      nickname: "seller",
    } as any);
    vi.spyOn(MLApiService, "getSellerItemIds").mockResolvedValue([] as any);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
      mockProduct as any,
    );
    vi.spyOn(MLApiService, "upsertDescription").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(ListingRepository, "createListing").mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.spyOn(ListingRepository, "findByProductAndAccount").mockResolvedValue(
      null as any,
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(ListingRepository, "incrementRetryAttempts").mockResolvedValue(
      {} as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends shipping.dimensions when product has measurements", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB123",
      permalink: "https://ml.ai/item/MLB123",
    } as any);

    const descSpy = vi
      .spyOn(MLApiService, "upsertDescription")
      .mockResolvedValue(undefined as any);

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
    expect(payload.shipping.dimensions).toBe(
      `${mockProduct.heightCm}x${mockProduct.widthCm}x${mockProduct.lengthCm},${mockProduct.weightKg}`,
    );

    // seller_package_* attributes should be injected for accounts that require them
    const attrIds = (payload.attributes || []).map((a: any) => a.id);
    expect(attrIds).toContain("SELLER_PACKAGE_HEIGHT");
    expect(attrIds).toContain("SELLER_PACKAGE_WIDTH");
    expect(attrIds).toContain("SELLER_PACKAGE_LENGTH");
    expect(attrIds).toContain("SELLER_PACKAGE_WEIGHT");
    const hAttr = payload.attributes.find((a: any) => a.id === "SELLER_PACKAGE_HEIGHT");
    const wAttr = payload.attributes.find((a: any) => a.id === "SELLER_PACKAGE_WIDTH");
    const lAttr = payload.attributes.find((a: any) => a.id === "SELLER_PACKAGE_LENGTH");
    const wgAttr = payload.attributes.find((a: any) => a.id === "SELLER_PACKAGE_WEIGHT");
    expect(hAttr.value_name).toBe(`${mockProduct.heightCm} cm`);
    expect(wAttr.value_name).toBe(`${mockProduct.widthCm} cm`);
    expect(lAttr.value_name).toBe(`${mockProduct.lengthCm} cm`);
    expect(wgAttr.value_name).toBe(`${mockProduct.weightKg * 1000} g`);

    // description must be pushed after creation using dedicated endpoint
    expect(descSpy).toHaveBeenCalled();
    const descArgs = (descSpy.mock as any).calls[0];
    expect(descArgs[1]).toBe("MLB123");
    expect(descArgs[2]).toBe(mockProduct.description);
  });

  it("uses user's default description when product description is empty", async () => {
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "findById",
    ).mockResolvedValueOnce({
      ...mockProduct,
      description: undefined,
      userId: "owner-1",
    } as any);

    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValueOnce({
      id: "owner-1",
      defaultProductDescription: "Descricao padrao do usuario",
    } as any);

    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB888",
      permalink: "https://ml.ai/item/MLB888",
    } as any);
    const descSpy = vi.spyOn(MLApiService, "upsertDescription");

    const res = await ListingUseCase.createMLListing(
      "owner-1",
      "prod-1",
      "MLB271107",
    );

    expect(res.success).toBe(true);
    const payload = (createSpy.mock as any).calls[0][1];
    expect(payload.description.plain_text).toContain(
      "Descricao padrao do usuario",
    );
    expect(descSpy).toHaveBeenCalledWith(
      expect.any(String),
      "MLB888",
      expect.stringContaining("Descricao padrao do usuario"),
    );
  });

  it("infers category from product.category fullPath when not provided", async () => {
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "findById",
    ).mockResolvedValueOnce({
      ...mockProduct,
      category:
        "AcessÃ³rios para VeÃ­culos > PeÃ§as de Carros e Caminhonetes > SuspensÃ£o e DireÃ§Ã£o > Cubo de Roda",
    } as any);

    const categoryRepo =
      await import("../app/marketplaces/repositories/category.repository");
    (categoryRepo.CategoryRepository.findByFullPath as any).mockResolvedValueOnce(
      {
        externalId: "MLB-CUBO",
        fullPath:
          "AcessÃ³rios para VeÃ­culos > PeÃ§as de Carros e Caminhonetes > SuspensÃ£o e DireÃ§Ã£o > Cubo de Roda",
      },
    );
    (categoryRepo.default as any).findByFullPath.mockResolvedValueOnce({
      externalId: "MLB-CUBO",
      fullPath:
        "AcessÃ³rios para VeÃ­culos > PeÃ§as de Carros e Caminhonetes > SuspensÃ£o e DireÃ§Ã£o > Cubo de Roda",
    });

    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB777",
      permalink: "https://ml.ai/item/MLB777",
    } as any);

    const res = await ListingUseCase.createMLListing("user-1", "prod-1");

    expect(res.success).toBe(true);
    const payload = (createSpy.mock as any).calls[0][1];
    expect(payload.category_id).toBe("MLB-CUBO");
  });

  it("honors explicit accountId and uses its access token", async () => {
    const altAccount = {
      ...mockAccount,
      id: "acct-2",
      accessToken: "token-B",
    };

    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValueOnce(
      altAccount as any,
    );
    const fallbackSpy = vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
    );
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB900",
      permalink: "https://ml.ai/item/MLB900",
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
      "acct-2",
    );

    expect(res.success).toBe(true);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith(
      "token-B",
      expect.objectContaining({ category_id: "MLB271107" }),
    );
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
      status: "ACTIVE",
    } as any;

    vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
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
      "findFirstActiveByUserAndPlatform",
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
      status: "ACTIVE",
    } as any;

    vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
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

  it("handles family_name domains by retrying without title when ML rejects the field", async () => {
    const errors: any[] = [
      new Error(
        "Erro ao criar item: {\"message\":\"body.invalid_fields\",\"error\":\"The fields [title] are invalid for requested call.\",\"status\":400,\"cause\":[]}",
      ),
      null,
    ];

    // attach mlError to the first error to mimic MLApiService behavior
    (errors[0] as any).mlError = {
      message: "body.invalid_fields",
      error: "The fields [title] are invalid for requested call.",
      status: 400,
      cause: [],
    };

    const createSpy = vi
      .spyOn(MLApiService, "createItem")
      .mockImplementation(() => {
        const next = errors.shift();
        if (next) throw next;
        return Promise.resolve({ id: "MLB2222", permalink: "p" } as any);
      });

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValueOnce({
      ...mockProduct,
      name: "Porta diantera fiat uno 2004",
      brand: "Fiat",
      model: "UNO",
      year: 2004,
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB101763",
    );

    expect(res.success).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const firstPayload = (createSpy.mock as any).calls[0][1];
    expect(firstPayload.family_name).toBe("Porta diantera fiat uno 2004");
    expect(firstPayload.title).toBeUndefined(); // title omitido para domínios UP (noTitleWithFamilyName)

    const secondPayload = (createSpy.mock as any).calls[1][1];
    expect((secondPayload as any).family_name).toBe("Porta diantera fiat uno 2004");
    expect((secondPayload as any).title).toBeUndefined(); // title removido para domínios UP
  });

  it("preserves product name verbatim as title and omits family_name", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB5555",
      permalink: "https://ml.ai/item/MLB5555",
    } as any);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValueOnce({
      ...mockProduct,
      name: "Cubo de roda fiat uno 2004",
      brand: "Fiat",
      model: "UNO",
      year: 2004,
      description: "Descricao oficial do produto",
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(res.success).toBe(true);
    const payload = (createSpy.mock as any).calls[0][1];
    expect(payload.title).toBe("Cubo de roda fiat uno 2004");
    expect(payload.family_name).toBeUndefined();
    expect(payload.description.plain_text).toBe("Descricao oficial do produto");
    const attrIds = (payload.attributes || []).map((a: any) => a.id);
    expect(attrIds).toContain("BRAND");
    expect(payload.attributes.find((a: any) => a.id === "BRAND").value_name).toBe("Fiat");
    expect(payload.attributes.find((a: any) => a.id === "MODEL").value_name).toBe("UNO");
    // YEAR attribute should be present for valid years
    expect(payload.attributes.find((a: any) => a.id === "YEAR")?.value_name).toBe("2004");
  });

  it("does not send MODEL when it is just the year (keeps YEAR separate)", async () => {
    const createSpy = vi.spyOn(MLApiService, "createItem").mockResolvedValue({
      id: "MLB5666",
      permalink: "https://ml.ai/item/MLB5666",
    } as any);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValueOnce({
      ...mockProduct,
      name: "Cubo de roda hb20 hyundai 2016",
      brand: "Hyundai",
      model: "2016",
      year: 2016,
      description: "Descricao limpa",
    } as any);

    const res = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB271107",
    );

    expect(res.success).toBe(true);
    const payload = (createSpy.mock as any).calls[0][1];
    const modelAttr = (payload.attributes || []).find((a: any) => a.id === "MODEL");
    expect(modelAttr).toBeUndefined();
    const yearAttr = (payload.attributes || []).find((a: any) => a.id === "YEAR");
    expect(yearAttr?.value_name).toBe("2016");
  });
});

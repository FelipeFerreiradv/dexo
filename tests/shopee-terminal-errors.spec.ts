import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Characterization tests for Shopee terminal error classification.
 *
 * These validate that:
 * 1. Oversize errors are classified as terminal (no retry)
 * 2. Duplicate item errors are classified as terminal (no retry)
 * 3. Transient errors still allow retry with backoff
 * 4. Attempt counter increments correctly
 */

// --- Mocks ---
vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    findByProductAndAccount: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getSellerItemIds: vi.fn(),
    createItem: vi.fn(),
    getItemDetails: vi.fn().mockResolvedValue({ status: "active" }),
    updateItem: vi.fn().mockResolvedValue({ id: "MLB1" }),
    uploadPictureFromUrl: vi.fn().mockResolvedValue({ id: "pic-1" }),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), log: vi.fn() },
}));

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findAllByUserIdAndPlatform: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: {
    createItem: vi.fn(),
    uploadImage: vi.fn(),
    getCategoryAttributes: vi.fn(),
    getLogisticsChannelList: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/shopee-oauth.service", () => ({
  ShopeeOAuthService: {
    refreshAccessToken: vi.fn(),
    calculateExpiryDate: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
      source: "explicit",
    }),
  },
}));

vi.mock("../app/repositories/user.repository", () => ({
  UserRepositoryPrisma: vi.fn().mockImplementation(() => ({
    findById: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  ensureMLMinImageSize: vi.fn(async (buf: Buffer) => buf),
}));

// Import after mocks
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";

describe("Shopee terminal error classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeShopeeCandidate = (overrides?: Partial<any>) => ({
    id: "listing-shp-1",
    externalListingId: "PENDING_SHP_123",
    status: "pending",
    retryAttempts: 0,
    nextRetryAt: new Date(Date.now() - 1000),
    retryEnabled: true,
    product: {
      id: "prod-1",
      sku: "SKU-1",
      name: "Parachoque Gol 2010",
      price: 100,
      stock: 1,
      heightCm: 90,
      widthCm: 30,
      lengthCm: 15,
      weightKg: 1.5,
    },
    requestedCategoryId: "101710",
    marketplaceAccount: {
      id: "acct-shp-1",
      platform: "SHOPEE",
      userId: "user-1",
      accessToken: "shp-tok",
      refreshToken: "shp-refresh",
      shopId: "12345",
      expiresAt: new Date(Date.now() + 3600_000),
    },
    ...overrides,
  });

  it("disables retry for oversize terminal errors (Shopee exception path)", async () => {
    const candidate = makeShopeeCandidate();
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidate,
    ]);

    // Simulate the ListingUseCase throwing an oversize error
    vi.doMock("../app/marketplaces/usecases/listing.usercase", () => ({
      ListingUseCase: {
        createShopeeListing: vi.fn().mockRejectedValue(
          new Error(
            "Produto excede os limites de todos os canais logísticos habilitados no Shopee (30x90x15cm, 1.5kg). Detalhes: Correios: lado 90cm > máx 70cm.",
          ),
        ),
      },
    }));

    await ListingRetryService.runOnce();

    // Should mark as terminal: retryEnabled=false
    expect(ListingRepository.incrementRetryAttempts).toHaveBeenCalledWith(
      "listing-shp-1",
      expect.objectContaining({
        retryEnabled: false,
        lastError: expect.stringContaining("[TERMINAL]"),
      }),
    );
  });

  it("disables retry for duplicate item terminal errors (Shopee exception path)", async () => {
    const candidate = makeShopeeCandidate({ id: "listing-shp-2" });
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidate,
    ]);

    vi.doMock("../app/marketplaces/usecases/listing.usercase", () => ({
      ListingUseCase: {
        createShopeeListing: vi.fn().mockRejectedValue(
          new Error(
            "Erro ao criar item: This product duplicates another in your shop. Please modify it or remove the duplicate.",
          ),
        ),
      },
    }));

    await ListingRetryService.runOnce();

    expect(ListingRepository.incrementRetryAttempts).toHaveBeenCalledWith(
      "listing-shp-2",
      expect.objectContaining({
        retryEnabled: false,
        lastError: expect.stringContaining("[TERMINAL]"),
      }),
    );
  });

  it("allows retry for transient Shopee errors with backoff", async () => {
    const candidate = makeShopeeCandidate({
      id: "listing-shp-3",
      retryAttempts: 1,
    });
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidate,
    ]);

    vi.doMock("../app/marketplaces/usecases/listing.usercase", () => ({
      ListingUseCase: {
        createShopeeListing: vi.fn().mockRejectedValue(
          new Error("Shopee API timeout"),
        ),
      },
    }));

    await ListingRetryService.runOnce();

    expect(ListingRepository.incrementRetryAttempts).toHaveBeenCalledWith(
      "listing-shp-3",
      expect.objectContaining({
        retryEnabled: true,
        nextRetryAt: expect.any(Date),
      }),
    );
    // lastError should NOT contain [TERMINAL]
    const call = (ListingRepository.incrementRetryAttempts as any).mock
      .calls[0][1];
    expect(call.lastError).not.toContain("[TERMINAL]");
  });
});

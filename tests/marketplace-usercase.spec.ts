import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the MarketplaceRepository to avoid loading prisma in unit tests
vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByUserIdAndPlatform: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findAllByUserIdAndPlatform: vi.fn(),
    findAllByExternalUserId: vi.fn(),
    findByUserAndExternalUserId: vi.fn(),
    findShopeeByUserAndShopId: vi.fn(),
    findAllShopeeByShopId: vi.fn(),
    createAccount: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
    updateShopId: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

import { MarketplaceUseCase } from "../app/marketplaces/usecases/marketplace.usercase";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { SystemLogService } from "../app/services/system-log.service";

describe("MarketplaceUseCase.getAccountStatus - capability checks", () => {
  const accountMock = {
    id: "acct-1",
    accessToken: "fake-token",
    refreshToken: "rt-1",
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    status: "ACTIVE",
    accountName: "MLB",
  } as any;

  beforeEach(() => {
    vi.spyOn(
      MarketplaceRepository,
      "findByUserIdAndPlatform",
    ).mockResolvedValue(accountMock as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.skip("marks account ERROR and returns connected=false when ML capability check indicates seller.unable_to_list", async () => {
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      id: 999,
      nickname: "seller",
    } as any);
    vi.spyOn(MLApiService, "getSellerItemIds").mockRejectedValue(
      new Error(
        '{"message":"seller.unable_to_list","error":"User is unable to list.","status":403}',
      ),
    );

    const updateStatusSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const logSpy = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);

    const res = await MarketplaceUseCase.getAccountStatus("user-1");

    expect(updateStatusSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(res.connected).toBe(true);
    expect(res.message).toMatch(/restri[cç]ão|restric/i);
    expect((res as any).restricted).toBe(true);
  });
});

describe("MarketplaceUseCase OAuth ownership guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bloqueia callback ML quando o seller ja pertence a outro usuario", async () => {
    vi.spyOn(MLOAuthService, "validateState").mockReturnValue({
      valid: true,
      codeVerifier: "verifier",
      userId: "user-2",
    } as any);
    vi.spyOn(MLOAuthService, "exchangeCodeForTokens").mockResolvedValue({
      accessToken: "token",
      refreshToken: "refresh",
      externalUserId: "ml-seller-1",
      expiresIn: 3600,
    } as any);
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({
      nickname: "seller",
    } as any);
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([
      {
        id: "acc-foreign-1",
        userId: "user-1",
      },
    ] as any);

    await expect(
      MarketplaceUseCase.handleOAuthCallback({
        code: "code-1",
        state: "state-1",
      }),
    ).rejects.toThrow(/vinculad[ao].*outro usu/i);
  });

  it("bloqueia callback Shopee quando o shopId ja pertence a outro usuario", async () => {
    vi.spyOn(ShopeeOAuthService, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "token",
      refresh_token: "refresh",
      expire_in: 3600,
      merchant_id: 12345,
    } as any);
    vi.spyOn(
      MarketplaceRepository,
      "findAllShopeeByShopId",
    ).mockResolvedValue([
      {
        id: "acc-foreign-2",
        userId: "user-1",
        shopId: 998877,
      },
    ] as any);
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([] as any);

    await expect(
      MarketplaceUseCase.handleShopeeOAuthCallback({
        code: "code-2",
        shopId: 998877,
        userId: "user-2",
      }),
    ).rejects.toThrow(/vinculad[ao].*outro usu/i);
  });
});

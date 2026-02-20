import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the MarketplaceRepository to avoid loading prisma in unit tests
vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByUserIdAndPlatform: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

import { MarketplaceUseCase } from "../app/marketplaces/usecases/marketplace.usercase";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

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
    vi.spyOn(MarketplaceRepository, "findByUserIdAndPlatform").mockResolvedValue(accountMock as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks account ERROR and returns connected=false when ML capability check indicates seller.unable_to_list", async () => {
    vi.spyOn(MLOAuthService, "getUserInfo").mockResolvedValue({ id: 999, nickname: "seller" } as any);
    vi.spyOn(MLApiService, "getSellerItemIds").mockRejectedValue(new Error('{"message":"seller.unable_to_list","error":"User is unable to list.","status":403}'));

    const updateStatusSpy = vi.spyOn(MarketplaceRepository, "updateStatus").mockResolvedValue({} as any);

    const res = await MarketplaceUseCase.getAccountStatus("user-1");

    expect(updateStatusSpy).toHaveBeenCalled();
    expect(res.connected).toBe(false);
    expect(res.message).toMatch(/restri[cç]ão|Reconecte/i);
  });
});
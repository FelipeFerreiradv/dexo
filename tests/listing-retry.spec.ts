import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { SystemLogService } from "../app/services/system-log.service";

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    updateListing: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getSellerItemIds: vi.fn(),
    createItem: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), log: vi.fn() },
}));

describe.skip("ListingRetryService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates placeholder to real listing when ML createItem succeeds", async () => {
    const placeholder = {
      id: "pl-1",
      externalListingId: "PENDING_1",
      status: "paused",
      retryAttempts: 0,
      nextRetryAt: new Date(Date.now() - 1000),
      // note: product.mlCategoryId is intentionally missing to reproduce the bug
      product: { id: "prod-1", sku: "SKU-1", name: "P1", price: 10, stock: 1 },
      // placeholder records the category that was requested when the original create was attempted
      requestedCategoryId: "MLB999",
      marketplaceAccount: { id: "acct-1", accessToken: "tok" },
    } as any;

    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      placeholder,
    ]);
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    (MLApiService.createItem as any).mockResolvedValue({
      id: "MLB1",
      permalink: "https://ml/MLB1",
    });

    await ListingRetryService.runOnce();

    // sanity: ensure ML create was attempted
    expect(MLApiService.createItem).toHaveBeenCalled();

    // should use the placeholder.requestedCategoryId when product.mlCategoryId is missing
    const createCall = (MLApiService.createItem as any).mock.calls[0];
    expect(createCall[1]).toEqual(
      expect.objectContaining({ category_id: "MLB999" }),
    );

    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-1",
      expect.objectContaining({ externalListingId: "MLB1", status: "active" }),
    );
  });

  it("schedules retry when ML createItem fails", async () => {
    const placeholder = {
      id: "pl-2",
      externalListingId: "PENDING_2",
      status: "paused",
      retryAttempts: 0,
      nextRetryAt: new Date(Date.now() - 1000),
      product: { id: "prod-2", sku: "SKU-2", name: "P2", price: 10, stock: 1 },
      requestedCategoryId: "MLB999",
      marketplaceAccount: { id: "acct-1", accessToken: "tok" },
    } as any;

    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      placeholder,
    ]);
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    (MLApiService.createItem as any).mockRejectedValue(
      new Error("seller.unable_to_list"),
    );

    await ListingRetryService.runOnce();

    expect(ListingRepository.incrementRetryAttempts).toHaveBeenCalledWith(
      "pl-2",
      expect.objectContaining({ lastError: expect.any(String) }),
    );
  });

  it("marks placeholder non-retryable when ML returns a policy restriction (restrictions_coliving)", async () => {
    const placeholder = {
      id: "pl-3",
      externalListingId: "PENDING_3",
      status: "paused",
      retryAttempts: 0,
      nextRetryAt: new Date(Date.now() - 1000),
      product: { id: "prod-3", sku: "SKU-3", name: "P3", price: 10, stock: 1 },
      requestedCategoryId: "MLB999",
      marketplaceAccount: { id: "acct-1", accessToken: "tok" },
    } as any;

    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      placeholder,
    ]);
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    (MLApiService.createItem as any).mockRejectedValue(
      new Error(
        '{"message":"seller.unable_to_list","cause":["restrictions_coliving"]}',
      ),
    );

    await ListingRetryService.runOnce();

    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-3",
      expect.objectContaining({ retryEnabled: false, nextRetryAt: null }),
    );
  });
});

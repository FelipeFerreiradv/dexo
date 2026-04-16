import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { ShopeeApiService } from "../../services/shopee-api.service";
import { MLApiService } from "../../services/ml-api.service";

const SHOPEE_LISTING_ID = "listing-shopee-1";
const ML_LISTING_ID = "listing-ml-1";

const shopeeListing = {
  id: SHOPEE_LISTING_ID,
  externalListingId: "987654321",
  marketplaceAccountId: "acc-shopee",
  marketplaceAccount: { platform: Platform.SHOPEE },
} as any;

const mlListing = {
  id: ML_LISTING_ID,
  externalListingId: "MLB123456789",
  marketplaceAccountId: "acc-ml",
  marketplaceAccount: { platform: Platform.MERCADO_LIVRE },
} as any;

const shopeeAccount = {
  id: "acc-shopee",
  accessToken: "tok",
  shopId: 42,
} as any;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListingUseCase.removeShopeeListing", () => {
  it("returns error when listing not found", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(null as any);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it("skips external API when externalListingId starts with PENDING_", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue({
      ...shopeeListing,
      externalListingId: "PENDING_abc",
    });
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(ShopeeApiService, "deleteItem")
      .mockResolvedValue({ item_id: 1 } as any);

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("skips external API when account has no accessToken or shopId", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-shopee",
      accessToken: null,
      shopId: null,
    } as any);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(ShopeeApiService, "deleteItem")
      .mockResolvedValue({ item_id: 1 } as any);

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("skips external API when externalListingId is not numeric", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue({
      ...shopeeListing,
      externalListingId: "not-a-number",
    });
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(shopeeAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(ShopeeApiService, "deleteItem")
      .mockResolvedValue({ item_id: 1 } as any);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("calls Shopee deleteItem with shopId + itemId then deletes locally (happy path)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(shopeeAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(ShopeeApiService, "deleteItem")
      .mockResolvedValue({ item_id: 987654321 } as any);

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(api).toHaveBeenCalledWith("tok", 42, 987654321);
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("still deletes locally when Shopee deleteItem throws (best-effort parity with ML)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(shopeeAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(ShopeeApiService, "deleteItem")
      .mockRejectedValue(new Error("item still active"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(api).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });
});

describe("ListingUseCase.removeListing (dispatcher)", () => {
  it("delegates to removeMLListing for MERCADO_LIVRE platform", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    const ml = vi
      .spyOn(ListingUseCase, "removeMLListing")
      .mockResolvedValue({ success: true });
    const shopee = vi
      .spyOn(ListingUseCase, "removeShopeeListing")
      .mockResolvedValue({ success: true });

    const result = await ListingUseCase.removeListing(ML_LISTING_ID);

    expect(result.success).toBe(true);
    expect(ml).toHaveBeenCalledWith(ML_LISTING_ID);
    expect(shopee).not.toHaveBeenCalled();
  });

  it("delegates to removeShopeeListing for SHOPEE platform", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    const ml = vi
      .spyOn(ListingUseCase, "removeMLListing")
      .mockResolvedValue({ success: true });
    const shopee = vi
      .spyOn(ListingUseCase, "removeShopeeListing")
      .mockResolvedValue({ success: true });

    const result = await ListingUseCase.removeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(shopee).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
    expect(ml).not.toHaveBeenCalled();
  });

  it("returns error when listing not found", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(null as any);

    const result = await ListingUseCase.removeListing("unknown");

    expect(result.success).toBe(false);
  });

  it("falls back to local delete when platform is unknown", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue({
      ...shopeeListing,
      marketplaceAccount: { platform: null },
    });
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const ml = vi.spyOn(ListingUseCase, "removeMLListing");
    const shopee = vi.spyOn(ListingUseCase, "removeShopeeListing");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await ListingUseCase.removeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
    expect(ml).not.toHaveBeenCalled();
    expect(shopee).not.toHaveBeenCalled();
  });
});

// Unused re-import guard to keep ML service in the import graph for future tests
void MLApiService;

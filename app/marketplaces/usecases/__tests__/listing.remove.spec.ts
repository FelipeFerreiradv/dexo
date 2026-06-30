import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { ShopeeApiService } from "../../services/shopee-api.service";
import { MLApiService } from "../../services/ml-api.service";
import { MagaluApiService } from "../../services/magalu-api.service";

const SHOPEE_LISTING_ID = "listing-shopee-1";
const ML_LISTING_ID = "listing-ml-1";
const MAGALU_LISTING_ID = "listing-magalu-1";

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

const mlAccount = {
  id: "acc-ml",
  accessToken: "ml-tok",
} as any;

// Magalu: externalListingId fica PENDING_<sku> (202 async); a chave de API é o
// SKU (externalSku). expiresAt no futuro ⇒ ensureFreshMagaluToken não refresca.
const magaluListing = {
  id: MAGALU_LISTING_ID,
  externalListingId: "PENDING_SKU-MG",
  externalSku: "SKU-MG",
  marketplaceAccountId: "acc-magalu",
  marketplaceAccount: { platform: Platform.MAGALU },
  product: { sku: "SKU-MG", userId: "u1" },
} as any;

const magaluAccount = {
  id: "acc-magalu",
  accessToken: "mg-tok",
  refreshToken: "mg-ref",
  expiresAt: new Date(Date.now() + 3_600_000),
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
    expect(result.closedOnMarketplace).toBe(false);
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
    expect(result.closedOnMarketplace).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("does NOT delete locally when account has no accessToken/shopId (retryable)", async () => {
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

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("treats non-numeric externalListingId as local-only cleanup", async () => {
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
    expect(result.closedOnMarketplace).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("calls Shopee deleteItem and deletes locally on happy path", async () => {
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
    expect(result.closedOnMarketplace).toBe(true);
    expect(api).toHaveBeenCalledWith("tok", 42, 987654321);
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("treats Shopee error_inexist as idempotent success (item already gone)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(shopeeAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Erro ao deletar item: not exist"), {
      shopeeError: "product.error_inexist",
    });
    vi.spyOn(ShopeeApiService, "deleteItem").mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
  });

  it("does NOT delete locally on permanent Shopee error", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(shopeeAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Erro ao deletar item: invalid sig"), {
      shopeeError: "error.auth",
    });
    vi.spyOn(ShopeeApiService, "deleteItem").mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(false);
    expect(result.closedOnMarketplace).toBe(false);
    expect(result.retryable).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it("retries on 5xx and reports retryable=true after exhausting retries", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(shopeeAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Shopee API 500: boom"), {
      status: 500,
    });
    const api = vi
      .spyOn(ShopeeApiService, "deleteItem")
      .mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Speed up backoff: stub global setTimeout via vi.useFakeTimers would
    // complicate things; instead we rely on the retry helper completing
    // quickly because vitest awaits the promise chain. Default delays are
    // short enough for the test budget.
    vi.useFakeTimers();
    const resultPromise = ListingUseCase.removeShopeeListing(SHOPEE_LISTING_ID);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(api).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(del).not.toHaveBeenCalled();
  });
});

describe("ListingUseCase.removeMLListing", () => {
  it("returns error when listing not found", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(null as any);
    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);
    expect(result.success).toBe(false);
    expect(result.closedOnMarketplace).toBe(false);
  });

  it("skips external API and deletes locally when PENDING_", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue({
      ...mlListing,
      externalListingId: "PENDING_abc",
    });
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);

    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(ML_LISTING_ID);
  });

  it("does NOT delete locally when account has no accessToken (retryable)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-ml",
      accessToken: null,
    } as any);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });

  it("calls ML updateItem with status closed and deletes locally on happy path", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(mlAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(api).toHaveBeenCalledWith("ml-tok", "MLB123456789", {
      status: "closed",
    });
    expect(del).toHaveBeenCalledWith(ML_LISTING_ID);
  });

  it("treats ML 404 as idempotent success (item already gone)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(mlAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Erro ao atualizar item: not found"), {
      status: 404,
    });
    vi.spyOn(MLApiService, "updateItem").mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(del).toHaveBeenCalledWith(ML_LISTING_ID);
  });

  it("treats ML 'already closed' message as idempotent success", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(mlAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(
      new Error("Erro ao atualizar item: item is already closed"),
      { status: 400 },
    );
    vi.spyOn(MLApiService, "updateItem").mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(del).toHaveBeenCalledWith(ML_LISTING_ID);
  });

  it("does NOT delete locally on permanent ML error (e.g. 401)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(mlAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(
      new Error("Erro ao atualizar item: invalid token"),
      { status: 401 },
    );
    vi.spyOn(MLApiService, "updateItem").mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await ListingUseCase.removeMLListing(ML_LISTING_ID);

    expect(result.success).toBe(false);
    expect(result.closedOnMarketplace).toBe(false);
    expect(result.retryable).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it("retries on ML 429 and reports retryable=true after exhausting retries", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(mlAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Erro ao atualizar item: rate limit"), {
      status: 429,
    });
    const api = vi
      .spyOn(MLApiService, "updateItem")
      .mockRejectedValue(err);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.useFakeTimers();
    const resultPromise = ListingUseCase.removeMLListing(ML_LISTING_ID);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(api).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(del).not.toHaveBeenCalled();
  });
});

describe("ListingUseCase.removeMagaluListing", () => {
  it("local-only cleanup quando não há SKU (sem chamada externa)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue({
      ...magaluListing,
      externalSku: null,
      product: { sku: null, userId: "u1" },
    });
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi.spyOn(MagaluApiService, "patchSku");

    const result = await ListingUseCase.removeMagaluListing(MAGALU_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith(MAGALU_LISTING_ID);
  });

  it("NÃO deleta local quando a conta não tem token (retryable)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(magaluListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-magalu",
      accessToken: null,
    } as any);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi.spyOn(MagaluApiService, "patchSku");

    const result = await ListingUseCase.removeMagaluListing(MAGALU_LISTING_ID);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("PATCH active:false (pelo SKU) e deleta local no happy path", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(magaluListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(magaluAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const api = vi
      .spyOn(MagaluApiService, "patchSku")
      .mockResolvedValue({ trace_id: "t-1" });

    const result = await ListingUseCase.removeMagaluListing(MAGALU_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(api).toHaveBeenCalledWith("mg-tok", "SKU-MG", { active: false });
    expect(del).toHaveBeenCalledWith(MAGALU_LISTING_ID);
  });

  it("trata 404 (SKU já inexistente) como sucesso idempotente", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(magaluListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(magaluAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Erro ao atualizar SKU: not found"), {
      status: 404,
    });
    vi.spyOn(MagaluApiService, "patchSku").mockRejectedValue(err);

    const result = await ListingUseCase.removeMagaluListing(MAGALU_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(del).toHaveBeenCalledWith(MAGALU_LISTING_ID);
  });

  it("NÃO deleta local em erro permanente (ex.: 403)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(magaluListing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(magaluAccount);
    const del = vi
      .spyOn(ListingRepository, "deleteListing")
      .mockResolvedValue(undefined as any);
    const err = Object.assign(new Error("Erro ao atualizar SKU: forbidden"), {
      status: 403,
    });
    vi.spyOn(MagaluApiService, "patchSku").mockRejectedValue(err);

    const result = await ListingUseCase.removeMagaluListing(MAGALU_LISTING_ID);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("ListingUseCase.removeListing (dispatcher)", () => {
  it("delegates to removeMLListing for MERCADO_LIVRE platform", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(mlListing);
    const ml = vi
      .spyOn(ListingUseCase, "removeMLListing")
      .mockResolvedValue({ success: true, closedOnMarketplace: true });
    const shopee = vi
      .spyOn(ListingUseCase, "removeShopeeListing")
      .mockResolvedValue({ success: true, closedOnMarketplace: true });

    const result = await ListingUseCase.removeListing(ML_LISTING_ID);

    expect(result.success).toBe(true);
    expect(result.closedOnMarketplace).toBe(true);
    expect(ml).toHaveBeenCalledWith(ML_LISTING_ID);
    expect(shopee).not.toHaveBeenCalled();
  });

  it("delegates to removeShopeeListing for SHOPEE platform", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(shopeeListing);
    const ml = vi
      .spyOn(ListingUseCase, "removeMLListing")
      .mockResolvedValue({ success: true, closedOnMarketplace: true });
    const shopee = vi
      .spyOn(ListingUseCase, "removeShopeeListing")
      .mockResolvedValue({ success: true, closedOnMarketplace: true });

    const result = await ListingUseCase.removeListing(SHOPEE_LISTING_ID);

    expect(result.success).toBe(true);
    expect(shopee).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
    expect(ml).not.toHaveBeenCalled();
  });

  it("delegates to removeMagaluListing for MAGALU platform", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(magaluListing);
    const magalu = vi
      .spyOn(ListingUseCase, "removeMagaluListing")
      .mockResolvedValue({ success: true, closedOnMarketplace: true });

    const result = await ListingUseCase.removeListing(MAGALU_LISTING_ID);

    expect(result.success).toBe(true);
    expect(magalu).toHaveBeenCalledWith(MAGALU_LISTING_ID);
  });

  it("returns error when listing not found", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(null as any);
    const result = await ListingUseCase.removeListing("unknown");
    expect(result.success).toBe(false);
    expect(result.closedOnMarketplace).toBe(false);
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
    expect(result.closedOnMarketplace).toBe(false);
    expect(del).toHaveBeenCalledWith(SHOPEE_LISTING_ID);
    expect(ml).not.toHaveBeenCalled();
    expect(shopee).not.toHaveBeenCalled();
  });
});

// Unused re-import guard to keep ML service in the import graph for future tests
void MLApiService;

import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";

const makeMLListing = (overrides: Partial<{ status: string; externalListingId: string }> = {}) => ({
  id: "listing-1",
  productId: "prod-1",
  marketplaceAccountId: "acc-1",
  externalListingId: "MLB123",
  status: "active",
  product: { userId: "user-1" },
  marketplaceAccount: {
    id: "acc-1",
    platform: Platform.MERCADO_LIVRE,
    accessToken: "ml-token",
  },
  ...overrides,
});

const makeShopeeListing = (
  overrides: Partial<{
    status: string;
    externalListingId: string;
    accessToken: string | null;
    shopId: number | null;
  }> = {},
) => ({
  id: "listing-2",
  productId: "prod-1",
  marketplaceAccountId: "acc-2",
  externalListingId: overrides.externalListingId ?? "555111",
  status: overrides.status ?? "active",
  product: { userId: "user-1" },
  marketplaceAccount: {
    id: "acc-2",
    platform: Platform.SHOPEE,
    accessToken: overrides.accessToken !== undefined ? overrides.accessToken : "sh-token",
    shopId: overrides.shopId !== undefined ? overrides.shopId : 999,
  },
});

describe("ListingUseCase.updateListingStatus — idempotência", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna alreadyInState=true sem chamar API quando status atual já é o desejado", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeMLListing({ status: "paused" }) as any,
    );
    const spyMLUpdate = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);
    const spyRepoUpdate = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingStatus(
      "listing-1",
      "user-1",
      "paused",
    );

    expect(result).toEqual({ success: true, alreadyInState: true });
    expect(spyMLUpdate).not.toHaveBeenCalled();
    expect(spyRepoUpdate).not.toHaveBeenCalled();
  });

  it("normaliza casing do status persistido (ACTIVE no DB == active na request)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeMLListing({ status: "ACTIVE" }) as any,
    );
    const spyMLUpdate = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);

    const result = await ListingUseCase.updateListingStatus(
      "listing-1",
      "user-1",
      "active",
    );

    expect(result).toEqual({ success: true, alreadyInState: true });
    expect(spyMLUpdate).not.toHaveBeenCalled();
  });

  it("chama API e persiste quando status atual difere do desejado", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeMLListing({ status: "active" }) as any,
    );
    const spyMLUpdate = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);
    const spyRepoUpdate = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingStatus(
      "listing-1",
      "user-1",
      "paused",
    );

    expect(result).toEqual({ success: true });
    expect(spyMLUpdate).toHaveBeenCalledWith("ml-token", "MLB123", {
      status: "paused",
    });
    expect(spyRepoUpdate).toHaveBeenCalledWith("listing-1", "paused");
  });

  it("rejeita anuncios PENDING_ antes de tocar em qualquer plataforma", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeMLListing({ status: "active", externalListingId: "PENDING_xyz" }) as any,
    );
    const spyMLUpdate = vi.spyOn(MLApiService, "updateItem");

    const result = await ListingUseCase.updateListingStatus(
      "listing-1",
      "user-1",
      "paused",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ainda não foi publicado/);
    expect(spyMLUpdate).not.toHaveBeenCalled();
  });
});

describe("ListingUseCase.updateListingStatus — branch Shopee", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chama unlistItem com unlist=true quando status='paused' e persiste local", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeShopeeListing({ status: "active" }) as any,
    );
    const spyShopee = vi
      .spyOn(ShopeeApiService, "unlistItem")
      .mockResolvedValue({ failure_list: [] });
    const spyRepoUpdate = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingStatus(
      "listing-2",
      "user-1",
      "paused",
    );

    expect(result).toEqual({ success: true });
    expect(spyShopee).toHaveBeenCalledWith("sh-token", 999, [
      { itemId: 555111, unlist: true },
    ]);
    expect(spyRepoUpdate).toHaveBeenCalledWith("listing-2", "paused");
  });

  it("chama unlistItem com unlist=false quando status='active' (despausar)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeShopeeListing({ status: "paused" }) as any,
    );
    const spyShopee = vi
      .spyOn(ShopeeApiService, "unlistItem")
      .mockResolvedValue({ failure_list: [] });
    vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue(undefined as any);

    await ListingUseCase.updateListingStatus("listing-2", "user-1", "active");

    expect(spyShopee).toHaveBeenCalledWith("sh-token", 999, [
      { itemId: 555111, unlist: false },
    ]);
  });

  it("retorna falha com failed_reason quando Shopee rejeita o item", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeShopeeListing({ status: "active" }) as any,
    );
    vi.spyOn(ShopeeApiService, "unlistItem").mockResolvedValue({
      failure_list: [{ item_id: 555111, failed_reason: "item locked" }],
    });
    const spyRepoUpdate = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingStatus(
      "listing-2",
      "user-1",
      "paused",
    );

    expect(result).toEqual({ success: false, error: "item locked" });
    expect(spyRepoUpdate).not.toHaveBeenCalled();
  });

  it("retorna erro quando conta Shopee nao tem accessToken", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeShopeeListing({ status: "active", accessToken: null }) as any,
    );
    const spyShopee = vi.spyOn(ShopeeApiService, "unlistItem");

    const result = await ListingUseCase.updateListingStatus(
      "listing-2",
      "user-1",
      "paused",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/credenciais/);
    expect(spyShopee).not.toHaveBeenCalled();
  });

  it("retorna erro quando externalListingId Shopee nao eh numerico", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      makeShopeeListing({ status: "active", externalListingId: "ABC123" }) as any,
    );
    const spyShopee = vi.spyOn(ShopeeApiService, "unlistItem");

    const result = await ListingUseCase.updateListingStatus(
      "listing-2",
      "user-1",
      "paused",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inválido/);
    expect(spyShopee).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";

const makeMLListing = (overrides: Partial<{ status: string }> = {}) => ({
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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { OlxApiService } from "../../services/olx-api.service";

const USER_ID = "user-1";
const OLX_LISTING_ID = "listing-olx-1";

function baseOlxListing(overrides: Record<string, unknown> = {}) {
  return {
    id: OLX_LISTING_ID,
    externalListingId: "SKU-OLX-1",
    status: "active",
    product: { userId: USER_ID, name: "Farol", olxCategoryId: "2101" },
    marketplaceAccount: {
      id: "acc-olx-1",
      platform: Platform.OLX,
      accessToken: "tok-olx",
      olxSellerPhone: "11999998888",
      olxSellerZipcode: "01001000",
    },
    ...overrides,
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListingUseCase.updateListingStatus — OLX pause", () => {
  it("statusCode != 0 no deleteAd ⇒ falha e NÃO grava 'paused'", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const updateStatus = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);
    // A OLX devolve HTTP 200 com erro no corpo (statusCode -4).
    const deleteAd = vi
      .spyOn(OlxApiService, "deleteAd")
      .mockResolvedValue({ statusCode: -4, statusMessage: "sem permissão" } as any);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "paused",
    );

    expect(deleteAd).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OLX recusou/);
    // Crítico: sem persistir "paused" quando a OLX recusou (anúncio segue no ar).
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("statusCode 0 ⇒ sucesso e grava 'paused'", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const updateStatus = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);
    vi.spyOn(OlxApiService, "deleteAd").mockResolvedValue({
      statusCode: 0,
    } as any);

    const result = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "paused",
    );

    expect(result.success).toBe(true);
    expect(updateStatus).toHaveBeenCalledWith(OLX_LISTING_ID, "paused");
  });

  it("kill-switch OLX_INTEGRATION_DISABLED=1 ⇒ no-op: NÃO chama a API nem grava", async () => {
    const prev = process.env.OLX_INTEGRATION_DISABLED;
    process.env.OLX_INTEGRATION_DISABLED = "1";
    try {
      const listing = baseOlxListing();
      vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
      const updateStatus = vi
        .spyOn(ListingRepository, "updateStatus")
        .mockResolvedValue({} as any);
      const deleteAd = vi
        .spyOn(OlxApiService, "deleteAd")
        .mockResolvedValue({ statusCode: 0 } as any);

      const result = await ListingUseCase.updateListingStatus(
        OLX_LISTING_ID,
        USER_ID,
        "paused",
      );

      // Integração desativada não toca OLX nem o DB (auto-pause do PDV inclusive).
      expect(deleteAd).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OLX_INTEGRATION_DISABLED;
      else process.env.OLX_INTEGRATION_DISABLED = prev;
    }
  });
});

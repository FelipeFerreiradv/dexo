import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

vi.hoisted(() => {
  process.env.OLX_SELLER_PHONE = "21999998888";
  process.env.OLX_SELLER_ZIPCODE = "20000000";
});

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../services/olx-api.service", () => ({
  OlxApiService: {
    deleteAd: vi.fn().mockResolvedValue({ statusCode: 0 }),
    submitImport: vi.fn().mockResolvedValue({ statusCode: 0, token: "tk" }),
  },
}));

vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: { updateStatus: vi.fn().mockResolvedValue({}) },
}));

import prisma from "@/app/lib/prisma";
import { OlxApiService } from "../../services/olx-api.service";
import { ListingRepository } from "../../repositories/listing.repository";
import { SyncUseCase } from "../sync.usercase";

function productWith(stock: number) {
  return {
    id: "prod-1",
    name: "Farol Direito Gol 2012",
    sku: "SKU1",
    stock,
    price: 200,
    brand: "VW",
    model: "Gol",
    year: "2012",
    quality: "SUCATA",
    olxCategoryId: 555, // categoria explícita → resolve offline
    listings: [
      {
        id: "listing-1",
        externalListingId: "SKU1",
        externalSku: "SKU1",
        marketplaceAccount: {
          id: "acc-olx",
          platform: Platform.OLX,
          accessToken: "olx-token",
        },
      },
    ],
  };
}

describe("SyncUseCase.syncProductStock — plataforma OLX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (OlxApiService.deleteAd as any).mockResolvedValue({ statusCode: 0 });
    (OlxApiService.submitImport as any).mockResolvedValue({
      statusCode: 0,
      token: "tk",
    });
    (ListingRepository.updateStatus as any).mockResolvedValue({});
    (prisma as any).syncLog.create.mockResolvedValue({});
  });

  it("estoque 0 → deleteAd (despublica) e marca listing paused", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.deleteAd).toHaveBeenCalledWith("olx-token", "SKU1");
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(ListingRepository.updateStatus).toHaveBeenCalledWith(
      "listing-1",
      "paused",
    );
    expect(results[0].success).toBe(true);
  });

  it("estoque > 0 → submitImport insert (re-publica) e marca active", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(5));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
    const [token, adList] = (OlxApiService.submitImport as any).mock.calls[0];
    expect(token).toBe("olx-token");
    expect(adList[0].operation).toBe("insert");
    expect(adList[0].id).toBe("SKU1"); // mesmo id (idempotência da edição)
    expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
    expect(ListingRepository.updateStatus).toHaveBeenCalledWith(
      "listing-1",
      "active",
    );
    expect(results[0].success).toBe(true);
  });

  it("NÃO cai no default 'plataforma não suportada' (o case OLX existe)", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));
    const results = await SyncUseCase.syncProductStock("prod-1");
    expect(results[0].error).toBeUndefined();
  });
});

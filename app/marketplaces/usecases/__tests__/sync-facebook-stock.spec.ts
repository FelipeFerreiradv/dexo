import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../services/facebook-api.service", () => ({
  FacebookApiService: {
    setAvailability: vi.fn().mockResolvedValue({ handles: ["h1"] }),
    upsertItem: vi.fn().mockResolvedValue({ handles: ["h1"] }),
  },
}));

vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: { updateStatus: vi.fn().mockResolvedValue({}) },
}));

import prisma from "@/app/lib/prisma";
import { FacebookApiService } from "../../services/facebook-api.service";
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
    listings: [
      {
        id: "listing-1",
        externalListingId: "SKU1",
        externalSku: "SKU1",
        marketplaceAccount: {
          id: "acc-fb",
          platform: Platform.FACEBOOK,
          accessToken: "fb-token",
        },
      },
    ],
  };
}

describe("SyncUseCase.syncProductStock — plataforma FACEBOOK", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (FacebookApiService.setAvailability as any).mockResolvedValue({
      handles: ["h1"],
    });
    (ListingRepository.updateStatus as any).mockResolvedValue({});
    (prisma as any).syncLog.create.mockResolvedValue({});
  });

  it("estoque 0 → availability 'out of stock' (NÃO delete) e listing paused", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "fb-token",
      "SKU1",
      "out of stock",
      { quantity: 0 },
    );
    expect(ListingRepository.updateStatus).toHaveBeenCalledWith(
      "listing-1",
      "paused",
    );
    expect(results[0].success).toBe(true);
  });

  it("estoque > 0 → availability 'in stock' (+quantity) e listing active", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(5));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "fb-token",
      "SKU1",
      "in stock",
      { quantity: 5 },
    );
    expect(ListingRepository.updateStatus).toHaveBeenCalledWith(
      "listing-1",
      "active",
    );
    expect(results[0].success).toBe(true);
  });

  it("NÃO cai no default 'plataforma não suportada' (o case FACEBOOK existe)", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));
    const results = await SyncUseCase.syncProductStock("prod-1");
    expect(results[0].error).toBeUndefined();
  });
});

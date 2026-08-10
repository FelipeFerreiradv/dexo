import { beforeEach, describe, expect, it, vi } from "vitest";

// prisma: só as leituras que importFacebookItems faz (listings/produtos por
// chunk + syncLog do log final). findManyInChunks é REAL e chama estes mocks.
vi.mock("@/app/lib/prisma", () => ({
  default: {
    productListing: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../services/facebook-api.service", () => ({
  FacebookApiService: { listCatalogItems: vi.fn() },
}));

vi.mock("../../repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
  },
}));

vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: { updateListing: vi.fn().mockResolvedValue({}) },
}));

import prisma from "@/app/lib/prisma";
import { FacebookApiService } from "../../services/facebook-api.service";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { ListingRepository } from "../../repositories/listing.repository";
import { ListingAutodetectUseCase } from "../listing-autodetect.usercase";
import { SyncUseCase } from "../sync.usercase";

const ACCOUNT = {
  id: "acc-fb",
  userId: "user-1",
  accessToken: "fb-token",
  fbCatalogId: "cat-1",
};

describe("SyncUseCase.importFacebookItems — vínculo por SKU", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
    (prisma as any).syncLog.create.mockResolvedValue({});
    // Dublê só do núcleo de upsert; normalizeFacebookItem fica REAL (garante
    // retailer_id → externalListingId). spyOn mantém os demais estáticos.
    vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    ).mockResolvedValue({ action: "created_product", productId: "prod-new" });
  });

  it("item com retailer_id já vinculado é atualizado, NÃO recriado (sem upsert)", async () => {
    (FacebookApiService.listCatalogItems as any).mockResolvedValue([
      {
        id: "9001",
        retailer_id: "SKU1",
        name: "Farol",
        availability: "in stock",
        url: "https://fb.com/1",
      },
    ]);
    // Listing existente casa por externalListingId = SKU (mesma chave do create).
    (prisma as any).productListing.findMany.mockImplementation(
      async (args: any) => {
        if (args?.where?.externalListingId)
          return [
            {
              id: "listing-1",
              externalListingId: "SKU1",
              externalSku: "SKU1",
              status: "active",
              permalink: null,
              productId: "prod-1",
            },
          ];
        return [];
      },
    );
    (prisma as any).product.findMany.mockResolvedValue([]);

    const result = await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    expect(FacebookApiService.listCatalogItems).toHaveBeenCalledWith(
      "fb-token",
      { catalogId: "cat-1" },
    );
    expect(result.linkedItems).toBe(1);
    expect(
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem,
    ).not.toHaveBeenCalled();
    // permalink mudou (null → url) ⇒ write-on-change.
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "listing-1",
      expect.objectContaining({ permalink: "https://fb.com/1" }),
    );
  });

  it("item novo cai no núcleo idempotente (upsert por SKU)", async () => {
    (FacebookApiService.listCatalogItems as any).mockResolvedValue([
      { id: "9002", retailer_id: "SKU2", name: "Lanterna", availability: "in stock" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([]);
    (prisma as any).product.findMany.mockResolvedValue([]);
    (
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem as any
    ).mockResolvedValue({ action: "created_product", productId: "prod-new" });

    const result = await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    expect(
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem,
    ).toHaveBeenCalledTimes(1);
    // normalizeFacebookItem (real) precisa ter mapeado retailer_id → externalListingId.
    const arg = (
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem as any
    ).mock.calls[0][0];
    expect(arg.externalListingId).toBe("SKU2");
    expect(arg.rawSku).toBe("SKU2");
    expect(result.linkedItems).toBe(1);
  });

  it("preço '199.90 BRL' do catálogo Meta é parseado (não vira R$ 0)", async () => {
    // A Meta devolve price como "valor MOEDA": Number("199.90 BRL") = NaN, o que
    // fazia todo produto importado nascer com preço R$ 0.
    (FacebookApiService.listCatalogItems as any).mockResolvedValue([
      {
        id: "9003",
        retailer_id: "SKU3",
        name: "Farol",
        availability: "in stock",
        price: "199.90 BRL",
      },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([]);
    (prisma as any).product.findMany.mockResolvedValue([]);
    (
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem as any
    ).mockResolvedValue({ action: "created_product", productId: "prod-new" });

    await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    const arg = (
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem as any
    ).mock.calls[0][0];
    expect(arg.price).toBe(199.9);
  });

  it("catálogo vazio → resultado zerado, sem tocar o núcleo", async () => {
    (FacebookApiService.listCatalogItems as any).mockResolvedValue([]);

    const result = await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    expect(result.totalItems).toBe(0);
    expect(
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem,
    ).not.toHaveBeenCalled();
  });
});

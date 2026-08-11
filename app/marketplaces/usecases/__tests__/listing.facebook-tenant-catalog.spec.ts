import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// Prisma é lido via dynamic import dentro de updateFacebookListingFields (relê o
// vínculo p/ trazer overrides). Mocka o findUnique p/ devolver o listing base.
vi.mock("@/app/lib/prisma", () => ({
  default: {
    productListing: { findUnique: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { ProductRepositoryPrisma } from "@/app/repositories/product.repository";
import { FacebookApiService } from "../../services/facebook-api.service";

const SKU = "SKU-SHARED";

// Duas contas de tenants diferentes, MESMO SKU, catálogos Meta DISTINTOS.
function accountFor(tenant: "a" | "b") {
  return {
    id: `acc-fb-${tenant}`,
    platform: Platform.FACEBOOK,
    status: "ACTIVE",
    accessToken: `tok-${tenant}`,
    fbCatalogId: `catalog-${tenant}`,
    fbProductUrlBase: `https://fb.com/${tenant}`,
  } as any;
}

function productFor(tenant: "a" | "b") {
  return {
    id: `prod-${tenant}`,
    userId: `user-${tenant}`,
    sku: SKU,
    name: "Farol Direito",
    description: "desc",
    price: 200,
    stock: 5,
    imageUrl: "https://img/1.jpg",
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  (prisma as any).productListing.findUnique.mockReset();
});

describe("Facebook multi-tenant — mesmo SKU, catálogos distintos", () => {
  beforeEach(() => {
    vi.spyOn(ListingRepository, "upsertListing").mockResolvedValue({
      id: "listing-x",
    } as any);
  });

  it("dois tenants publicam no MESMO SKU em catálogos Meta DISTINTOS", async () => {
    const upsertItem = vi
      .spyOn(FacebookApiService, "upsertItem")
      .mockResolvedValue({ handles: [] } as any);
    // productRepository é uma instância estática privada — spia o método no
    // protótipo (a instância compartilha o método).
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById")
      .mockResolvedValueOnce(productFor("a"))
      .mockResolvedValueOnce(productFor("b"));

    vi.spyOn(MarketplaceRepository, "findByIdAndUser")
      .mockResolvedValueOnce(accountFor("a"))
      .mockResolvedValueOnce(accountFor("b"));

    await ListingUseCase.createFacebookListing(
      "user-a",
      "prod-a",
      undefined,
      "acc-fb-a",
    );
    await ListingUseCase.createFacebookListing(
      "user-b",
      "prod-b",
      undefined,
      "acc-fb-b",
    );

    expect(upsertItem).toHaveBeenCalledTimes(2);
    const [, retailerA, , optsA] = upsertItem.mock.calls[0] ?? [];
    const [, retailerB, , optsB] = upsertItem.mock.calls[1] ?? [];
    // Mesmo retailer_id (SKU) …
    expect(retailerA).toBe(retailerB);
    // … mas catálogos DISTINTOS (sem isso os dois tenants se sobrescreveriam).
    expect((optsA as any)?.catalogId).toBe("catalog-a");
    expect((optsB as any)?.catalogId).toBe("catalog-b");
    expect((optsA as any)?.catalogId).not.toBe((optsB as any)?.catalogId);
  });
});

describe("Facebook remove — DELETE endereçado ao catálogo da conta", () => {
  const listing = {
    id: "listing-fb-1",
    externalListingId: SKU,
    marketplaceAccountId: "acc-fb-a",
  } as any;

  it("desvincular usa o catálogo da CONTA (não o global do .env)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "deleteListing").mockResolvedValue({} as any);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-fb-a",
      accessToken: "tok-a",
      fbCatalogId: "catalog-a",
    } as any);
    const deleteItem = vi
      .spyOn(FacebookApiService, "deleteItem")
      .mockResolvedValue({ handles: [] } as any);

    const res = await ListingUseCase.removeFacebookListing("listing-fb-1");

    expect(res.success).toBe(true);
    // Crítico: sem o catalogId da conta, o DELETE (retailer_id=SKU) apagaria o
    // item de OUTRO tenant que tivesse o mesmo SKU no catálogo global.
    expect(deleteItem).toHaveBeenCalledWith("tok-a", SKU, {
      catalogId: "catalog-a",
    });
  });

  it("conta sem fbCatalogId ⇒ bloqueia (não chama deleteItem)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-fb-a",
      accessToken: "tok-a",
      fbCatalogId: null,
    } as any);
    const deleteItem = vi
      .spyOn(FacebookApiService, "deleteItem")
      .mockResolvedValue({ handles: [] } as any);

    const res = await ListingUseCase.removeFacebookListing("listing-fb-1");

    expect(res.success).toBe(false);
    expect(deleteItem).not.toHaveBeenCalled();
  });
});

describe("Facebook pause — falha em item rejeitado no batch", () => {
  it("pause com item rejeitado no poll ⇒ falha e NÃO grava 'paused'", async () => {
    const listing = {
      id: "listing-fb-1",
      externalListingId: SKU,
      status: "active",
      product: { userId: "user-a", stock: 5 },
      marketplaceAccount: {
        id: "acc-fb-a",
        platform: Platform.FACEBOOK,
        accessToken: "tok-a",
        fbCatalogId: "catalog-a",
      },
    } as any;
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const updateStatus = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);
    vi.spyOn(FacebookApiService, "setAvailability").mockResolvedValue({
      handles: ["h1"],
    } as any);
    // Poll devolve o item rejeitado (status "error").
    vi.spyOn(FacebookApiService, "pollBatchUntilDone").mockResolvedValue({
      handle: "h1",
      status: "error",
      errors: [{ message: "invalid_item" }],
    } as any);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ListingUseCase.updateListingStatus(
      "listing-fb-1",
      "user-a",
      "paused",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Facebook recusou/);
    // Crítico: não persiste "paused" quando a Meta recusou a alteração.
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

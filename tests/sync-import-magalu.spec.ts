import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { MagaluApiService } from "@/app/marketplaces/services/magalu-api.service";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { normalizeSku } from "@/app/lib/sku";

const account = {
  id: "acc-mg",
  accessToken: "tok",
  userId: "u1",
} as any;

beforeEach(() => {
  vi.spyOn(
    MarketplaceRepository,
    "findByIdAndUser",
  ).mockResolvedValue(account);
  vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  vi.spyOn(prisma.product, "findMany").mockResolvedValue([] as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncUseCase.importMagaluItems — dedup do placeholder PENDING_", () => {
  it("faz UPGRADE do placeholder PENDING_<sku> em vez de criar duplicata", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([
      {
        sku: "SKU-MG",
        status: "PUBLISHED",
        title: "Farol",
        url: "http://magalu/x",
      },
    ] as any);
    // Vínculo local existente é o placeholder do create (POST 202 sem id real).
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
      {
        id: "l1",
        externalListingId: "PENDING_SKU-MG",
        externalSku: "SKU-MG",
        productId: "p1",
        status: "active",
        permalink: null,
      },
    ] as any);
    const update = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    const create = vi
      .spyOn(ListingRepository, "createListing")
      .mockResolvedValue({ id: "x" } as any);

    const result = await SyncUseCase.importMagaluItems("u1", "acc-mg");

    // NÃO duplica: reusa o placeholder e sobe o externalListingId p/ o id real.
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({
        externalListingId: "SKU-MG",
        status: "PUBLISHED",
        permalink: "http://magalu/x",
      }),
    );
    expect(result.totalItems).toBe(1);
    expect(result.linkedItems).toBe(1);
  });

  it("casa por id externo quando já há vínculo com o id real (sem upgrade/duplicata)", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([
      { sku: "SKU-MG", status: "active", url: "http://magalu/x" },
    ] as any);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
      {
        id: "l1",
        externalListingId: "SKU-MG",
        externalSku: "SKU-MG",
        productId: "p1",
        status: "active",
        permalink: "http://magalu/x",
      },
    ] as any);
    const update = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    const create = vi
      .spyOn(ListingRepository, "createListing")
      .mockResolvedValue({ id: "x" } as any);

    const result = await SyncUseCase.importMagaluItems("u1", "acc-mg");

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled(); // nada mudou
    expect(result.linkedItems).toBe(1);
  });

  it("cria o vínculo quando não há placeholder e o produto casa por SKU", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([
      { sku: "SKU-NEW", status: "active" },
    ] as any);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "p9", skuNormalized: normalizeSku("SKU-NEW") },
    ] as any);
    // Produto casado NÃO tem anúncio nesta conta → agrupamento legítimo (link).
    vi.spyOn(
      ListingRepository,
      "productHasListingInAccount",
    ).mockResolvedValue(false);
    const update = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    const create = vi
      .spyOn(ListingRepository, "createListing")
      .mockResolvedValue({ id: "new" } as any);
    // O vínculo passa pelo núcleo idempotente (rota única): ele casa o SKU pelo
    // cache do lote e vincula ao produto existente, sem criar produto novo.
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "new", productId: "p9" } as any);

    const result = await SyncUseCase.importMagaluItems("u1", "acc-mg");

    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p9",
        marketplaceAccountId: "acc-mg",
        externalListingId: "SKU-NEW",
        externalSku: "SKU-NEW",
      }),
    );
    expect(result.linkedItems).toBe(1);
  });
});

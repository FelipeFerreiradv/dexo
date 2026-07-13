import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

/**
 * Cobre a CAMADA de importação em massa (roteamento), não o núcleo de dedup em
 * si — este já é exercido por tests/listing-autodetect-core.test.ts (cenários
 * ii reimport idempotente, iii cross-marketplace, iv SKU pré-existente, vi sem
 * SKU). Aqui garantimos: (v) inativo ignorado; (i) ativo sem produto → roteado
 * pelo núcleo (cria); SKU casado → createListing (sem chamar o núcleo);
 * contadores aditivos coerentes; unlinkedItems → 0.
 */
const mlItem = (over: Record<string, unknown> = {}) =>
  ({
    id: "MLB000",
    title: "Peça",
    price: 100,
    available_quantity: 5,
    status: "active",
    permalink: "http://ml/x",
    thumbnail: "http://img/x.jpg",
    date_created: "2026-06-01T00:00:00Z",
    seller_custom_field: null,
    attributes: [],
    ...over,
  }) as any;

const account = {
  id: "acc1",
  userId: "u1",
  accessToken: "token",
  externalUserId: "seller1",
} as any;

describe("SyncUseCase.importMLItems — roteia anúncios ativos sem produto pelo núcleo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignora inativo, cria produto para ativo sem SKU-match e vincula SKU casado", async () => {
    vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
    ).mockResolvedValue(account);
    vi.spyOn(MLApiService, "getSellerItemIds").mockResolvedValue([
      "MLB1",
      "MLB2",
      "MLB3",
    ]);
    vi.spyOn(MLApiService, "getItemsDetails").mockResolvedValue([
      mlItem({ id: "MLB1", seller_custom_field: "MATCH-1", status: "active" }),
      mlItem({ id: "MLB2", seller_custom_field: "NEW-1", status: "active" }),
      mlItem({ id: "MLB3", seller_custom_field: "OFF-1", status: "paused" }),
    ]);

    // Nenhum listing pré-existente.
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);
    // Um produto pré-existente casa por SKU normalizado com MLB1.
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "p-match", sku: "MATCH-1", skuNormalized: "match-1" },
    ] as any);

    const createListing = vi
      .spyOn(ListingRepository, "createListing")
      .mockResolvedValue({ id: "l-match" } as any);
    // Produto casado NÃO tem anúncio nesta conta → agrupamento legítimo (link).
    vi.spyOn(
      ListingRepository,
      "productHasListingInAccount",
    ).mockResolvedValue(false);
    const core = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p-new" });
    vi.spyOn(SyncUseCase as any, "logSync").mockResolvedValue(undefined);

    const result = await SyncUseCase.importMLItems("u1");

    // (v) inativo (MLB3) filtrado → só 2 processados
    expect(result.totalItems).toBe(2);
    // SKU casado → createListing 1x, para MLB1
    expect(createListing).toHaveBeenCalledTimes(1);
    expect(createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p-match",
        externalListingId: "MLB1",
      }),
    );
    // (i) ativo sem produto (MLB2) → roteado pelo núcleo 1x, NÃO para o casado
    expect(core).toHaveBeenCalledTimes(1);
    expect(core).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: Platform.MERCADO_LIVRE,
        externalListingId: "MLB2",
        rawSku: "NEW-1",
        account: expect.objectContaining({ id: "acc1", userId: "u1" }),
      }),
      // Cache write-through do lote (preloads do import passados ao núcleo).
      expect.objectContaining({
        productsBySku: expect.any(Map),
        productIdsWithListing: expect.any(Set),
        knownExternalListingIds: expect.any(Set),
      }),
    );
    // contadores: 1 criado, 2 vinculados (casado + criado), 0 não vinculados
    expect(result.createdProducts).toBe(1);
    expect(result.linkedItems).toBe(2);
    expect(result.unlinkedItems).toBe(0);
  });

  it("anúncio ativo SEM SKU também é roteado pelo núcleo (autoSku)", async () => {
    vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
    ).mockResolvedValue(account);
    vi.spyOn(MLApiService, "getSellerItemIds").mockResolvedValue(["MLB9"]);
    vi.spyOn(MLApiService, "getItemsDetails").mockResolvedValue([
      mlItem({ id: "MLB9", seller_custom_field: null, attributes: [] }),
    ]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([] as any);
    const core = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p-auto" });
    vi.spyOn(SyncUseCase as any, "logSync").mockResolvedValue(undefined);

    const result = await SyncUseCase.importMLItems("u1");

    expect(core).toHaveBeenCalledTimes(1);
    expect(core).toHaveBeenCalledWith(
      expect.objectContaining({ externalListingId: "MLB9", rawSku: null }),
      expect.anything(), // cache do lote
    );
    expect(result.createdProducts).toBe(1);
    expect(result.unlinkedItems).toBe(0);
  });
});

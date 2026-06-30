import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { MagaluApiService } from "@/app/marketplaces/services/magalu-api.service";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const BASELINE = new Date("2026-06-01T00:00:00Z");

const account = (over: Record<string, any> = {}) => ({
  id: "acc1",
  userId: "u1",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000), // futuro ⇒ sem refresh
  autoImportListingsSince: BASELINE,
  ...over,
});

const magaluSku = (over: Record<string, any> = {}) =>
  ({
    sku: "MG-1",
    title: "Farol Dianteiro",
    status: "PUBLISHED",
    available_quantity: 5,
    price: 120,
    created_at: "2026-06-10T00:00:00.000Z", // >= baseline
    images: [{ reference: "http://img/farol.jpeg", type: "image/jpeg" }],
    url_marketplace: [{ channel: "magalu", url: "http://magalu/farol" }],
    ...over,
  }) as any;

describe("ListingAutodetectUseCase.normalizeMagaluItem", () => {
  it("mapeia sku/título/preço/estoque/imagem/permalink/createdAt", () => {
    const n = ListingAutodetectUseCase.normalizeMagaluItem(
      { id: "acc1", userId: "u1" },
      magaluSku(),
    );
    expect(n.platform).toBe("MAGALU");
    expect(n.externalListingId).toBe("MG-1");
    expect(n.rawSku).toBe("MG-1");
    expect(n.title).toBe("Farol Dianteiro");
    expect(n.price).toBe(120);
    expect(n.stock).toBe(5);
    expect(n.status).toBe("PUBLISHED");
    expect(n.imageUrl).toBe("http://img/farol.jpeg");
    expect(n.permalink).toBe("http://magalu/farol");
    expect(n.createdAt.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("externalListingId = SKU do seller (NÃO o id interno) p/ casar o create", () => {
    const n = ListingAutodetectUseCase.normalizeMagaluItem(
      { id: "acc1", userId: "u1" },
      magaluSku({ id: "INTERNAL-9", sku: "MG-1" }),
    );
    // O create grava externalListingId = product.sku; o normalizer precisa bater.
    expect(n.externalListingId).toBe("MG-1");
  });

  it("preço/estoque ausentes caem em 0 (endpoints separados)", () => {
    const n = ListingAutodetectUseCase.normalizeMagaluItem(
      { id: "acc1", userId: "u1" },
      magaluSku({ price: undefined, available_quantity: undefined }),
    );
    expect(n.price).toBe(0);
    expect(n.stock).toBe(0);
  });
});

describe("SyncUseCase.importNewMagaluItemsForAccount", () => {
  beforeEach(() => {
    // Default: nenhum SKU já vinculado nesta conta (pré-filtro vazio).
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem baseline → retorna zeros e não chama a API (fail-safe)", async () => {
    const list = vi.spyOn(MagaluApiService, "listSkus");

    const r = await SyncUseCase.importNewMagaluItemsForAccount(
      account({ autoImportListingsSince: null }),
    );

    expect(r).toEqual({ created: 0, linked: 0, skipped: 0, errors: 0 });
    expect(list).not.toHaveBeenCalled();
  });

  it("SKU novo (created_at >= baseline) → cria produto via núcleo", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([magaluSku()]);
    const upsert = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p1" });

    const r = await SyncUseCase.importNewMagaluItemsForAccount(account());

    expect(r.created).toBe(1);
    expect(r.skipped).toBe(0);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "MAGALU",
        externalListingId: "MG-1",
        rawSku: "MG-1",
        stock: 5,
        price: 120,
      }),
    );
  });

  it("SKU antigo (created_at < baseline) → ignora (skipped), não cria", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([
      magaluSku({ created_at: "2026-05-01T00:00:00.000Z" }),
    ]);
    const upsert = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const r = await SyncUseCase.importNewMagaluItemsForAccount(account());

    expect(r.skipped).toBe(1);
    expect(r.created).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("SKU já vinculado por externalSku (Dexo/legado) → pré-filtro pula sem duplicar", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([magaluSku()]);
    // Já existe um vínculo p/ o SKU MG-1 nesta conta (ex.: criado pelo Dexo, ou
    // placeholder legado PENDING_MG-1) → não chama o núcleo, não duplica.
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
      { externalSku: "MG-1" },
    ] as any);
    const upsert = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const r = await SyncUseCase.importNewMagaluItemsForAccount(account());

    expect(upsert).not.toHaveBeenCalled();
    expect(r).toEqual({ created: 0, linked: 0, skipped: 0, errors: 0 });
  });

  it("reexecução: núcleo devolve listing_exists → não duplica", async () => {
    vi.spyOn(MagaluApiService, "listSkus").mockResolvedValue([magaluSku()]);
    vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    ).mockResolvedValue({ action: "listing_exists", productId: "p1" });

    const r = await SyncUseCase.importNewMagaluItemsForAccount(account());

    expect(r).toEqual({ created: 0, linked: 0, skipped: 0, errors: 0 });
  });
});

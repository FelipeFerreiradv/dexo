import { describe, it, expect, vi, afterEach } from "vitest";

import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const BASELINE = new Date("2026-06-01T00:00:00Z");
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const account = (over: Record<string, any> = {}) => ({
  id: "acc1",
  userId: "u1",
  shopId: 999,
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000),
  autoImportListingsSince: BASELINE,
  shopeeListingsSyncedThrough: null,
  ...over,
});

const shopeeItem = (over: Record<string, any> = {}) => ({
  item_id: 111,
  item_name: "Parachoque Dianteiro",
  item_sku: "SHP-1",
  create_time: sec("2026-06-10T00:00:00Z"), // >= baseline
  update_time: sec("2026-06-15T00:00:00Z"),
  price_info: [{ current_price: 50, original_price: 60 }],
  stock_info: [{ stock_quantity: 7 }],
  image: { image_url_list: ["http://img/s.jpg"], image_id_list: [] },
  status: "NORMAL",
  ...over,
});

function mockOnePage(items: any[]) {
  vi.spyOn(ShopeeApiService, "getItemList").mockResolvedValue({
    item: items.map((i) => ({
      item_id: i.item_id,
      update_time: i.update_time,
    })),
    total_count: items.length,
    has_next_page: false,
    next_offset: 0,
  } as any);
}

describe("SyncUseCase.importNewShopeeItemsForAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem baseline → retorna zeros e não chama a API (fail-safe)", async () => {
    const getList = vi.spyOn(ShopeeApiService, "getItemList");

    const r = await SyncUseCase.importNewShopeeItemsForAccount(
      account({ autoImportListingsSince: null }),
    );

    expect(r).toEqual({ created: 0, linked: 0, skipped: 0, errors: 0 });
    expect(getList).not.toHaveBeenCalled();
  });

  it("item novo (create_time >= baseline) → cria produto via núcleo", async () => {
    mockOnePage([shopeeItem()]);
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      shopeeItem(),
    ] as any);
    vi.spyOn(
      MarketplaceRepository,
      "advanceShopeeListingsWatermark",
    ).mockResolvedValue({} as any);
    const upsert = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p1" });

    const r = await SyncUseCase.importNewShopeeItemsForAccount(account());

    expect(r.created).toBe(1);
    expect(r.skipped).toBe(0);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "SHOPEE",
        externalListingId: "111",
        rawSku: "SHP-1",
        stock: 7,
        price: 50,
      }),
    );
  });

  it("item antigo (create_time < baseline) → ignora (skipped), não cria", async () => {
    const old = shopeeItem({ create_time: sec("2026-05-01T00:00:00Z") });
    mockOnePage([old]);
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      old,
    ] as any);
    vi.spyOn(
      MarketplaceRepository,
      "advanceShopeeListingsWatermark",
    ).mockResolvedValue({} as any);
    const upsert = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const r = await SyncUseCase.importNewShopeeItemsForAccount(account());

    expect(r.skipped).toBe(1);
    expect(r.created).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("avança o watermark para o maior update_time processado", async () => {
    mockOnePage([shopeeItem()]);
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      shopeeItem(),
    ] as any);
    vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    ).mockResolvedValue({ action: "created_product", productId: "p1" });
    const advance = vi
      .spyOn(MarketplaceRepository, "advanceShopeeListingsWatermark")
      .mockResolvedValue({} as any);

    await SyncUseCase.importNewShopeeItemsForAccount(account());

    expect(advance).toHaveBeenCalledWith(
      "acc1",
      new Date(sec("2026-06-15T00:00:00Z") * 1000),
    );
  });

  it("reexecução: anúncio já vinculado (listing_exists) → não duplica (created/linked = 0)", async () => {
    mockOnePage([shopeeItem()]);
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      shopeeItem(),
    ] as any);
    vi.spyOn(
      MarketplaceRepository,
      "advanceShopeeListingsWatermark",
    ).mockResolvedValue({} as any);
    vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    ).mockResolvedValue({ action: "listing_exists", productId: "p1" });

    const r = await SyncUseCase.importNewShopeeItemsForAccount(account());

    expect(r).toEqual({ created: 0, linked: 0, skipped: 0, errors: 0 });
  });
});

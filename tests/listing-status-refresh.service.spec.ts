import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "@/app/marketplaces/services/ml-oauth.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import {
  ListingStatusRefreshService,
  type RefreshableListingRow,
} from "@/app/marketplaces/services/listing-status-refresh.service";

const FUTURE = new Date(Date.now() + 3_600_000); // longe de expirar → sem refresh

const mlAccount = (over: Record<string, any> = {}) => ({
  id: "acc-ml",
  platform: "MERCADO_LIVRE",
  status: "ACTIVE",
  accessToken: "tok-ml",
  refreshToken: "ref-ml",
  expiresAt: FUTURE,
  shopId: null,
  ...over,
});

const shopeeAccount = (over: Record<string, any> = {}) => ({
  id: "acc-shp",
  platform: "SHOPEE",
  status: "ACTIVE",
  accessToken: "tok-shp",
  refreshToken: "ref-shp",
  expiresAt: FUTURE,
  shopId: 999,
  ...over,
});

const row = (over: Record<string, any> = {}): RefreshableListingRow =>
  ({
    id: "lst-1",
    status: "active",
    externalListingId: "MLB1",
    marketplaceAccount: mlAccount(),
    ...over,
  }) as RefreshableListingRow;

describe("ListingStatusRefreshService.refreshRowsBestEffort", () => {
  beforeEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "0";
  });

  afterEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1"; // default da suíte
    vi.restoreAllMocks();
  });

  it("kill-switch ligado → Map vazio, zero chamadas de API", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    const getItems = vi.spyOn(MLApiService, "getItemsDetails");

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row(),
    ]);

    expect(changed.size).toBe(0);
    expect(getItems).not.toHaveBeenCalled();
  });

  it("ML: só os que mudaram entram no Map; token válido não refresca", async () => {
    vi.spyOn(MLApiService, "getItemsDetails").mockResolvedValue([
      { id: "MLB1", status: "paused" },
      { id: "MLB2", status: "active" },
    ] as any);
    const refresh = vi.spyOn(MLOAuthService, "refreshAccessTokenForAccount");
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({ updatedAt: new Date("2026-07-22T12:00:00Z") } as any);

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row({ id: "lst-1", externalListingId: "MLB1", status: "active" }),
      row({ id: "lst-2", externalListingId: "MLB2", status: "active" }),
    ]);

    expect(refresh).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("lst-1", "paused");
    expect(changed.get("lst-1")).toMatchObject({ status: "paused" });
    expect(changed.has("lst-2")).toBe(false);
  });

  it("ML: item ausente no multiget (deletado) → não escreve nada", async () => {
    vi.spyOn(MLApiService, "getItemsDetails").mockResolvedValue([] as any);
    const update = vi.spyOn(ListingRepository, "updateStatus");

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row(),
    ]);

    expect(update).not.toHaveBeenCalled();
    expect(changed.size).toBe(0);
  });

  it("Shopee: item_status UNLIST → grava unlist (externalListingId com model id)", async () => {
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      { item_id: 111, item_status: "UNLIST" },
    ] as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({ updatedAt: new Date() } as any);

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row({
        id: "lst-s",
        externalListingId: "111:222",
        status: "active",
        marketplaceAccount: shopeeAccount(),
      }),
    ]);

    expect(update).toHaveBeenCalledWith("lst-s", "unlist");
    expect(changed.get("lst-s")).toMatchObject({ status: "unlist" });
  });

  it("erro numa conta não derruba as outras", async () => {
    vi.spyOn(MLApiService, "getItemsDetails").mockRejectedValue(
      new Error("ml down"),
    );
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      { item_id: 111, item_status: "BANNED" },
    ] as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({ updatedAt: new Date() } as any);

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row(),
      row({
        id: "lst-s",
        externalListingId: "111",
        status: "active",
        marketplaceAccount: shopeeAccount(),
      }),
    ]);

    expect(update).toHaveBeenCalledWith("lst-s", "banned");
    expect(changed.size).toBe(1);
  });

  it("filtra PENDING_, conta inativa, sem token e Magalu — zero chamadas", async () => {
    const getMl = vi.spyOn(MLApiService, "getItemsDetails");
    const getShp = vi.spyOn(ShopeeApiService, "getItemsBaseInfo");

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row({ externalListingId: "PENDING_123" }),
      row({ marketplaceAccount: mlAccount({ status: "ERROR" }) }),
      row({ marketplaceAccount: mlAccount({ accessToken: null }) }),
      row({
        marketplaceAccount: mlAccount({ platform: "MAGALU", id: "acc-mag" }),
      }),
      row({ marketplaceAccount: null }),
    ]);

    expect(getMl).not.toHaveBeenCalled();
    expect(getShp).not.toHaveBeenCalled();
    expect(changed.size).toBe(0);
  });

  it("falha ao gravar uma row não impede as demais da mesma conta", async () => {
    vi.spyOn(MLApiService, "getItemsDetails").mockResolvedValue([
      { id: "MLB1", status: "paused" },
      { id: "MLB2", status: "closed" },
    ] as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ updatedAt: new Date() } as any);

    const changed = await ListingStatusRefreshService.refreshRowsBestEffort([
      row({ id: "lst-1", externalListingId: "MLB1", status: "active" }),
      row({ id: "lst-2", externalListingId: "MLB2", status: "active" }),
    ]);

    expect(update).toHaveBeenCalledTimes(2);
    expect(changed.has("lst-1")).toBe(false);
    expect(changed.get("lst-2")).toMatchObject({ status: "closed" });
  });
});

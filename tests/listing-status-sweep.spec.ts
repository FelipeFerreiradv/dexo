import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { ListingStatusSweepService } from "@/app/marketplaces/services/listing-status-sweep.service";
import { ListingStatusRefreshService } from "@/app/marketplaces/services/listing-status-refresh.service";

const account = (over: Record<string, any> = {}) => ({
  id: "acc-ml",
  platform: "MERCADO_LIVRE",
  status: "ACTIVE",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000),
  shopId: null,
  ...over,
});

const listingRows = (count: number, prefix = "lst") =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(3, "0")}`,
    status: "active",
    externalListingId: `MLB${i}`,
  }));

describe("ListingStatusSweepService.runOnce", () => {
  beforeEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "0";
    (ListingStatusSweepService as any).cursors = new Map();
  });

  afterEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1"; // default da suíte
    vi.restoreAllMocks();
  });

  it("kill-switch ligado → nem consulta o banco", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    const findAccounts = vi.spyOn(prisma.marketplaceAccount, "findMany");

    await ListingStatusSweepService.runOnce();

    expect(findAccounts).not.toHaveBeenCalled();
  });

  it("processa uma página por conta, anexa a conta às rows e delega ao refresh", async () => {
    vi.spyOn(prisma.marketplaceAccount, "findMany").mockResolvedValue([
      account(),
    ] as any);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue(
      listingRows(2) as any,
    );
    const refresh = vi
      .spyOn(ListingStatusRefreshService, "refreshRowsBestEffort")
      .mockResolvedValue(new Map());

    await ListingStatusSweepService.runOnce();

    expect(refresh).toHaveBeenCalledTimes(1);
    const rows = refresh.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "lst-000",
      marketplaceAccount: { id: "acc-ml", platform: "MERCADO_LIVRE" },
    });
    // Página incompleta (<100) → rotação completa, cursor limpo.
    expect((ListingStatusSweepService as any).cursors.has("acc-ml")).toBe(
      false,
    );
  });

  it("página cheia avança o cursor; rodada seguinte pagina a partir dele", async () => {
    vi.spyOn(prisma.marketplaceAccount, "findMany").mockResolvedValue([
      account(),
    ] as any);
    const findListings = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValueOnce(listingRows(100) as any)
      .mockResolvedValueOnce(listingRows(1, "lst2") as any);
    vi.spyOn(
      ListingStatusRefreshService,
      "refreshRowsBestEffort",
    ).mockResolvedValue(new Map());

    await ListingStatusSweepService.runOnce();
    expect((ListingStatusSweepService as any).cursors.get("acc-ml")).toBe(
      "lst-099",
    );

    await ListingStatusSweepService.runOnce();
    const secondWhere = findListings.mock.calls[1][0]?.where as any;
    expect(secondWhere.id).toEqual({ gt: "lst-099" });
    expect((ListingStatusSweepService as any).cursors.has("acc-ml")).toBe(
      false,
    );
  });

  it("falha numa conta não derruba as demais", async () => {
    vi.spyOn(prisma.marketplaceAccount, "findMany").mockResolvedValue([
      account({ id: "acc-1" }),
      account({ id: "acc-2" }),
    ] as any);
    vi.spyOn(prisma.productListing, "findMany")
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(listingRows(1) as any);
    const refresh = vi
      .spyOn(ListingStatusRefreshService, "refreshRowsBestEffort")
      .mockResolvedValue(new Map());

    await expect(ListingStatusSweepService.runOnce()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("exclui placeholders PENDING_ no where", async () => {
    vi.spyOn(prisma.marketplaceAccount, "findMany").mockResolvedValue([
      account(),
    ] as any);
    const findListings = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await ListingStatusSweepService.runOnce();

    const where = findListings.mock.calls[0][0]?.where as any;
    expect(where.NOT).toEqual({
      externalListingId: { startsWith: "PENDING_" },
    });
  });
});

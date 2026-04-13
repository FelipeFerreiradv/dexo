import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => {
  const stockSyncJob = { upsert: vi.fn() };
  const mock: any = {
    stockLog: { findMany: vi.fn() },
    productListing: { findMany: vi.fn() },
    stockSyncJob,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation(async (cb: any) => cb(mock));
  return { default: mock };
});

import prisma from "@/app/lib/prisma";
import { StockReconciliationService } from "@/app/marketplaces/services/stock-reconciliation.service";

const makeListingRow = (overrides: Partial<any> = {}) => ({
  id: "lst-1",
  productId: "prod-1",
  marketplaceAccountId: "acc-1",
  product: { stock: 5 },
  marketplaceAccount: { platform: "SHOPEE", status: "ACTIVE" },
  ...overrides,
});

describe("StockReconciliationService.runOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma as any).$transaction.mockImplementation(async (cb: any) =>
      cb(prisma),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("não enfileira nada quando não há StockLog recente", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([]);

    await StockReconciliationService.runOnce();

    expect((prisma as any).productListing.findMany).not.toHaveBeenCalled();
    expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
  });

  it("enfileira um upsert por listing ativo dos produtos com drift", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
      { productId: "prod-2" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({
        id: "lst-ml",
        productId: "prod-1",
        marketplaceAccountId: "acc-ml",
        product: { stock: 4 },
        marketplaceAccount: { platform: "MERCADO_LIVRE", status: "ACTIVE" },
      }),
      makeListingRow({
        id: "lst-shp",
        productId: "prod-1",
        marketplaceAccountId: "acc-shp",
        product: { stock: 4 },
        marketplaceAccount: { platform: "SHOPEE", status: "ACTIVE" },
      }),
      makeListingRow({
        id: "lst-2",
        productId: "prod-2",
        marketplaceAccountId: "acc-ml",
        product: { stock: 7 },
        marketplaceAccount: { platform: "MERCADO_LIVRE", status: "ACTIVE" },
      }),
    ]);
    (prisma as any).stockSyncJob.upsert.mockResolvedValue({});

    await StockReconciliationService.runOnce();

    expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(3);
    const calls = (prisma as any).stockSyncJob.upsert.mock.calls.map(
      (c: any[]) => c[0],
    );
    const listingIds = calls.map(
      (c: any) => c.where.listingId_status.listingId,
    );
    expect(listingIds).toEqual(
      expect.arrayContaining(["lst-ml", "lst-shp", "lst-2"]),
    );
    for (const call of calls) {
      expect(call.where.listingId_status.status).toBe("PENDING");
      expect(call.create.status).toBe("PENDING");
    }
  });

  it("ignora listings cuja marketplaceAccount não está ACTIVE", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({
        id: "lst-inactive",
        marketplaceAccount: { platform: "SHOPEE", status: "REVOKED" },
      }),
    ]);

    await StockReconciliationService.runOnce();

    expect((prisma as any).stockSyncJob.upsert).not.toHaveBeenCalled();
  });

  it("busca apenas listings com status de sincronização válida", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([]);

    await StockReconciliationService.runOnce();

    const where = (prisma as any).productListing.findMany.mock.calls[0][0]
      .where;
    expect(where.productId).toEqual({ in: ["prod-1"] });
    expect(where.status.in).toEqual(
      expect.arrayContaining(["ACTIVE", "active", "paused", "PAUSED"]),
    );
  });

  it("propaga targetStock = estoque atual do produto para o upsert", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({ product: { stock: 12 } }),
    ]);

    await StockReconciliationService.runOnce();

    const call = (prisma as any).stockSyncJob.upsert.mock.calls[0][0];
    expect(call.create.targetStock).toBe(12);
    expect(call.update.targetStock).toBe(12);
  });

  it("não derruba o loop quando um upsert falha", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([
      { productId: "prod-1" },
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      makeListingRow({ id: "lst-broken" }),
      makeListingRow({ id: "lst-ok", marketplaceAccountId: "acc-2" }),
    ]);
    (prisma as any).stockSyncJob.upsert
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce({});

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(StockReconciliationService.runOnce()).resolves.toBeUndefined();

    expect((prisma as any).stockSyncJob.upsert).toHaveBeenCalledTimes(2);
    expect(consoleErr).toHaveBeenCalledWith(
      expect.stringContaining("upsert failed for listing lst-broken"),
      expect.any(Error),
    );
  });

  it("usa janela de 1h baseada em createdAt ao buscar StockLog", async () => {
    (prisma as any).stockLog.findMany.mockResolvedValue([]);

    const before = Date.now();
    await StockReconciliationService.runOnce();
    const after = Date.now();

    const call = (prisma as any).stockLog.findMany.mock.calls[0][0];
    const since = call.where.createdAt.gte.getTime();
    expect(since).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5);
    expect(since).toBeLessThanOrEqual(after - 60 * 60 * 1000 + 5);
    expect(call.distinct).toEqual(["productId"]);
  });
});

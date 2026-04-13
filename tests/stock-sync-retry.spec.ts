import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => ({
  default: {
    stockSyncJob: {
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    productListing: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/app/marketplaces/usecases/sync.usercase", () => ({
  SyncUseCase: {
    syncProductStock: vi.fn(),
  },
}));

vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { SystemLogService } from "@/app/services/system-log.service";
import { StockSyncRetryService } from "@/app/marketplaces/services/stock-sync-retry.service";

const makeJob = (overrides: Partial<any> = {}) => ({
  id: "job-1",
  productId: "prod-1",
  listingId: "lst-1",
  platform: "SHOPEE",
  targetStock: 5,
  attempts: 0,
  status: "PENDING",
  ...overrides,
});

describe("StockSyncRetryService.runOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deleta o job quando syncProductStock retorna success", async () => {
    (prisma as any).stockSyncJob.findMany.mockResolvedValue([makeJob()]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: true,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "SHOPEE",
      },
    ]);

    await StockSyncRetryService.runOnce();

    expect((prisma as any).stockSyncJob.delete).toHaveBeenCalledWith({
      where: { id: "job-1" },
    });
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
  });

  it("incrementa attempts e aplica backoff em falha transitória", async () => {
    (prisma as any).stockSyncJob.findMany.mockResolvedValue([
      makeJob({ attempts: 1 }),
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: false,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "SHOPEE",
        error: "timeout",
      },
    ]);

    await StockSyncRetryService.runOnce();

    const call = (prisma as any).stockSyncJob.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(call.data.attempts).toBe(2);
    expect(call.data.lastError).toBe("timeout");
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
  });

  it("deleta o job e dispara logError em erro terminal (token revoked)", async () => {
    (prisma as any).stockSyncJob.findMany.mockResolvedValue([makeJob()]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: false,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "SHOPEE",
        error: "invalid_token: token revoked",
      },
    ]);

    await StockSyncRetryService.runOnce();

    expect((prisma as any).stockSyncJob.delete).toHaveBeenCalledWith({
      where: { id: "job-1" },
    });
    expect(SystemLogService.logError).toHaveBeenCalledWith(
      "STOCK_SYNC_FAILED",
      expect.stringContaining("lst-1"),
      expect.objectContaining({
        resource: "ProductListing",
        resourceId: "lst-1",
      }),
    );
  });

  it("agrupa jobs por productId e chama syncProductStock uma vez por produto", async () => {
    (prisma as any).stockSyncJob.findMany.mockResolvedValue([
      makeJob({ id: "job-a", listingId: "lst-a" }),
      makeJob({ id: "job-b", listingId: "lst-b" }),
      makeJob({ id: "job-c", productId: "prod-2", listingId: "lst-c" }),
    ]);
    (prisma as any).productListing.findMany.mockImplementation(
      ({ where }: any) =>
        Promise.resolve(
          where.id.in.map((id: string) => ({
            id,
            externalListingId: `ext-${id}`,
          })),
        ),
    );
    (SyncUseCase.syncProductStock as any).mockImplementation(
      (productId: string) =>
        Promise.resolve([
          {
            success: true,
            productId,
            externalListingId: `ext-lst-${productId === "prod-1" ? "a" : "c"}`,
            platform: "SHOPEE",
          },
          ...(productId === "prod-1"
            ? [
                {
                  success: true,
                  productId,
                  externalListingId: "ext-lst-b",
                  platform: "SHOPEE",
                },
              ]
            : []),
        ]),
    );

    await StockSyncRetryService.runOnce();

    expect(SyncUseCase.syncProductStock).toHaveBeenCalledTimes(2);
    expect(SyncUseCase.syncProductStock).toHaveBeenCalledWith("prod-1");
    expect(SyncUseCase.syncProductStock).toHaveBeenCalledWith("prod-2");
  });

  it("retorna cedo quando não há jobs pendentes", async () => {
    (prisma as any).stockSyncJob.findMany.mockResolvedValue([]);

    await StockSyncRetryService.runOnce();

    expect(SyncUseCase.syncProductStock).not.toHaveBeenCalled();
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
  });
});

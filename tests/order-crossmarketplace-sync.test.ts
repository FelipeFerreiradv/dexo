import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

type MockTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  product: { update: ReturnType<typeof vi.fn> };
  stockLog: { create: ReturnType<typeof vi.fn> };
  productListing: { findMany: ReturnType<typeof vi.fn> };
  stockSyncJob: { upsert: ReturnType<typeof vi.fn> };
};

const buildTx = (
  products: Record<string, { id: string; name: string; stock: number }>,
  listingsByProduct: Record<string, any[]> = {},
): MockTx => ({
  $queryRaw: vi.fn().mockImplementation((_s: any, productId: string) => {
    const p = products[productId];
    return Promise.resolve(p ? [p] : []);
  }),
  product: { update: vi.fn().mockResolvedValue({}) },
  stockLog: { create: vi.fn().mockResolvedValue({}) },
  productListing: {
    findMany: vi
      .fn()
      .mockImplementation(({ where }: any) =>
        Promise.resolve(listingsByProduct[where.productId] ?? []),
      ),
  },
  stockSyncJob: { upsert: vi.fn().mockResolvedValue({}) },
});

describe("OrderUseCase cross-marketplace stock sync (enqueue-based)", () => {
  beforeEach(() => {
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
    vi.spyOn(SystemLogService, "logWarning").mockResolvedValue(undefined as any);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enfileira jobs Shopee e Mercado Livre após pedido Shopee", async () => {
    const tx = buildTx(
      { "prod-1": { id: "prod-1", name: "Produto 1", stock: 5 } },
      {
        "prod-1": [
          { id: "lst-ml-1", marketplaceAccount: { platform: "MERCADO_LIVRE" } },
          { id: "lst-shp-1", marketplaceAccount: { platform: "SHOPEE" } },
        ],
      },
    );
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );

    await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-shp-1",
        marketplaceAccount: { platform: "SHOPEE" },
        items: [{ productId: "prod-1", quantity: 1, unitPrice: 100 }],
      },
      "Importação Shopee",
    );

    expect(tx.stockSyncJob.upsert).toHaveBeenCalledTimes(2);
    const calls = tx.stockSyncJob.upsert.mock.calls.map(
      (c: any[]) => c[0].create,
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          listingId: "lst-ml-1",
          platform: "MERCADO_LIVRE",
          targetStock: 4,
          orderId: "order-shp-1",
        }),
        expect.objectContaining({
          listingId: "lst-shp-1",
          platform: "SHOPEE",
          targetStock: 4,
        }),
      ]),
    );
  });

  it("enfileira job Shopee após pedido Mercado Livre", async () => {
    const tx = buildTx(
      { "prod-2": { id: "prod-2", name: "Produto 2", stock: 3 } },
      {
        "prod-2": [
          { id: "lst-shp-2", marketplaceAccount: { platform: "SHOPEE" } },
        ],
      },
    );
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );

    await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-ml-2",
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
        items: [{ productId: "prod-2", quantity: 1, unitPrice: 100 }],
      },
      "Venda ML #2",
    );

    expect(tx.stockSyncJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          listingId_status: { listingId: "lst-shp-2", status: "PENDING" },
        },
        create: expect.objectContaining({
          platform: "SHOPEE",
          targetStock: 2,
        }),
      }),
    );
  });

  it("registra oversell quando quantidade pedida excede estoque", async () => {
    const tx = buildTx(
      { "prod-3": { id: "prod-3", name: "Produto 3", stock: 1 } },
      {
        "prod-3": [
          { id: "lst-3", marketplaceAccount: { platform: "SHOPEE" } },
        ],
      },
    );
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const oversellLog = vi
      .spyOn(SystemLogService, "logWarning")
      .mockResolvedValue(undefined as any);

    const deductions = await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-partial-3",
        marketplaceAccount: { platform: "SHOPEE" },
        items: [{ productId: "prod-3", quantity: 3, unitPrice: 100 }],
      },
      "Importação Shopee",
    );

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "prod-3" },
      data: { stock: 0 },
    });
    expect(deductions).toEqual([
      {
        productId: "prod-3",
        productName: "Produto 3",
        previousStock: 1,
        newStock: 0,
        quantity: 3,
      },
    ]);
    expect(oversellLog).toHaveBeenCalledWith(
      "OVERSELL_DETECTED",
      expect.stringContaining("order-partial-3"),
      expect.objectContaining({
        resource: "Order",
        resourceId: "order-partial-3",
        details: expect.objectContaining({
          orderId: "order-partial-3",
          platform: "SHOPEE",
        }),
      }),
    );
  });
});

describe("OrderUseCase fallback SKU normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("faz fallback case-insensitive e cria ProductListing para Mercado Livre", async () => {
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    const findFirstSpy = vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "prod-abc",
      sku: "ABC-001",
      skuNormalized: "abc-001",
      userId: "user-1",
    } as any);
    const fallbackListing = { id: "listing-abc-1" };
    const upsertSpy = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue(fallbackListing as any);

    const mapped = await (OrderUseCase as any).mapOrderItems(
      [
        {
          quantity: 1,
          unit_price: 99,
          item: {
            id: "ml-listing-abc",
            seller_custom_field: "abc-001",
            seller_sku: null,
          },
        },
      ],
      "user-1",
      "acc-ml-1",
    );

    expect(findFirstSpy).toHaveBeenCalledWith({
      where: {
        skuNormalized: "abc-001",
        userId: "user-1",
      },
    });
    expect(upsertSpy).toHaveBeenCalledWith({
      productId: "prod-abc",
      marketplaceAccountId: "acc-ml-1",
      externalListingId: "ml-listing-abc",
      externalSku: "abc-001",
      status: "active",
    });
    expect(mapped).toEqual({
      items: [
        {
          productId: "prod-abc",
          listingId: "listing-abc-1",
          quantity: 1,
          unitPrice: 99,
        },
      ],
      linkedCount: 1,
    });
  });

  it("usa upsert no fallback para manter ProductListing idempotente", async () => {
    const upsertSpy = vi.spyOn(prisma.productListing, "upsert").mockResolvedValue({
      id: "listing-stable-1",
      externalListingId: "external-1",
    } as any);

    const first = await ListingRepository.upsertFromOrderFallback({
      productId: "prod-1",
      marketplaceAccountId: "acc-1",
      externalListingId: "external-1",
      externalSku: "ABC-001",
      status: "active",
    });
    const second = await ListingRepository.upsertFromOrderFallback({
      productId: "prod-1",
      marketplaceAccountId: "acc-1",
      externalListingId: "external-1",
      externalSku: "ABC-001",
      status: "active",
    });

    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(upsertSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          marketplaceAccountId_externalListingId: {
            marketplaceAccountId: "acc-1",
            externalListingId: "external-1",
          },
        },
        update: {},
      }),
    );
    expect(first?.id).toBe("listing-stable-1");
    expect(second?.id).toBe("listing-stable-1");
  });
});

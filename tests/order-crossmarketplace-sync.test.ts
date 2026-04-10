import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

describe("OrderUseCase cross-marketplace stock sync", () => {
  beforeEach(() => {
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
    vi.spyOn(SystemLogService, "logWarning").mockResolvedValue(undefined as any);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sincroniza Shopee e Mercado Livre apos pedido Shopee", async () => {
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-1", name: "Produto 1", stock: 5 },
    ] as any);
    vi.spyOn(prisma.product, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.stockLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    vi.spyOn(prisma.product, "findUnique").mockResolvedValue({
      id: "prod-1",
      name: "Produto 1",
      stock: 4,
      listings: [
        {
          externalListingId: "ml-1",
          marketplaceAccount: {
            id: "acc-ml-1",
            platform: "MERCADO_LIVRE",
            accessToken: "ml-token",
          },
        },
        {
          externalListingId: "9001:1",
          marketplaceAccount: {
            id: "acc-shp-1",
            platform: "SHOPEE",
            accessToken: "shp-token",
            refreshToken: "refresh",
            shopId: 321,
          },
        },
      ],
    } as any);
    const mlGetSpy = vi
      .spyOn(MLApiService, "getItemDetails")
      .mockResolvedValue({ available_quantity: 5 } as any);
    const mlUpdateSpy = vi
      .spyOn(MLApiService, "updateItemStock")
      .mockResolvedValue(undefined as any);
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      stock_info_v2: {
        summary_info: {
          total_available_stock: 5,
        },
      },
    } as any);
    const shopeeUpdateSpy = vi
      .spyOn(ShopeeApiService, "updateItemStock")
      .mockResolvedValue(undefined as any);

    await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-shp-1",
        marketplaceAccountId: "acc-shp-1",
        externalOrderId: "SHP-1",
        status: "PAID",
        totalAmount: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        marketplaceAccount: {
          id: "acc-shp-1",
          platform: "SHOPEE",
          accountName: "Shopee",
        },
        items: [{ productId: "prod-1", quantity: 1, unitPrice: 100 }],
      },
      "Importação Shopee",
    );

    expect(mlGetSpy).toHaveBeenCalledWith("ml-token", "ml-1");
    expect(mlUpdateSpy).toHaveBeenCalledWith("ml-token", "ml-1", 4);
    expect(shopeeUpdateSpy).toHaveBeenCalledWith("shp-token", 321, 9001, 4);
  });

  it("sincroniza Shopee apos pedido Mercado Livre", async () => {
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-2", name: "Produto 2", stock: 3 },
    ] as any);
    vi.spyOn(prisma.product, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.stockLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    vi.spyOn(prisma.product, "findUnique").mockResolvedValue({
      id: "prod-2",
      name: "Produto 2",
      stock: 2,
      listings: [
        {
          externalListingId: "ml-2",
          marketplaceAccount: {
            id: "acc-ml-2",
            platform: "MERCADO_LIVRE",
            accessToken: "ml-token-2",
          },
        },
        {
          externalListingId: "9100:1",
          marketplaceAccount: {
            id: "acc-shp-2",
            platform: "SHOPEE",
            accessToken: "shp-token-2",
            refreshToken: "refresh-2",
            shopId: 654,
          },
        },
      ],
    } as any);
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      available_quantity: 3,
    } as any);
    vi.spyOn(MLApiService, "updateItemStock").mockResolvedValue(undefined as any);
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      stock_info_v2: {
        summary_info: {
          total_available_stock: 3,
        },
      },
    } as any);
    const shopeeUpdateSpy = vi
      .spyOn(ShopeeApiService, "updateItemStock")
      .mockResolvedValue(undefined as any);

    await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-ml-2",
        marketplaceAccountId: "acc-ml-2",
        externalOrderId: "ML-2",
        status: "PAID",
        totalAmount: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        marketplaceAccount: {
          id: "acc-ml-2",
          platform: "MERCADO_LIVRE",
          accountName: "ML",
        },
        items: [{ productId: "prod-2", quantity: 1, unitPrice: 100 }],
      },
      "Venda ML #2",
    );

    expect(shopeeUpdateSpy).toHaveBeenCalledWith("shp-token-2", 654, 9100, 2);
  });

  it("mantem baixa local e registra warning agregado em falha parcial", async () => {
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-3", name: "Produto 3", stock: 2 },
    ] as any);
    const updateSpy = vi.spyOn(prisma.product, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.stockLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    vi.spyOn(prisma.product, "findUnique").mockResolvedValue({
      id: "prod-3",
      name: "Produto 3",
      stock: 1,
      listings: [
        {
          externalListingId: "ml-3",
          marketplaceAccount: {
            id: "acc-ml-3",
            platform: "MERCADO_LIVRE",
            accessToken: "ml-token-3",
          },
        },
        {
          externalListingId: "9200:1",
          marketplaceAccount: {
            id: "acc-shp-3",
            platform: "SHOPEE",
            accessToken: "shp-token-3",
            refreshToken: "refresh-3",
            shopId: 999,
          },
        },
      ],
    } as any);
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      available_quantity: 2,
    } as any);
    vi.spyOn(MLApiService, "updateItemStock").mockRejectedValue(
      new Error("ml failure"),
    );
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      stock_info_v2: {
        summary_info: {
          total_available_stock: 2,
        },
      },
    } as any);
    const shopeeUpdateSpy = vi
      .spyOn(ShopeeApiService, "updateItemStock")
      .mockResolvedValue(undefined as any);
    const logWarningSpy = vi.spyOn(SystemLogService, "logWarning");

    const deductions = await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-partial-3",
        marketplaceAccountId: "acc-shp-3",
        externalOrderId: "SHP-3",
        status: "PAID",
        totalAmount: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        marketplaceAccount: {
          id: "acc-shp-3",
          platform: "SHOPEE",
          accountName: "Shopee",
        },
        items: [{ productId: "prod-3", quantity: 1, unitPrice: 100 }],
      },
      "Importação Shopee",
    );

    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "prod-3" },
      data: { stock: { decrement: 1 } },
    });
    expect(shopeeUpdateSpy).toHaveBeenCalledWith("shp-token-3", 999, 9200, 1);
    expect(deductions).toEqual([
      {
        productId: "prod-3",
        productName: "Produto 3",
        previousStock: 2,
        newStock: 1,
        quantity: 1,
      },
    ]);
    expect(logWarningSpy).toHaveBeenCalledWith(
      "SYNC_STOCK",
      expect.stringContaining("falhas parciais"),
      expect.objectContaining({
        details: expect.objectContaining({
          orderId: "order-partial-3",
          platform: "SHOPEE",
          totalListings: 2,
          successCount: 1,
          failureCount: 1,
          failedPlatforms: ["MERCADO_LIVRE"],
          productIds: ["prod-3"],
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

import { describe, it, expect, vi, afterEach } from "vitest";

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "@/app/marketplaces/services/ml-oauth.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

describe("OrderUseCase.getOrders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always requests items (includeItems=true) when listing orders", async () => {
    const mockResult = {
      orders: [],
      total: 0,
      page: 2,
      limit: 5,
      totalPages: 0,
    };

    const spy = vi
      .spyOn(orderRepository, "findAll")
      .mockResolvedValue(mockResult as any);

    const result = await OrderUseCase.getOrders("user-123", {
      status: "PAID",
      platform: "MERCADO_LIVRE",
      search: "cubo",
      page: 2,
      limit: 5,
    });

    expect(result).toBe(mockResult);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        status: "PAID",
        platform: "MERCADO_LIVRE",
        search: "cubo",
        page: 2,
        limit: 5,
        includeItems: true,
      }),
    );
  });
});

describe("OrderUseCase.importRecentOrders - multi-account ML", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("agrega resultados de todas as contas ativas do Mercado Livre", async () => {
    vi.spyOn(MarketplaceRepository, "findAllByUserIdAndPlatform").mockResolvedValue(
      [
        {
          id: "acc-ml-1",
          accessToken: "token-1",
          externalUserId: "seller-1",
        },
        {
          id: "acc-ml-2",
          accessToken: "token-2",
          externalUserId: "seller-2",
        },
      ] as any,
    );
    const importSpy = vi
      .spyOn(OrderUseCase, "importRecentOrdersForAccount")
      .mockResolvedValueOnce({
        totalOrders: 2,
        imported: 1,
        alreadyExists: 1,
        noProducts: 0,
        errors: 0,
        stockDeductions: 1,
        results: [],
      })
      .mockResolvedValueOnce({
        totalOrders: 3,
        imported: 2,
        alreadyExists: 0,
        noProducts: 1,
        errors: 0,
        stockDeductions: 2,
        results: [],
      });

    const result = await OrderUseCase.importRecentOrders("user-1", 7, true);

    expect(importSpy).toHaveBeenCalledTimes(2);
    expect(importSpy).toHaveBeenNthCalledWith(1, "acc-ml-1", 7, true);
    expect(importSpy).toHaveBeenNthCalledWith(2, "acc-ml-2", 7, true);
    expect(result).toMatchObject({
      totalOrders: 5,
      imported: 3,
      alreadyExists: 1,
      noProducts: 1,
      errors: 0,
      stockDeductions: 3,
    });
  });
});

describe("OrderUseCase.processOrder - Mercado Livre", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("faz fallback por SKU usando o userId da conta ML", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    const fallbackListing = { id: "listing-fallback-ml-1" };
    const findFirstSpy = vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "prod-1",
      sku: "ML-SKU-1",
      skuNormalized: "ml-sku-1",
      userId: "user-ml-1",
    } as any);
    const upsertFallbackSpy = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue(fallbackListing as any);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-ml-sku",
      items: [
        {
          productId: "prod-1",
          quantity: 1,
          unitPrice: 250,
          listingId: fallbackListing.id,
        },
      ],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    const result = await (OrderUseCase as any).processOrder(
      {
        id: 321,
        status: "paid",
        total_amount: 250,
        buyer: {
          first_name: "Ana",
          last_name: "Silva",
          nickname: "ana.silva",
        },
        order_items: [
          {
            quantity: 1,
            unit_price: 250,
            item: {
              id: "ml-listing-1",
              seller_custom_field: "ML-SKU-1",
              seller_sku: null,
            },
          },
        ],
      },
      "acc-ml-1",
      true,
      undefined,
      "user-ml-1",
    );

    expect(findFirstSpy).toHaveBeenCalledWith({
      where: {
        skuNormalized: "ml-sku-1",
        userId: "user-ml-1",
      },
    });
    expect(upsertFallbackSpy).toHaveBeenCalledWith({
      productId: "prod-1",
      marketplaceAccountId: "acc-ml-1",
      externalListingId: "ml-listing-1",
      externalSku: "ML-SKU-1",
      status: "active",
    });
    expect(result).toMatchObject({
      success: true,
      externalOrderId: "321",
      stockDeducted: true,
    });
  });

  it("mantém a baixa de estoque para pedidos pagos do ML", async () => {
    const mappedItems = [
      {
        productId: "prod-ml-1",
        quantity: 1,
        unitPrice: 250,
        listingId: null,
      },
    ];

    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(OrderUseCase as any, "mapOrderItems").mockResolvedValue({
      items: mappedItems,
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-ml-1",
      items: mappedItems,
    } as any);
    const deductSpy = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const result = await (OrderUseCase as any).processOrder(
      {
        id: 12345,
        status: "paid",
        total_amount: 250,
        buyer: {
          first_name: "Ana",
          last_name: "Silva",
          nickname: "ana.silva",
        },
        order_items: [{}],
      },
      "acc-ml-1",
      true,
    );

    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplaceAccountId: "acc-ml-1",
        externalOrderId: "12345",
        status: "PAID",
      }),
    );
    expect(deductSpy).toHaveBeenCalledTimes(1);
    expect(deductSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "order-ml-1" }),
      "Venda ML #12345",
    );
    expect(result).toMatchObject({
      success: true,
      externalOrderId: "12345",
      stockDeducted: true,
    });
  });

  it("não baixa estoque no ML quando o status bruto não é paid", async () => {
    const mappedItems = [
      {
        productId: "prod-ml-1",
        quantity: 1,
        unitPrice: 250,
        listingId: null,
      },
    ];

    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(OrderUseCase as any, "mapOrderItems").mockResolvedValue({
      items: mappedItems,
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-ml-2",
      items: mappedItems,
    } as any);
    const deductSpy = vi.spyOn(OrderUseCase as any, "deductStockForOrder");

    const result = await (OrderUseCase as any).processOrder(
      {
        id: 67890,
        status: "shipped",
        total_amount: 250,
        buyer: {
          first_name: "Ana",
          last_name: "Silva",
          nickname: "ana.silva",
        },
        order_items: [{}],
      },
      "acc-ml-1",
      true,
    );

    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        externalOrderId: "67890",
        status: "SHIPPED",
      }),
    );
    expect(deductSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      externalOrderId: "67890",
      stockDeducted: false,
    });
  });
});

describe("OrderUseCase.importRecentOrdersForAccount - Mercado Livre auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renova token ML e repete a importação quando recebe invalid access token", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-ml-1",
      userId: "user-ml-1",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      externalUserId: "seller-1",
    } as any);
    vi.spyOn(MLApiService, "getRecentOrders")
      .mockRejectedValueOnce(new Error("invalid access token"))
      .mockResolvedValueOnce([]);
    const refreshSpy = vi
      .spyOn(MLOAuthService, "refreshAccessToken")
      .mockResolvedValue({
        accessToken: "new-token",
        refreshToken: "new-refresh-token",
        expiresIn: 3600,
      });
    const updateTokensSpy = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValue({} as any);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);

    const result = await OrderUseCase.importRecentOrdersForAccount(
      "acc-ml-1",
      7,
      true,
    );

    expect(refreshSpy).toHaveBeenCalledWith("refresh-token");
    expect(updateTokensSpy).toHaveBeenCalledWith(
      "acc-ml-1",
      expect.objectContaining({
        accessToken: "new-token",
        refreshToken: "new-refresh-token",
        expiresAt: expect.any(Date),
      }),
    );
    expect(MLApiService.getRecentOrders).toHaveBeenNthCalledWith(
      2,
      "new-token",
      "seller-1",
      7,
      "paid",
    );
    expect(result).toMatchObject({
      totalOrders: 0,
      imported: 0,
      errors: 0,
    });
  });
});

describe("OrderUseCase.deductStockForOrder - durable enqueue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enfileira StockSyncJob dentro da transação para cada listing do produto", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([
        { id: "prod-1", name: "Produto teste", stock: 2 },
      ]),
      product: { update: vi.fn().mockResolvedValue({}) },
      stockLog: { create: vi.fn().mockResolvedValue({}) },
      productListing: {
        findMany: vi.fn().mockResolvedValue([
          { id: "lst-ml", marketplaceAccount: { platform: "MERCADO_LIVRE" } },
          { id: "lst-shp", marketplaceAccount: { platform: "SHOPEE" } },
        ]),
      },
      stockSyncJob: { upsert: vi.fn().mockResolvedValue({}) },
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(mockTx),
    );

    await (OrderUseCase as any).deductStockForOrder(
      {
        id: "order-partial-1",
        marketplaceAccount: { platform: "SHOPEE" },
        items: [{ productId: "prod-1", quantity: 1, unitPrice: 100 }],
      },
      "Importação Shopee",
    );

    expect(mockTx.stockSyncJob.upsert).toHaveBeenCalledTimes(2);
    expect(mockTx.stockSyncJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          listingId_status: { listingId: "lst-ml", status: "PENDING" },
        },
        create: expect.objectContaining({
          productId: "prod-1",
          targetStock: 1,
          orderId: "order-partial-1",
        }),
        update: expect.objectContaining({
          targetStock: 1,
          attempts: 0,
          lastError: null,
        }),
      }),
    );
  });
});

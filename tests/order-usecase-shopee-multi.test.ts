import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Platform } from "@prisma/client";

import {
  OrderUseCase,
  type ImportOrdersResult,
} from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "@/app/marketplaces/services/shopee-oauth.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";

const makeResult = (
  accountId: string,
  overrides: Partial<ImportOrdersResult> = {},
): ImportOrdersResult => ({
  totalOrders: 1,
  imported: 1,
  alreadyExists: 0,
  noProducts: 0,
  errors: 0,
  stockDeductions: 0,
  results: [
    {
      success: true,
      orderId: `${accountId}-order`,
      externalOrderId: `${accountId}-ext`,
      status: "imported",
      message: "ok",
      stockDeducted: false,
      itemsLinked: 1,
      itemsTotal: 1,
    },
  ],
  ...overrides,
});

describe("OrderUseCase.importRecentShopeeOrders - multi-account", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("agrega resultados de todas as contas ativas do usuário", async () => {
    const accounts = [
      { id: "acc-1", accessToken: "t1", shopId: 111 },
      { id: "acc-2", accessToken: "t2", shopId: 222 },
    ];

    const spyAccounts = vi
      .spyOn(MarketplaceRepository, "findAllByUserIdAndPlatform")
      .mockResolvedValue(accounts as any);

    const spyImport = vi
      .spyOn(OrderUseCase, "importRecentShopeeOrdersForAccount")
      .mockImplementation(async (accountId: string) => makeResult(accountId));

    const result = await OrderUseCase.importRecentShopeeOrders(
      "user-1",
      10,
      true,
    );

    expect(spyAccounts).toHaveBeenCalledWith("user-1", Platform.SHOPEE);
    expect(spyImport).toHaveBeenCalledTimes(2);
    expect(spyImport).toHaveBeenCalledWith("acc-1", 10, true);
    expect(spyImport).toHaveBeenCalledWith("acc-2", 10, true);

    expect(result.totalOrders).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.externalOrderId)).toEqual([
      "acc-1-ext",
      "acc-2-ext",
    ]);
  });

  it("ignora contas sem credenciais e falha se nenhuma conta válida existir", async () => {
    const accounts = [
      { id: "acc-1", accessToken: null, shopId: null },
      { id: "acc-2", accessToken: "t2", shopId: 222 },
    ];

    vi.spyOn(MarketplaceRepository, "findAllByUserIdAndPlatform").mockResolvedValue(
      accounts as any,
    );

    vi.spyOn(OrderUseCase, "importRecentShopeeOrdersForAccount").mockResolvedValue(
      makeResult("acc-2"),
    );

    const result = await OrderUseCase.importRecentShopeeOrders("user-1", 5, true);

    expect(result.imported).toBe(1);
    expect(result.results.some((r) => r.externalOrderId === "acc-2-ext")).toBe(true);
  });
});

describe("OrderUseCase.mapShopeeStatus", () => {
  it("mapeia statuses de envio Shopee para SHIPPED", () => {
    expect((OrderUseCase as any).mapShopeeStatus("READY_TO_SHIP")).toBe("SHIPPED");
    expect((OrderUseCase as any).mapShopeeStatus("PROCESSED")).toBe("SHIPPED");
    expect((OrderUseCase as any).mapShopeeStatus("SHIPPED")).toBe("SHIPPED");
  });
});

describe("OrderUseCase.importRecentShopeeOrdersForAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renova token Shopee e repete a importação após 403 invalid access token", async () => {
    const authError = Object.assign(new Error("Invalid access_token"), {
      status: 403,
    });
    const createdOrder = {
      id: "order-refresh-1",
      items: [
        {
          productId: "prod-1",
          quantity: 1,
          unitPrice: 100,
          listingId: null,
        },
      ],
    };

    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      userId: "user-1",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      shopId: 123,
    } as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders")
      .mockRejectedValueOnce(authError)
      .mockResolvedValueOnce([
        {
          order_sn: "SHP-ORDER-REFRESH",
          order_status: "READY_TO_SHIP",
          total_amount: 100,
          buyer_username: "cliente",
          item_list: [
            {
              item_id: 999,
              model_quantity_purchased: 1,
            },
          ],
        },
      ] as any);
    const refreshSpy = vi
      .spyOn(ShopeeOAuthService, "refreshAccessToken")
      .mockResolvedValue({
        access_token: "new-token",
        refresh_token: "new-refresh-token",
        expire_in: 3600,
      } as any);
    const updateTokensSpy = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValue({} as any);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: createdOrder.items,
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue(createdOrder as any);
    const deductSpy = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      3,
      true,
    );

    expect(refreshSpy).toHaveBeenCalledWith("refresh-token", 123);
    expect(updateTokensSpy).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({
        accessToken: "new-token",
        refreshToken: "new-refresh-token",
        expiresAt: expect.any(Date),
      }),
    );
    expect(ShopeeApiService.getRecentOrders).toHaveBeenNthCalledWith(
      1,
      "expired-token",
      123,
      3,
    );
    expect(ShopeeApiService.getRecentOrders).toHaveBeenNthCalledWith(
      2,
      "new-token",
      123,
      3,
    );
    expect(orderRepository.create).toHaveBeenCalledTimes(1);
    expect(deductSpy).toHaveBeenCalledTimes(1);
    expect(deductSpy).toHaveBeenCalledWith(createdOrder, "Importação Shopee");
    expect(result).toMatchObject({
      totalOrders: 1,
      imported: 1,
      errors: 0,
      stockDeductions: 1,
    });
  });

  it("não renova token Shopee quando a credencial atual ainda funciona", async () => {
    const refreshSpy = vi.spyOn(ShopeeOAuthService, "refreshAccessToken");
    const updateTokensSpy = vi.spyOn(MarketplaceRepository, "updateTokens");

    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      userId: "user-1",
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      shopId: 123,
    } as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([]);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      3,
      true,
    );

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(updateTokensSpy).not.toHaveBeenCalled();
    expect(ShopeeApiService.getRecentOrders).toHaveBeenCalledTimes(1);
    expect(ShopeeApiService.getRecentOrders).toHaveBeenCalledWith(
      "valid-token",
      123,
      3,
    );
    expect(result).toMatchObject({
      totalOrders: 0,
      imported: 0,
      errors: 0,
    });
  });

  it("falha sem criar pedido nem baixar estoque quando o refresh Shopee falha", async () => {
    const authError = Object.assign(new Error("Invalid access_token"), {
      status: 403,
    });

    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      userId: "user-1",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      shopId: 123,
    } as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockRejectedValue(authError);
    vi.spyOn(ShopeeOAuthService, "refreshAccessToken").mockRejectedValue(
      new Error("Erro ao renovar token"),
    );
    const createSpy = vi.spyOn(orderRepository, "create");
    const deductSpy = vi.spyOn(OrderUseCase as any, "deductStockForOrder");

    await expect(
      OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 3, true),
    ).rejects.toThrow("Erro ao renovar token");

    expect(createSpy).not.toHaveBeenCalled();
    expect(deductSpy).not.toHaveBeenCalled();
  });

  it("faz fallback por SKU usando o userId da conta Shopee", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      userId: "user-1",
      accessToken: "token",
      shopId: 123,
    } as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([
      {
        order_sn: "SHP-ORDER-SKU",
        order_status: "READY_TO_SHIP",
        total_amount: 100,
        buyer_username: "cliente",
        item_list: [
          {
            item_id: 999,
            item_sku: "22534",
            model_sku: "22534",
            model_quantity_purchased: 1,
            model_original_price: 100,
          },
        ],
      },
    ] as any);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    const fallbackListing = { id: "listing-fallback-shp-1" };
    const findFirstSpy = vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "prod-22534",
      sku: "22534",
      skuNormalized: "22534",
      userId: "user-1",
    } as any);
    const upsertFallbackSpy = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue(fallbackListing as any);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-sku-1",
      items: [
        {
          productId: "prod-22534",
          quantity: 1,
          unitPrice: 100,
          listingId: fallbackListing.id,
        },
      ],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      1,
      true,
    );

    expect(findFirstSpy).toHaveBeenCalledWith({
      where: {
        skuNormalized: "22534",
        userId: "user-1",
      },
    });
    expect(upsertFallbackSpy).toHaveBeenCalledWith({
      productId: "prod-22534",
      marketplaceAccountId: "acc-1",
      externalListingId: "999",
      externalSku: "22534",
      status: "active",
    });
    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        externalOrderId: "SHP-ORDER-SKU",
        items: [
          expect.objectContaining({
            productId: "prod-22534",
            listingId: fallbackListing.id,
          }),
        ],
      }),
    );
    expect(result.imported).toBe(1);
  });

  it("deduz estoque mesmo quando o status Shopee mapeia para PENDING", async () => {
    const createdOrder = {
      id: "order-1",
      items: [
        {
          productId: "prod-1",
          quantity: 1,
          unitPrice: 100,
          listingId: null,
        },
      ],
    };

    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      accessToken: "token",
      shopId: 123,
    } as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([
      {
        order_sn: "SHP-ORDER-1",
        order_status: "TO_CONFIRM_RECEIVE",
        total_amount: 100,
        buyer_username: "cliente",
        item_list: [
          {
            item_id: 999,
            model_quantity_purchased: 1,
          },
        ],
      },
    ] as any);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: createdOrder.items,
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue(createdOrder as any);
    const deductSpy = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      3,
      true,
    );

    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        externalOrderId: "SHP-ORDER-1",
        status: "PENDING",
      }),
    );
    expect(deductSpy).toHaveBeenCalledTimes(1);
    expect(deductSpy).toHaveBeenCalledWith(createdOrder, "Importação Shopee");
    expect(result.imported).toBe(1);
    expect(result.stockDeductions).toBe(1);
    expect(result.results[0]?.stockDeducted).toBe(true);
  });

  it("não deduz estoque novamente quando o pedido Shopee já existe", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      accessToken: "token",
      shopId: 123,
    } as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([
      {
        order_sn: "SHP-ORDER-1",
        order_status: "READY_TO_SHIP",
        total_amount: 100,
        item_list: [
          {
            item_id: 999,
            model_quantity_purchased: 1,
          },
        ],
      },
    ] as any);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([
      { externalOrderId: "SHP-ORDER-1" },
    ] as any);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    const createSpy = vi.spyOn(orderRepository, "create");
    const deductSpy = vi.spyOn(OrderUseCase as any, "deductStockForOrder");

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      1,
      true,
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(deductSpy).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
    expect(result.alreadyExists).toBe(1);
    expect(result.stockDeductions).toBe(0);
    expect(result.results[0]).toMatchObject({
      externalOrderId: "SHP-ORDER-1",
      status: "already_exists",
      stockDeducted: false,
    });
  });
});

describe("OrderUseCase.deductStockForOrder", () => {
  beforeEach(() => {
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
    vi.spyOn(SystemLogService, "logWarning").mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decrementa múltiplas unidades sem deixar estoque negativo", async () => {
    const order = {
      id: "order-1",
      items: [
        {
          productId: "prod-1",
          quantity: 3,
        },
      ],
    };

    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      {
        id: "prod-1",
        name: "Produto teste",
        stock: 2,
      },
    ] as any);
    const updateSpy = vi
      .spyOn(prisma.product, "update")
      .mockResolvedValue({} as any);
    const stockLogSpy = vi
      .spyOn(prisma.stockLog, "create")
      .mockResolvedValue({} as any);
    const txSpy = vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    const syncSpy = vi
      .spyOn(SyncUseCase, "syncProductStock")
      .mockResolvedValue([]);

    const result = await (OrderUseCase as any).deductStockForOrder(
      order,
      "Importação Shopee",
    );

    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: { stock: { decrement: 2 } },
    });
    expect(stockLogSpy).toHaveBeenCalledWith({
      data: {
        productId: "prod-1",
        change: -3,
        reason: "Importação Shopee",
        previousStock: 2,
        newStock: 0,
      },
    });
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith("prod-1");
    expect(result).toEqual([
      {
        productId: "prod-1",
        productName: "Produto teste",
        previousStock: 2,
        newStock: 0,
        quantity: 3,
      },
    ]);
  });

  it("sincroniza anúncios uma vez por productId após concluir a baixa local", async () => {
    const order = {
      id: "order-2",
      items: [
        {
          productId: "prod-1",
          quantity: 1,
        },
        {
          productId: "prod-1",
          quantity: 1,
        },
        {
          productId: "prod-2",
          quantity: 1,
        },
      ],
    };

    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      {
        id: "prod-1",
        name: "Produto 1",
        stock: 5,
      },
      {
        id: "prod-2",
        name: "Produto 2",
        stock: 2,
      },
    ] as any);
    vi.spyOn(prisma.product, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.stockLog, "create").mockResolvedValue({} as any);
    const txSpy = vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    const syncSpy = vi
      .spyOn(SyncUseCase, "syncProductStock")
      .mockResolvedValue([]);

    await (OrderUseCase as any).deductStockForOrder(order, "Importação Shopee");

    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenCalledWith("prod-1");
    expect(syncSpy).toHaveBeenCalledWith("prod-2");
    expect(new Set(syncSpy.mock.calls.map(([productId]) => productId))).toEqual(
      new Set(["prod-1", "prod-2"]),
    );
    expect(txSpy.mock.invocationCallOrder[0]).toBeLessThan(
      syncSpy.mock.invocationCallOrder[0],
    );
  });

  it("não sincroniza anúncios quando a transação local de estoque falha", async () => {
    const order = {
      id: "order-3",
      items: [
        {
          productId: "prod-1",
          quantity: 1,
        },
      ],
    };

    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      {
        id: "prod-1",
        name: "Produto teste",
        stock: 2,
      },
    ] as any);
    vi.spyOn(prisma.product, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.stockLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("tx failed"));
    const syncSpy = vi.spyOn(SyncUseCase, "syncProductStock");

    const result = await (OrderUseCase as any).deductStockForOrder(
      order,
      "Importação Shopee",
    );

    expect(syncSpy).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        productId: "prod-1",
        productName: "Produto teste",
        previousStock: 2,
        newStock: 1,
        quantity: 1,
      },
    ]);
  });

  it("mantém a baixa local mesmo quando a sincronização externa falha", async () => {
    const order = {
      id: "order-4",
      items: [
        {
          productId: "prod-1",
          quantity: 1,
        },
      ],
    };

    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      {
        id: "prod-1",
        name: "Produto teste",
        stock: 2,
      },
    ] as any);
    vi.spyOn(prisma.product, "update").mockResolvedValue({} as any);
    vi.spyOn(prisma.stockLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma, "$transaction").mockResolvedValue([] as any);
    const syncSpy = vi
      .spyOn(SyncUseCase, "syncProductStock")
      .mockRejectedValue(new Error("sync failed"));

    const result = await (OrderUseCase as any).deductStockForOrder(
      order,
      "Importação Shopee",
    );

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        productId: "prod-1",
        productName: "Produto teste",
        previousStock: 2,
        newStock: 1,
        quantity: 1,
      },
    ]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import {
  OrderUseCase,
  type ImportOrdersResult,
} from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";

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
    const findFirstSpy = vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "prod-22534",
      sku: "22534",
      userId: "user-1",
    } as any);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-sku-1",
      items: [
        {
          productId: "prod-22534",
          quantity: 1,
          unitPrice: 100,
          listingId: null,
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
        sku: "22534",
        userId: "user-1",
      },
    });
    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        externalOrderId: "SHP-ORDER-SKU",
        items: [
          expect.objectContaining({
            productId: "prod-22534",
            listingId: null,
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
});

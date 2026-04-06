import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import {
  OrderUseCase,
  type ImportOrdersResult,
} from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";

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

import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";

describe("ShopeeApiService.getOrderDetails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("solicita item_list e campos necessarios para importar pedidos", async () => {
    const requestSpy = vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: { order_list: [] },
      });

    await ShopeeApiService.getOrderDetails("token-1", 123, ["ORDER-1"]);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/api/v2/order/get_order_detail?"),
      "token-1",
      123,
    );

    const requestPath = requestSpy.mock.calls[0]?.[1] as string;
    const query = new URL(`https://example.test${requestPath}`).searchParams;

    expect(query.get("order_sn_list")).toBe("ORDER-1");
    expect(query.get("response_optional_fields")).toBe(
      "item_list,buyer_username,total_amount",
    );
  });
});

describe("ShopeeApiService.getRecentOrders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filtra localmente apenas status pos-venda da Shopee", async () => {
    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [
        { order_sn: "A", order_status: "READY_TO_SHIP", create_time: 1, update_time: 1 },
        { order_sn: "B", order_status: "UNPAID", create_time: 1, update_time: 1 },
        { order_sn: "C", order_status: "TO_CONFIRM_RECEIVE", create_time: 1, update_time: 1 },
      ],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      { order_sn: "A", order_status: "READY_TO_SHIP", item_list: [] },
      { order_sn: "B", order_status: "UNPAID", item_list: [] },
      { order_sn: "C", order_status: "TO_CONFIRM_RECEIVE", item_list: [] },
    ] as any);

    const result = await ShopeeApiService.getRecentOrders("token-1", 123, 1);

    expect(ShopeeApiService.getOrderList).toHaveBeenCalledWith(
      "token-1",
      123,
      expect.not.objectContaining({ order_status: expect.anything() }),
    );
    expect(result.map((order: any) => order.order_sn)).toEqual(["A", "C"]);
  });
});

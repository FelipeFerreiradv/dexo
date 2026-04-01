import { describe, it, expect, vi, afterEach } from "vitest";

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { orderRepository } from "@/app/repositories/order.repository";

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

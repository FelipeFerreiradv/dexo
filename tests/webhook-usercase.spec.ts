import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findAllByExternalUserId: vi.fn(),
    findAllShopeeByShopId: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentOrdersForAccount: vi.fn(),
    importRecentShopeeOrdersForAccount: vi.fn(),
  },
}));

import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { WebhookUseCase } from "../app/marketplaces/usecases/webhook.usercase";

describe("WebhookUseCase duplicate account guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recusa webhook ML quando existem multiplas contas ativas para o mesmo seller", async () => {
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([
      { id: "acc-1", userId: "user-1", status: "ACTIVE" },
      { id: "acc-2", userId: "user-2", status: "ACTIVE" },
    ] as any);

    const result = await WebhookUseCase.processOrderWebhook({
      resource: "/orders/123456789",
      user_id: 123456,
      topic: "orders_v2",
      application_id: 1,
      attempts: 1,
      sent: "2026-04-10T12:00:00Z",
      received: "2026-04-10T12:00:01Z",
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/múltiplas contas ativas do mercado livre/i);
    expect(OrderUseCase.importRecentOrdersForAccount).not.toHaveBeenCalled();
  });

  it("recusa webhook Shopee quando existem multiplas contas ativas para o mesmo shopId", async () => {
    vi.spyOn(
      MarketplaceRepository,
      "findAllShopeeByShopId",
    ).mockResolvedValue([
      { id: "acc-1", userId: "user-1", status: "ACTIVE" },
      { id: "acc-2", userId: "user-2", status: "ACTIVE" },
    ] as any);

    const result = await WebhookUseCase.processShopeeOrderWebhook({
      shop_id: 1679461742,
      code: 3,
      timestamp: 1712750000,
      data: { ordersn: "260410DWAX0PWB", status: "READY_TO_SHIP" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/múltiplas contas shopee ativas/i);
    expect(OrderUseCase.importRecentShopeeOrdersForAccount).not.toHaveBeenCalled();
  });
});

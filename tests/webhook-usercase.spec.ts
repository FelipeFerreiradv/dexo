import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../app/lib/prisma", () => ({
  default: {
    webhookEventLog: {
      create: vi.fn().mockResolvedValue({ id: "evt-1" }),
    },
  },
}));

import prisma from "../app/lib/prisma";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { WebhookUseCase } from "../app/marketplaces/usecases/webhook.usercase";

describe("WebhookUseCase duplicate account guards", () => {
  beforeEach(() => {
    (prisma as any).webhookEventLog.create = vi
      .fn()
      .mockResolvedValue({ id: "evt-1" });
  });

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

describe("WebhookUseCase idempotency (claimWebhookEvent)", () => {
  beforeEach(() => {
    (prisma as any).webhookEventLog.create = vi
      .fn()
      .mockResolvedValue({ id: "evt-1" });
    (MarketplaceRepository.findAllByExternalUserId as any).mockResolvedValue([
      { id: "acc-1", userId: "u-1", status: "ACTIVE" },
    ]);
    (MarketplaceRepository.findAllShopeeByShopId as any).mockResolvedValue([
      { id: "acc-2", userId: "u-2", status: "ACTIVE" },
    ]);
    (OrderUseCase.importRecentOrdersForAccount as any).mockResolvedValue({
      imported: 1,
      errors: 0,
    });
    (OrderUseCase.importRecentShopeeOrdersForAccount as any).mockResolvedValue({
      imported: 1,
      errors: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignora webhook ML duplicado (P2002) sem reimportar pedidos", async () => {
    const p2002 = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    (prisma as any).webhookEventLog.create = vi.fn().mockRejectedValue(p2002);

    const payload = {
      resource: "/orders/999",
      user_id: 42,
      topic: "orders_v2",
      application_id: 1,
      attempts: 1,
      sent: "2026-04-12T10:00:00Z",
      received: "2026-04-12T10:00:01Z",
    };

    const result = await WebhookUseCase.processOrderWebhook(payload as any);

    expect(result.success).toBe(true);
    expect(result.action).toBe("duplicate_ignored");
    expect(OrderUseCase.importRecentOrdersForAccount).not.toHaveBeenCalled();
  });

  it("ignora webhook Shopee duplicado (P2002) sem reimportar pedidos", async () => {
    const p2002 = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    (prisma as any).webhookEventLog.create = vi.fn().mockRejectedValue(p2002);

    const result = await WebhookUseCase.processShopeeOrderWebhook({
      shop_id: 111,
      code: 3,
      timestamp: 1712750000,
      data: { ordersn: "ORDER-DUPLICATE", status: "READY_TO_SHIP" },
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("duplicate_ignored");
    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).not.toHaveBeenCalled();
  });

  it("processa webhook ML novo quando claim sucede", async () => {
    const payload = {
      resource: "/orders/1001",
      user_id: 42,
      topic: "orders_v2",
      application_id: 1,
      attempts: 1,
      sent: "2026-04-12T11:00:00Z",
      received: "2026-04-12T11:00:01Z",
    };

    const result = await WebhookUseCase.processOrderWebhook(payload as any);

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("1001");
    expect(OrderUseCase.importRecentOrdersForAccount).toHaveBeenCalledTimes(1);
  });

  it("recusa webhook ML quando nenhuma conta ativa existe para o seller", async () => {
    (MarketplaceRepository.findAllByExternalUserId as any).mockResolvedValue([]);

    const result = await WebhookUseCase.processOrderWebhook({
      resource: "/orders/777",
      user_id: 99999,
      topic: "orders_v2",
      application_id: 1,
      attempts: 1,
      sent: "2026-04-12T13:00:00Z",
      received: "2026-04-12T13:00:01Z",
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/conta do mercado livre não encontrada/i);
    expect(OrderUseCase.importRecentOrdersForAccount).not.toHaveBeenCalled();
  });

  it("recusa webhook Shopee quando nenhuma conta ativa existe para o shop", async () => {
    (MarketplaceRepository.findAllShopeeByShopId as any).mockResolvedValue([]);

    const result = await WebhookUseCase.processShopeeOrderWebhook({
      shop_id: 888,
      code: 3,
      timestamp: 1712750000,
      data: { ordersn: "ORDER-NONE", status: "READY_TO_SHIP" },
    });

    expect(result.success).toBe(false);
    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).not.toHaveBeenCalled();
  });

  it("propaga erros não-P2002 do claim", async () => {
    (prisma as any).webhookEventLog.create = vi
      .fn()
      .mockRejectedValue(new Error("db connection lost"));

    const result = await WebhookUseCase.processOrderWebhook({
      resource: "/orders/222",
      user_id: 7,
      topic: "orders_v2",
      application_id: 1,
      attempts: 1,
      sent: "2026-04-12T12:00:00Z",
      received: "2026-04-12T12:00:01Z",
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/db connection lost/);
  });
});

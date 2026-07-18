import { describe, it, expect, vi, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Wiring de cancelamento nos webhooks ML/Shopee (WebhookUseCase).
//
// Prova:
//  - ML: payload não traz status → a verdade é o fetch da API; handler só
//    roda para pedido local existente não-cancelado com raw "cancelled".
//  - Shopee: push é HINT; confirma na API e só age com raw "CANCELLED"
//    (IN_CANCEL não toca o pedido).
//  - ZERO REGRESSÃO: o re-poll continua sendo chamado com os mesmos args e
//    o retorno do webhook permanece idêntico (mesmo quando o fetch falha).
//  - Kill-switch desliga a checagem sem afetar o caminho existente.
// ──────────────────────────────────────────────────────────

import prisma from "@/app/lib/prisma";
import { WebhookUseCase } from "@/app/marketplaces/usecases/webhook.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "@/app/marketplaces/services/shopee-oauth.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";

const emptyImport = {
  totalOrders: 0,
  imported: 0,
  alreadyExists: 1,
  noProducts: 0,
  errors: 0,
  stockDeductions: 0,
  results: [],
};

const mlPayload = (over: Record<string, any> = {}) => ({
  resource: "/orders/123456",
  user_id: 555,
  topic: "orders_v2",
  application_id: 1,
  attempts: 1,
  sent: "2026-07-17T10:00:00Z",
  received: "2026-07-17T10:00:01Z",
  ...over,
});

const shopeePayload = (over: Record<string, any> = {}) => ({
  shop_id: 777,
  code: 4,
  timestamp: 1_800_000_000,
  data: { ordersn: "SN-1", status: "CANCELLED" },
  ...over,
});

const account = (over: Record<string, any> = {}) => ({
  id: "acc-1",
  userId: "u-1",
  status: "ACTIVE",
  shopId: 777,
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000), // longe de expirar → sem refresh
  ...over,
});

function setupML({
  localOrder = { id: "o-1", status: "PAID" } as any,
  mlStatus = "cancelled",
  importResult = emptyImport as any,
  freshAccount = account({ accessToken: "tok-fresh" }) as any,
} = {}) {
  vi.spyOn(prisma.webhookEventLog as any, "create").mockResolvedValue({});
  vi.spyOn(MarketplaceRepository, "findAllByExternalUserId").mockResolvedValue([
    account(),
  ] as any);
  // Conta RELIDA do banco após o re-poll (tokens podem ter rotacionado),
  // com select mínimo (EGRESS).
  const findById = vi
    .spyOn(prisma.marketplaceAccount, "findUnique")
    .mockResolvedValue(freshAccount);
  const importSpy = vi
    .spyOn(OrderUseCase, "importRecentOrdersForAccount")
    .mockResolvedValue(importResult);
  const findFirst = vi
    .spyOn(prisma.order, "findFirst")
    .mockResolvedValue(localOrder);
  const getOrder = vi
    .spyOn(MLApiService, "getOrderDetails")
    .mockResolvedValue({ status: mlStatus } as any);
  const cancelSpy = vi
    .spyOn(OrderUseCase, "processOrderCancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "123456",
      action: "cancelled_restored",
      restoredItems: 1,
    });
  return { importSpy, findById, findFirst, getOrder, cancelSpy };
}

function setupShopee({
  localOrder = { id: "o-1", status: "PAID" } as any,
  apiStatus = "CANCELLED",
  freshAccount = account({ accessToken: "tok-fresh" }) as any,
} = {}) {
  vi.spyOn(prisma.webhookEventLog as any, "create").mockResolvedValue({});
  vi.spyOn(MarketplaceRepository, "findAllShopeeByShopId").mockResolvedValue([
    account(),
  ] as any);
  const findById = vi
    .spyOn(prisma.marketplaceAccount, "findUnique")
    .mockResolvedValue(freshAccount);
  const importSpy = vi
    .spyOn(OrderUseCase, "importRecentShopeeOrdersForAccount")
    .mockResolvedValue(emptyImport as any);
  const findFirst = vi
    .spyOn(prisma.order, "findFirst")
    .mockResolvedValue(localOrder);
  const getOrders = vi
    .spyOn(ShopeeApiService, "getOrderDetails")
    .mockResolvedValue([{ order_sn: "SN-1", order_status: apiStatus }] as any);
  const cancelSpy = vi
    .spyOn(OrderUseCase, "processOrderCancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "SN-1",
      action: "cancelled_restored",
      restoredItems: 1,
    });
  return { importSpy, findById, findFirst, getOrders, cancelSpy };
}

describe("WebhookUseCase.processOrderWebhook — cancelamento ML", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  it("pedido local PAID + API 'cancelled' → chama o handler E mantém o re-poll/retorno intactos", async () => {
    const { importSpy, findById, getOrder, cancelSpy } = setupML();

    const res = await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    // Caminho existente 100% preservado.
    expect(importSpy).toHaveBeenCalledWith("acc-1", 1, true);
    expect(res).toEqual({
      success: true,
      userId: "u-1",
      orderId: "123456",
      action: "no_new_orders",
    });
    // Checagem nova — usa o token RELIDO do banco (o re-poll pode ter
    // rotacionado; o snapshot stale dispararia refresh com token consumido
    // → invalid_grant → conta marcada ERROR), com select mínimo (EGRESS).
    expect(findById).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-1" },
        select: expect.objectContaining({ accessToken: true }),
      }),
    );
    expect(getOrder).toHaveBeenCalledWith("tok-fresh", "123456");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith({
      marketplaceAccountId: "acc-1",
      externalOrderId: "123456",
      platformLabel: "ML",
      logPrefix: "[WebhookUseCase]",
    });
  });

  it("pedido recém-importado NESTE re-poll → não faz fetch extra (acabou de vir da API como paid)", async () => {
    const { findFirst, getOrder, cancelSpy } = setupML({
      importResult: {
        ...emptyImport,
        imported: 1,
        alreadyExists: 0,
        results: [{ externalOrderId: "123456", status: "imported" }],
      },
    });

    const res = await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(findFirst).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it("API não-cancelado ('paid') → handler NÃO é chamado", async () => {
    const { cancelSpy } = setupML({ mlStatus: "paid" });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("pedido inexistente localmente → nem consulta a API (gate de custo)", async () => {
    const { getOrder, cancelSpy } = setupML({ localOrder: null });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(getOrder).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("pedido local já CANCELLED → nem consulta a API", async () => {
    const { getOrder } = setupML({
      localOrder: { id: "o-1", status: "CANCELLED" },
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(getOrder).not.toHaveBeenCalled();
  });

  it("fetch da API lança → best-effort: retorno do webhook permanece idêntico", async () => {
    const { getOrder, cancelSpy } = setupML();
    getOrder.mockRejectedValue(new Error("timeout"));

    const res = await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(res).toEqual({
      success: true,
      userId: "u-1",
      orderId: "123456",
      action: "no_new_orders",
    });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("kill-switch → checagem desligada, re-poll e retorno intactos", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const { importSpy, findFirst, cancelSpy } = setupML();

    const res = await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(importSpy).toHaveBeenCalledWith("acc-1", 1, true);
    expect(res.success).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe("WebhookUseCase.processShopeeOrderWebhook — cancelamento Shopee", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  it("push CANCELLED + API CANCELLED → chama o handler E mantém re-poll/retorno intactos", async () => {
    const { importSpy, getOrders, cancelSpy } = setupShopee();

    const res = await WebhookUseCase.processShopeeOrderWebhook(
      shopeePayload() as any,
    );

    expect(importSpy).toHaveBeenCalledWith("acc-1", 1, true);
    expect(res).toEqual({
      success: true,
      accountId: "acc-1",
      action: "no_new_orders",
    });
    // Token RELIDO do banco (re-poll pode ter rotacionado os tokens Shopee).
    expect(getOrders).toHaveBeenCalledWith("tok-fresh", 777, ["SN-1"]);
    expect(cancelSpy).toHaveBeenCalledWith({
      marketplaceAccountId: "acc-1",
      externalOrderId: "SN-1",
      platformLabel: "Shopee",
      logPrefix: "[WebhookUseCase]",
    });
  });

  it("token expirado → refresca via ShopeeOAuthService, persiste e usa o token novo", async () => {
    const { getOrders, cancelSpy } = setupShopee({
      freshAccount: account({
        accessToken: "tok-velho",
        refreshToken: "ref-velho",
        expiresAt: new Date(Date.now() - 1_000), // vencido → força refresh
      }),
    });
    const refresh = vi
      .spyOn(ShopeeOAuthService, "refreshAccessToken")
      .mockResolvedValue({
        access_token: "tok-novo",
        refresh_token: "ref-novo",
        expire_in: 14_400,
      } as any);
    const persist = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValue({} as any);

    await WebhookUseCase.processShopeeOrderWebhook(shopeePayload() as any);

    expect(refresh).toHaveBeenCalledWith("ref-velho", 777);
    expect(persist).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({
        accessToken: "tok-novo",
        refreshToken: "ref-novo",
      }),
    );
    expect(getOrders).toHaveBeenCalledWith("tok-novo", 777, ["SN-1"]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("refresh de token falha → checagem pulada em silêncio, retorno do webhook intacto", async () => {
    const { getOrders, cancelSpy } = setupShopee({
      freshAccount: account({
        accessToken: "tok-velho",
        refreshToken: "ref-velho",
        expiresAt: new Date(Date.now() - 1_000),
      }),
    });
    vi.spyOn(ShopeeOAuthService, "refreshAccessToken").mockRejectedValue(
      new Error("invalid refresh token"),
    );

    const res = await WebhookUseCase.processShopeeOrderWebhook(
      shopeePayload() as any,
    );

    expect(res).toEqual({
      success: true,
      accountId: "acc-1",
      action: "no_new_orders",
    });
    expect(getOrders).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("IN_CANCEL (cancelamento em andamento pode ser rejeitado) → handler NÃO é chamado", async () => {
    const { getOrders, cancelSpy } = setupShopee({ apiStatus: "IN_CANCEL" });

    await WebhookUseCase.processShopeeOrderWebhook(
      shopeePayload({ data: { ordersn: "SN-1", status: "IN_CANCEL" } }) as any,
    );

    // O hint IN_CANCEL justifica o fetch, mas o status raw da API decide.
    expect(getOrders).toHaveBeenCalledTimes(1);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("push sem hint de cancelamento (READY_TO_SHIP) → nem consulta pedido local/API", async () => {
    const { findFirst, getOrders, cancelSpy } = setupShopee();

    await WebhookUseCase.processShopeeOrderWebhook(
      shopeePayload({
        data: { ordersn: "SN-1", status: "READY_TO_SHIP" },
      }) as any,
    );

    expect(findFirst).not.toHaveBeenCalled();
    expect(getOrders).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("pedido inexistente localmente → nem consulta a API", async () => {
    const { getOrders, cancelSpy } = setupShopee({ localOrder: null });

    await WebhookUseCase.processShopeeOrderWebhook(shopeePayload() as any);

    expect(getOrders).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("fetch da API lança → best-effort: retorno idêntico", async () => {
    const { getOrders, cancelSpy } = setupShopee();
    getOrders.mockRejectedValue(new Error("ip not whitelisted"));

    const res = await WebhookUseCase.processShopeeOrderWebhook(
      shopeePayload() as any,
    );

    expect(res).toEqual({
      success: true,
      accountId: "acc-1",
      action: "no_new_orders",
    });
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("kill-switch → checagem desligada, caminho existente intacto", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const { importSpy, findFirst, cancelSpy } = setupShopee();

    const res = await WebhookUseCase.processShopeeOrderWebhook(
      shopeePayload() as any,
    );

    expect(importSpy).toHaveBeenCalledWith("acc-1", 1, true);
    expect(res.success).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

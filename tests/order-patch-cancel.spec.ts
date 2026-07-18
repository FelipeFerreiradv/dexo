import { describe, it, expect, vi, afterEach } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// PATCH /orders/:id/status — wiring de cancelamento manual.
//
// Prova:
//  - status=CANCELLED roteia pelo mesmo handler idempotente (estorno +
//    reabertura) ANTES do update, e a resposta da rota permanece idêntica.
//  - Demais statuses: caminho byte-idêntico (handler não é chamado).
//  - Kill-switch desliga o wiring sem afetar o update.
//  - Posse multi-tenant: pedido de outro dono não dispara o handler.
// ──────────────────────────────────────────────────────────

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));
vi.mock("@/app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { orderRoutes } from "../app/routes/order.routes";
import { orderRepository } from "../app/repositories/order.repository";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

const updatedOrder = {
  id: "o-1",
  status: "CANCELLED",
  items: [],
};

function setup({
  owned = {
    status: "PAID",
    externalOrderId: "123",
    marketplaceAccountId: "acc-1",
    marketplaceAccount: { platform: "MERCADO_LIVRE" },
  } as any,
} = {}) {
  const findFirst = vi
    .spyOn(prisma.order, "findFirst")
    .mockResolvedValue(owned);
  const updateMany = vi
    .spyOn(prisma.order, "updateMany")
    .mockResolvedValue({ count: 1 } as any);
  const updateSpy = vi
    .spyOn(orderRepository, "update")
    .mockResolvedValue(updatedOrder as any);
  const cancelSpy = vi
    .spyOn(OrderUseCase, "processOrderCancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "123",
      action: "cancelled_restored",
      restoredItems: 1,
    });
  const uncancelSpy = vi
    .spyOn(OrderUseCase, "processOrderUncancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "123",
      action: "reactivated_rededucted",
      deductedItems: 1,
    });
  return { findFirst, updateMany, updateSpy, cancelSpy, uncancelSpy };
}

describe("PATCH /orders/:id/status — cancelamento manual", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  it("CANCELLED → handler idempotente chamado ANTES do update; resposta idêntica", async () => {
    const { findFirst, updateSpy, cancelSpy } = setup();
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "CANCELLED" },
    });

    expect(res.statusCode).toBe(200);
    // Escopo multi-tenant: a resolução do pedido DEVE filtrar pela posse
    // via marketplaceAccount.userId (mesma checagem do repositório).
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "o-1", marketplaceAccount: { userId: "user-owner" } },
      }),
    );
    expect(res.json()).toMatchObject({
      success: true,
      message: "Status atualizado com sucesso",
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith({
      marketplaceAccountId: "acc-1",
      externalOrderId: "123",
      platformLabel: "ML",
      logPrefix: "[Orders]",
    });
    // O handler é o ÚNICO escritor de status — o update final roda SEM
    // status (só relê o pedido para a resposta; nunca atropela transição
    // concorrente).
    expect(updateSpy).toHaveBeenCalledWith("o-1", {}, "user-owner");
    // Handler roda antes do update.
    expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      updateSpy.mock.invocationCallOrder[0],
    );
  });

  it("cancelamento com falha no estorno → 500 SEM escrever o status", async () => {
    const { updateSpy, cancelSpy } = setup();
    cancelSpy.mockResolvedValue({
      success: false,
      orderId: null,
      externalOrderId: "123",
      action: "error",
      restoredItems: 0,
      message: "tx timeout",
    });
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "CANCELLED" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/tx timeout/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("platformLabel derivado da conta: SHOPEE → 'Shopee'", async () => {
    const { cancelSpy } = setup({
      owned: {
        externalOrderId: "SN-1",
        marketplaceAccountId: "acc-2",
        marketplaceAccount: { platform: "SHOPEE" },
      },
    });
    const app = buildApp();

    await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "CANCELLED" },
    });

    expect(cancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ platformLabel: "Shopee" }),
    );
  });

  it("platformLabel derivado da conta: MAGALU → 'Magalu' (label monta a reason do net)", async () => {
    const { cancelSpy } = setup({
      owned: {
        externalOrderId: "MG-1",
        marketplaceAccountId: "acc-3",
        marketplaceAccount: { platform: "MAGALU" },
      },
    });
    const app = buildApp();

    await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "CANCELLED" },
    });

    expect(cancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ platformLabel: "Magalu" }),
    );
  });

  it("transição simples (PAID→SHIPPED): write CONDICIONAL no status sondado; nenhum handler", async () => {
    const { findFirst, updateMany, updateSpy, cancelSpy, uncancelSpy } =
      setup();
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "SHIPPED" },
    });

    expect(res.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(uncancelSpy).not.toHaveBeenCalled();
    // Write condicionado ao status sondado (não atropela cancelamento
    // concorrente); o update final relê para a resposta, sem status.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "o-1",
        status: "PAID",
        marketplaceAccount: { userId: "user-owner" },
      },
      data: { status: "SHIPPED" },
    });
    expect(updateSpy).toHaveBeenCalledWith("o-1", {}, "user-owner");
  });

  it("transição simples com corrida (status mudou embaixo) → 409 sem escrever", async () => {
    const { updateMany, updateSpy } = setup();
    updateMany.mockResolvedValue({ count: 0 } as any);
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "SHIPPED" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/mudou de status/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("un-cancel: PAID em pedido CANCELLED → re-deduz via handler ANTES do update; resposta idêntica", async () => {
    const { updateSpy, cancelSpy, uncancelSpy } = setup({
      owned: {
        status: "CANCELLED",
        externalOrderId: "123",
        marketplaceAccountId: "acc-1",
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
    });
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "PAID" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      message: "Status atualizado com sucesso",
    });
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(uncancelSpy).toHaveBeenCalledTimes(1);
    expect(uncancelSpy).toHaveBeenCalledWith({
      marketplaceAccountId: "acc-1",
      externalOrderId: "123",
      platformLabel: "ML",
      targetStatus: "PAID",
      logPrefix: "[Orders]",
    });
    // Handler é o único escritor de status — update final sem status.
    expect(updateSpy).toHaveBeenCalledWith("o-1", {}, "user-owner");
    expect(uncancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      updateSpy.mock.invocationCallOrder[0],
    );
  });

  it("un-cancel: PENDING em pedido CANCELLED → 400 sem tocar handler nem update", async () => {
    const { updateSpy, uncancelSpy } = setup({
      owned: {
        status: "CANCELLED",
        externalOrderId: "123",
        marketplaceAccountId: "acc-1",
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
    });
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "PENDING" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/PENDING/);
    expect(uncancelSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("un-cancel: falha na re-dedução → 500 SEM escrever o status (pedido segue CANCELLED)", async () => {
    const { updateSpy, uncancelSpy } = setup({
      owned: {
        status: "CANCELLED",
        externalOrderId: "123",
        marketplaceAccountId: "acc-1",
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
    });
    uncancelSpy.mockResolvedValue({
      success: false,
      orderId: null,
      externalOrderId: "123",
      action: "error",
      deductedItems: 0,
      message: "db down",
    });
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "PAID" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/db down/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("kill-switch → un-cancel desligado; PAID em pedido CANCELLED vira write puro como hoje", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const { findFirst, updateSpy, uncancelSpy } = setup({
      owned: {
        status: "CANCELLED",
        externalOrderId: "123",
        marketplaceAccountId: "acc-1",
        marketplaceAccount: { platform: "MERCADO_LIVRE" },
      },
    });
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "PAID" },
    });

    expect(res.statusCode).toBe(200);
    expect(findFirst).not.toHaveBeenCalled();
    expect(uncancelSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("pedido de outro dono (posse falha) → handler não dispara; update decide como hoje", async () => {
    const { updateSpy, cancelSpy } = setup({ owned: null });
    updateSpy.mockRejectedValue(new Error("Pedido não encontrado"));
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "CANCELLED" },
    });

    expect(cancelSpy).not.toHaveBeenCalled();
    // Mesmo comportamento de hoje: o repo lança e a rota responde 500.
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/não encontrado/i);
  });

  it("kill-switch → wiring desligado; update segue normal", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const { findFirst, updateSpy, cancelSpy } = setup();
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "CANCELLED" },
    });

    expect(res.statusCode).toBe(200);
    expect(findFirst).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("status inválido → 400 como hoje, sem tocar handler/update", async () => {
    const { updateSpy, cancelSpy } = setup();
    const app = buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/orders/o-1/status",
      headers: { email: OWNER },
      payload: { status: "FOO" },
    });

    expect(res.statusCode).toBe(400);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

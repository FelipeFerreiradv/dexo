import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";

/**
 * Rotas dos avisos ao lojista: escopo pela EMPRESA (dataOwnerId), inclusive
 * quando quem pergunta é colaborador, e erro vira 500 sem derrubar a tela.
 */

vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "colab-1", parentUserId: "dono-1", dataOwnerId: "dono-1" };
  },
}));

import { marketplaceRoutes } from "../app/routes/marketplace.routes";
import { orderRoutes } from "../app/routes/order.routes";
import { AccountHealthService } from "../app/marketplaces/services/account-health.service";
import { OversellAlertsService } from "../app/marketplaces/services/oversell-alerts.service";

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = null;
});

describe("GET /marketplace/accounts/health", () => {
  it("devolve as contas com problema da empresa", async () => {
    const contas = [
      { id: "a", platform: "MERCADO_LIVRE", accountName: "REBOOTEC", tipo: "parada", ultimoPedidoEm: null, anunciosAVenda: 506 },
    ];
    const spy = vi.spyOn(AccountHealthService, "getForOwner").mockResolvedValue(contas as any);
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });

    const r = await app.inject({ method: "GET", url: "/marketplace/accounts/health" });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ contas });
    expect(spy).toHaveBeenCalledWith("dono-1");
  });

  it("falha vira 500", async () => {
    vi.spyOn(AccountHealthService, "getForOwner").mockRejectedValue(new Error("x"));
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });

    const r = await app.inject({ method: "GET", url: "/marketplace/accounts/health" });
    expect(r.statusCode).toBe(500);
  });
});

describe("GET /orders/oversell-alerts", () => {
  it("devolve os alertas da empresa", async () => {
    const alertas = [{ id: "l1", orderId: "o1", externalOrderId: "X", platform: "SHOPEE", accountName: null, createdAt: "2026-09-16T10:00:00.000Z", itens: [] }];
    const spy = vi.spyOn(OversellAlertsService, "listForOwner").mockResolvedValue(alertas as any);
    app = fastify();
    await app.register(orderRoutes, { prefix: "/orders" });

    const r = await app.inject({ method: "GET", url: "/orders/oversell-alerts" });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, alertas });
    expect(spy).toHaveBeenCalledWith("dono-1");
  });

  it("não é capturada pela rota /orders/:id", async () => {
    vi.spyOn(OversellAlertsService, "listForOwner").mockRejectedValue(new Error("x"));
    app = fastify();
    await app.register(orderRoutes, { prefix: "/orders" });

    const r = await app.inject({ method: "GET", url: "/orders/oversell-alerts" });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe("Erro ao buscar vendas sobre peça sem estoque");
  });
});

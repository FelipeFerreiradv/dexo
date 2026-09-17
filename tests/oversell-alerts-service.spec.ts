import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => ({
  default: {
    systemLog: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));
vi.mock("../app/lib/prisma", () => ({
  default: {
    systemLog: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));

import prisma from "../app/lib/prisma";
import { OversellAlertsService } from "../app/marketplaces/services/oversell-alerts.service";
import {
  alertasNaoDispensados,
  chaveDaDispensa,
  tituloDoAviso,
} from "../app/pedidos/components/oversell-alerts-banner";

/**
 * Venda que caiu sobre peça sem estoque. Em setembro/2026 foram 51 registros,
 * nenhum visível ao lojista. A lista agrega por pedido, respeita a empresa e
 * tira pedido cancelado (o cancelamento é a própria resolução).
 */

const p = prisma as any;
const AGORA = new Date("2026-09-17T12:00:00.000Z");

const log = (id: string, orderId: string, createdAt: string, items: any[]) => ({
  id,
  createdAt: new Date(createdAt),
  details: { orderId, platform: "MERCADO_LIVRE", items, reason: "Venda ML #1" },
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORDER_OVERSELL_ALERTS_DISABLED;
});

describe("OversellAlertsService.listForOwner", () => {
  it("lê só OVERSELL_DETECTED da empresa nos últimos 7 dias", async () => {
    p.systemLog.findMany.mockResolvedValue([]);

    await OversellAlertsService.listForOwner("owner-1", AGORA);

    const arg = p.systemLog.findMany.mock.calls[0][0];
    expect(arg.where.action).toBe("OVERSELL_DETECTED");
    expect(arg.where.userId).toBe("owner-1");
    expect(arg.where.createdAt.gte.toISOString()).toBe("2026-09-10T12:00:00.000Z");
    // Sem alerta, nada mais é consultado.
    expect(p.order.findMany).not.toHaveBeenCalled();
  });

  it("um aviso por pedido (o mais recente), sem pedido cancelado nem de fora da empresa", async () => {
    p.systemLog.findMany.mockResolvedValue([
      log("l3", "o1", "2026-09-16T10:00:00Z", [{ productId: "p1", productName: "Paralama" }]),
      log("l2", "o1", "2026-09-16T09:00:00Z", [{ productId: "p1", productName: "Paralama" }]),
      log("l1", "o2", "2026-09-15T10:00:00Z", [{ productId: "p2", productName: "Farol" }]),
      log("l0", "o3", "2026-09-14T10:00:00Z", [{ productId: "p3", productName: "Porta" }]),
    ]);
    p.order.findMany.mockResolvedValue([
      { id: "o1", externalOrderId: "2000018459", status: "PAID", marketplaceAccount: { platform: "MERCADO_LIVRE", accountName: "JOTABE" } },
      { id: "o2", externalOrderId: "2000018463", status: "CANCELLED", marketplaceAccount: { platform: "MERCADO_LIVRE", accountName: "JOTABE" } },
      // o3 não voltou: pedido de outra empresa ou apagado.
    ]);
    p.product.findMany.mockResolvedValue([{ id: "p1", sku: "32937", name: "Paralama esquerdo Meriva" }]);

    const r = await OversellAlertsService.listForOwner("owner-1", AGORA);

    expect(r).toEqual([
      {
        id: "l3",
        orderId: "o1",
        externalOrderId: "2000018459",
        platform: "MERCADO_LIVRE",
        accountName: "JOTABE",
        createdAt: "2026-09-16T10:00:00.000Z",
        itens: [{ productId: "p1", sku: "32937", nome: "Paralama esquerdo Meriva" }],
      },
    ]);
    // O pedido exibido é filtrado pelo MESMO escopo da tela de Pedidos e de
    // GET /orders/:id — senão o "Ver pedido" não conseguiria abrir.
    const whereOrder = p.order.findMany.mock.calls[0][0].where;
    expect(whereOrder.marketplaceAccount).toEqual({ userId: "owner-1" });
    // E só peça da própria empresa entra com nome e SKU.
    const whereProduto = p.product.findMany.mock.calls[0][0].where;
    expect(whereProduto.user).toEqual({ OR: [{ id: "owner-1" }, { parentUserId: "owner-1" }] });
  });

  it("peça de outra empresa (ou apagada): nem nome nem SKU", async () => {
    p.systemLog.findMany.mockResolvedValue([
      log("l1", "o1", "2026-09-16T10:00:00Z", [{ productId: "p9", productName: "Motor de arranque" }]),
    ]);
    p.order.findMany.mockResolvedValue([
      { id: "o1", externalOrderId: "X1", status: "SHIPPED", marketplaceAccount: { platform: "SHOPEE", accountName: null } },
    ]);
    p.product.findMany.mockResolvedValue([]);

    const r = await OversellAlertsService.listForOwner("owner-1", AGORA);
    // O nome gravado no alerta pode ser de outro tenant: não é exibido.
    expect(r[0].itens).toEqual([{ productId: "p9", sku: null, nome: "Peça" }]);
  });

  it("kill-switch ligado: lista vazia sem consultar", async () => {
    process.env.ORDER_OVERSELL_ALERTS_DISABLED = "1";
    await expect(OversellAlertsService.listForOwner("owner-1", AGORA)).resolves.toEqual([]);
    expect(p.systemLog.findMany).not.toHaveBeenCalled();
  });
});

describe("aviso em Pedidos", () => {
  const a = (id: string, createdAt: string) => ({
    id,
    orderId: id,
    externalOrderId: id,
    platform: "MERCADO_LIVRE",
    accountName: null,
    createdAt,
    itens: [],
  });

  it("dispensar esconde os atuais; alerta mais novo volta a aparecer", () => {
    const lista = [a("novo", "2026-09-17T10:00:00.000Z"), a("velho", "2026-09-16T10:00:00.000Z")];
    expect(alertasNaoDispensados(lista, null).map((x) => x.id)).toEqual(["novo", "velho"]);
    expect(alertasNaoDispensados(lista, "2026-09-16T10:00:00.000Z").map((x) => x.id)).toEqual(["novo"]);
    expect(alertasNaoDispensados(lista, "2026-09-17T10:00:00.000Z")).toEqual([]);
    expect(alertasNaoDispensados(lista, "lixo").length).toBe(2);
  });

  it("dispensar é por usuário: outra empresa no mesmo navegador não herda", () => {
    expect(chaveDaDispensa("a@x.com")).not.toBe(chaveDaDispensa("b@y.com"));
    expect(chaveDaDispensa(null)).toBe("dexo:oversell-dispensado-ate:anonimo");
  });

  it("texto aprovado", () => {
    expect(tituloDoAviso(1)).toBe("1 venda dos últimos 7 dias caiu sobre peça sem estoque.");
    expect(tituloDoAviso(2)).toBe("2 vendas dos últimos 7 dias caíram sobre peça sem estoque.");
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Stub do StockSyncRetryService — deductStockForOrder dispara um setImmediate
// pós-commit que chama runOnce(). Mesmo motivo do order-usecase-shopee-multi.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 2 — janela por `update_time` e regra de status auditável.
//
// Dois defeitos confirmados na Fase 0 (29/07/2026):
//
// 1. A janela era por `create_time` (shopee-api.service: `?? "create_time"`).
//    Sondagem real na conta do cliente: `getOrderList[create_time]` devolvia 2
//    pedidos em 7 dias e `[update_time]` devolvia 4 — dois pedidos criados
//    antes da janela, mas atualizados dentro dela, eram invisíveis ao poll.
//
// 2. A whitelist era FECHADA (COMPLETED, READY_TO_SHIP, SHIPPED, PROCESSED,
//    TO_CONFIRM_RECEIVE) e o filtro descartava sem log. `INVOICE_PENDING`
//    (pago, aguardando NF-e do vendedor) não existia em NENHUM lugar do
//    repositório: um pedido pago nesse estado nunca era importado.
//
// A suíte roda com SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED=1 (vitest.config),
// para os specs antigos ficarem byte-idênticos. Aqui ligamos a feature.
// ──────────────────────────────────────────────────────────────────────────────

const ACC = {
  id: "acc-1",
  userId: "owner-1",
  accessToken: "token",
  refreshToken: "refresh",
  shopId: 123,
};

const pedido = (over: Record<string, any> = {}) => ({
  order_sn: "SN-1",
  order_status: "SHIPPED",
  total_amount: 100,
  buyer_username: "cliente",
  item_list: [{ item_id: 999, item_sku: "3060", model_quantity_purchased: 1 }],
  ...over,
});

let flagAnterior: string | undefined;

beforeEach(() => {
  flagAnterior = process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;
  delete process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;

  vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(ACC as any);
  vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  vi.spyOn(prisma.marketplaceAccount, "update").mockResolvedValue({} as any);
  vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
    items: [{ productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null }],
    linkedCount: 1,
  });
  vi.spyOn(orderRepository, "create").mockResolvedValue({
    id: "order-1",
    items: [{ productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null }],
  } as any);
  vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);
});

afterEach(() => {
  if (flagAnterior === undefined) {
    delete process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;
  } else {
    process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED = flagAnterior;
  }
  vi.restoreAllMocks();
});

describe("janela do poll Shopee", () => {
  it("lista por update_time, e não por create_time", async () => {
    const listSpy = vi
      .spyOn(ShopeeApiService, "getOrderList")
      .mockResolvedValue({ more: false, order_list: [] } as any);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    expect(listSpy).toHaveBeenCalledWith(
      "token",
      123,
      expect.objectContaining({ time_range_field: "update_time" }),
    );
  });

  it("importa pedido criado FORA da janela mas atualizado dentro dela", async () => {
    const dezDiasAtras = Math.floor(Date.now() / 1000) - 10 * 86400;

    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [{ order_sn: "SN-ANTIGO" }],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      pedido({
        order_sn: "SN-ANTIGO",
        create_time: dezDiasAtras,
        update_time: Math.floor(Date.now() / 1000),
      }),
    ] as any);

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.imported).toBe(1);
    expect(r.stockDeductions).toBe(1);
  });

  it("respeita o teto de 15 dias da API mesmo com marca d'agua antiga", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      ...ACC,
      // 40 dias atrás: a API rejeitaria o intervalo e a conta inteira cairia.
      shopeeOrdersSyncedThrough: new Date(Date.now() - 40 * 86400 * 1000),
    } as any);
    const listSpy = vi
      .spyOn(ShopeeApiService, "getOrderList")
      .mockResolvedValue({ more: false, order_list: [] } as any);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    const params = listSpy.mock.calls[0]?.[2] as any;
    const janelaDias = (params.time_to - params.time_from) / 86400;
    expect(janelaDias).toBeLessThanOrEqual(15.01);
  });

  it("grava a marca d'agua quando o ciclo termina limpo", async () => {
    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [],
    } as any);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    expect(prisma.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-1" },
        data: expect.objectContaining({
          shopeeOrdersSyncedThrough: expect.any(Date),
        }),
      }),
    );
  });

  it("NAO grava a marca d'agua quando algum pedido deu erro", async () => {
    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [{ order_sn: "SN-1" }],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      pedido(),
    ] as any);
    vi.spyOn(orderRepository, "create").mockRejectedValue(
      new Error("banco fora"),
    );

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.errors).toBe(1);
    // Refazer a janela é mais barato do que pular a venda.
    expect(prisma.marketplaceAccount.update).not.toHaveBeenCalled();
  });
});

describe("regra de status", () => {
  const importaComStatus = async (order_status: string) => {
    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [{ order_sn: "SN-1" }],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      pedido({ order_status }),
    ] as any);
    return OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);
  };

  it("INVOICE_PENDING e importado e da baixa de estoque", async () => {
    const r = await importaComStatus("INVOICE_PENDING");

    expect(r.imported).toBe(1);
    expect(r.stockDeductions).toBe(1);
    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PAID" }),
    );
  });

  it("UNPAID nao e importado e portanto nao da baixa", async () => {
    const r = await importaComStatus("UNPAID");

    expect(r.totalOrders).toBe(0);
    expect(r.imported).toBe(0);
    expect(r.stockDeductions).toBe(0);
    expect(orderRepository.create).not.toHaveBeenCalled();
  });

  it("CANCELLED nao e importado (estorno e do processOrderCancellation)", async () => {
    const r = await importaComStatus("CANCELLED");

    expect(r.totalOrders).toBe(0);
    expect(orderRepository.create).not.toHaveBeenCalled();
  });

  it("RETRY_SHIP e TO_RETURN sao importados como SHIPPED", async () => {
    for (const status of ["RETRY_SHIP", "TO_RETURN"]) {
      vi.mocked(orderRepository.create).mockClear();
      const r = await importaComStatus(status);
      expect(r.imported, status).toBe(1);
      expect(orderRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SHIPPED" }),
      );
    }
  });

  it("TO_CONFIRM_RECEIVE deixa de virar PENDING com estoque ja baixado", async () => {
    const r = await importaComStatus("TO_CONFIRM_RECEIVE");

    expect(r.imported).toBe(1);
    expect(r.stockDeductions).toBe(1);
    expect(orderRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SHIPPED" }),
    );
  });

  it("status DESCONHECIDO e importado e deixa rastro, em vez de sumir", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const r = await importaComStatus("ESTADO_NOVO_DA_SHOPEE");

    // O pedido NÃO some: a whitelist fechada o descartaria em silêncio.
    expect(r.imported).toBe(1);
    const logado = logSpy.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes("shopee.order_import.status_unknown"));
    expect(logado).toBe(true);
  });

  it("contabiliza os status descartados no resultado", async () => {
    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [{ order_sn: "SN-1" }, { order_sn: "SN-2" }],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      pedido({ order_sn: "SN-1", order_status: "UNPAID" }),
      pedido({ order_sn: "SN-2", order_status: "SHIPPED" }),
    ] as any);

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.totalOrders).toBe(1);
    expect(r.skippedByStatus).toBe(1);
    expect(r.skippedStatuses).toEqual(["UNPAID"]);
  });
});

describe("kill-switch SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED", () => {
  it("com 1, volta a create_time, a whitelist fechada e nao grava marca d'agua", async () => {
    process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED = "1";

    const getRecent = vi
      .spyOn(ShopeeApiService, "getRecentOrders")
      .mockResolvedValue([] as any);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    // Exatamente 3 argumentos, como antes da mudança.
    expect(getRecent).toHaveBeenCalledWith("token", 123, 7);
    expect(prisma.marketplaceAccount.update).not.toHaveBeenCalled();
  });

  it("com 1, INVOICE_PENDING volta a ser descartado (comportamento anterior)", async () => {
    process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED = "1";

    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [{ order_sn: "SN-1" }],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      pedido({ order_status: "INVOICE_PENDING" }),
    ] as any);

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.totalOrders).toBe(0);
    expect(orderRepository.create).not.toHaveBeenCalled();
  });
});

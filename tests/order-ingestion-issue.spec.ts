import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 3 — nenhum pedido é descartado em silêncio.
//
// Antes: um pedido cujos itens não casassem com nenhum produto morria no
// `continue` de order.usercase — não virava Order, não gerava SystemLog, não
// aparecia em /pedidos, e o SyncLog do ciclo era gravado como SUCCESS. O
// cliente só descobria contando o estoque físico.
//
// Isto NÃO é hipotético: os logs de produção de 29/07/2026 mostram o descarte
// acontecendo agora — "Produto com SKU TRL-296 (Shopee) não encontrado" e mais
// oito casos no mesmo ciclo, todos apenas console.log + continue.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";

const ACC = {
  id: "acc-1",
  userId: "owner-1",
  accessToken: "token",
  refreshToken: "refresh",
  shopId: 123,
};

const pedidoShopee = (over: Record<string, any> = {}) => ({
  order_sn: "SN-1",
  order_status: "SHIPPED",
  total_amount: 100,
  buyer_username: "cliente",
  item_list: [
    { item_id: 999, item_sku: "SKU-A", model_quantity_purchased: 1 },
  ],
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
  vi.spyOn(OrderIngestionIssueService, "open").mockResolvedValue(undefined);
  vi.spyOn(OrderIngestionIssueService, "resolve").mockResolvedValue(undefined);
});

afterEach(() => {
  if (flagAnterior === undefined) {
    delete process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;
  } else {
    process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED = flagAnterior;
  }
  vi.restoreAllMocks();
});

const comPedidos = (...detalhes: any[]) => {
  vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
    more: false,
    order_list: detalhes.map((d) => ({ order_sn: d.order_sn })),
  } as any);
  vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue(
    detalhes as any,
  );
};

describe("quarentena de ingestão", () => {
  it("pedido sem nenhum item vinculável abre issue NO_LINKED_ITEMS e não some", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [],
      linkedCount: 0,
      unlinked: [
        { itemId: "999", sku: "SKU-A", reason: "PRODUCT_NOT_FOUND" },
      ],
    });

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.noProducts).toBe(1);
    expect(OrderIngestionIssueService.open).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "SHOPEE",
        externalOrderId: "SN-1",
        reason: "NO_LINKED_ITEMS",
        detail: expect.stringContaining("PRODUCT_NOT_FOUND"),
      }),
    );
  });

  it("pedido PARCIAL cria o Order e abre issue PARTIAL_LINK", async () => {
    comPedidos(
      pedidoShopee({
        item_list: [
          { item_id: 1, item_sku: "SKU-A", model_quantity_purchased: 1 },
          { item_id: 2, item_sku: "SKU-B", model_quantity_purchased: 1 },
        ],
      }),
    );
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 50, listingId: null },
      ],
      linkedCount: 1,
      unlinked: [{ itemId: "2", sku: "SKU-B", reason: "PRODUCT_NOT_FOUND" }],
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-1",
      items: [{ productId: "p1", quantity: 1, unitPrice: 50 }],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    // O Order É criado — comportamento preservado.
    expect(r.imported).toBe(1);
    expect(orderRepository.create).toHaveBeenCalled();
    // ...e o item que ficou de fora deixa rastro acionável.
    expect(OrderIngestionIssueService.open).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "PARTIAL_LINK",
        orderId: "order-1",
        detail: expect.stringContaining("SKU-B"),
      }),
    );
  });

  it("falha na baixa abre issue STOCK_DEDUCTION_FAILED com o orderId", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 100, listingId: null },
      ],
      linkedCount: 1,
      unlinked: [],
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-1",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockRejectedValue(
      new Error("deadlock detected"),
    );

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.imported).toBe(1);
    expect(r.stockDeductions).toBe(0);
    expect(OrderIngestionIssueService.open).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "STOCK_DEDUCTION_FAILED",
        orderId: "order-1",
        detail: "deadlock detected",
      }),
    );
  });

  it("pedido completo e com baixa RESOLVE a pendência anterior", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 100, listingId: null },
      ],
      linkedCount: 1,
      unlinked: [],
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-1",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    expect(OrderIngestionIssueService.resolve).toHaveBeenCalledWith(
      "acc-1",
      "SN-1",
      "order-1",
    );
    expect(OrderIngestionIssueService.open).not.toHaveBeenCalled();
  });

  it("exceção inesperada na ingestão abre issue INGEST_FAILED", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockRejectedValue(
      new Error("banco fora do ar"),
    );

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    expect(r.errors).toBe(1);
    expect(OrderIngestionIssueService.open).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "INGEST_FAILED" }),
    );
  });
});

describe("SyncLog honesto", () => {
  const ultimoSyncLog = () =>
    vi.mocked(prisma.syncLog.create).mock.calls.at(-1)?.[0] as any;

  it("noProducts > 0 grava WARNING e vai para o payload", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [],
      linkedCount: 0,
      unlinked: [],
    });

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    const log = ultimoSyncLog();
    // Antes: SUCCESS com "Importados 0 de 1 pedidos do Shopee".
    expect(log.data.status).toBe("WARNING");
    expect(log.data.payload).toEqual(
      expect.objectContaining({ noProducts: 1 }),
    );
  });

  it("ciclo sem perda nenhuma continua SUCCESS", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 100, listingId: null },
      ],
      linkedCount: 1,
      unlinked: [],
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-1",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    const log = ultimoSyncLog();
    expect(log.data.status).toBe("SUCCESS");
    expect(log.data.payload).toEqual(
      expect.objectContaining({
        noProducts: 0,
        partialLinks: 0,
        stockDeductionFailures: 0,
      }),
    );
  });

  it("baixa que falhou rebaixa o ciclo para WARNING", async () => {
    comPedidos(pedidoShopee());
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 100, listingId: null },
      ],
      linkedCount: 1,
      unlinked: [],
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-1",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockRejectedValue(
      new Error("timeout"),
    );

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);

    const log = ultimoSyncLog();
    expect(log.data.status).toBe("WARNING");
    expect(log.data.payload).toEqual(
      expect.objectContaining({ stockDeductionFailures: 1 }),
    );
  });
});

describe("INVARIANTE — todo pedido vira Order OU issue aberto, nunca nenhum", () => {
  it("num lote misto, cada pedido tem exatamente um dos dois desfechos", async () => {
    const detalhes = [
      pedidoShopee({ order_sn: "OK-1" }),
      pedidoShopee({ order_sn: "SEM-VINCULO" }),
      pedidoShopee({ order_sn: "EXPLODE" }),
    ];
    comPedidos(...detalhes);

    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockImplementation(
      async (items: any) => {
        // O mapeamento não sabe o order_sn; usamos o item_id como discriminante.
        const id = items?.[0]?.item_id;
        if (id === 2) return { items: [], linkedCount: 0, unlinked: [] };
        if (id === 3) throw new Error("falha inesperada");
        return {
          items: [
            { productId: "p1", quantity: 1, unitPrice: 100, listingId: null },
          ],
          linkedCount: 1,
          unlinked: [],
        };
      },
    );
    detalhes[0].item_list[0].item_id = 1;
    detalhes[1].item_list[0].item_id = 2;
    detalhes[2].item_list[0].item_id = 3;

    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-ok",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      true,
    );

    // Toda entrada devolvida pela API tem um resultado — nenhuma sumiu.
    expect(r.results).toHaveLength(3);
    expect(r.totalOrders).toBe(3);

    const quarentenados = new Set(
      vi
        .mocked(OrderIngestionIssueService.open)
        .mock.calls.map((c) => c[0].externalOrderId),
    );
    const resolvidos = new Set(
      vi
        .mocked(OrderIngestionIssueService.resolve)
        .mock.calls.map((c) => c[1]),
    );

    for (const d of detalhes) {
      const entry = r.results.find((x) => x.externalOrderId === d.order_sn)!;
      const virouOrder = entry.status === "imported" && entry.orderId !== null;
      const temPendencia = quarentenados.has(d.order_sn);

      // A expressão executável da regra do BLOCO 2.
      expect(
        virouOrder || temPendencia,
        `${d.order_sn} nao virou Order nem abriu pendencia`,
      ).toBe(true);
    }

    expect(quarentenados).toEqual(new Set(["SEM-VINCULO", "EXPLODE"]));
    expect(resolvidos).toEqual(new Set(["OK-1"]));
  });
});

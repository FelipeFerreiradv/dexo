import { describe, it, expect, vi, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco C — a Magalu passa a ter importação de pedidos confiável.
//
// Estado anterior (medido em produção): 8 contas Magalu, 756 anúncios,
// ZERO pedidos e ZERO registros em WebhookEventLog com source "MAGALU".
// O loop de produção não tinha branch para MAGALU e o webhook nunca chegou.
//
// Provas aqui:
//  - status desconhecido não some mais em silêncio: log + contador;
//  - status vindo como OBJETO é normalizado (antes virava "[object Object]"
//    e derrubava TODOS os pedidos da conta);
//  - vocabulário ampliado ("paid", pt-BR) importa em vez de descartar;
//  - falha na baixa de estoque vira SystemLog (antes só console.error);
//  - `no_products` vira SystemLog (venda existe na Magalu e não entrou);
//  - o webhook importa o pedido EXATO por id e libera o claim ao falhar.
// ──────────────────────────────────────────────────────────

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { SystemLogService } from "@/app/services/system-log.service";

const ACCOUNT = {
  id: "acc-mg",
  userId: "u-1",
  accessToken: "tok",
  refreshToken: "ref",
  externalUserId: "tenant-1",
};

function setup({
  magaluOrders = [] as any[],
  existing = [] as { externalOrderId: string; status?: string }[],
  listings = [] as any[],
}) {
  vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(ACCOUNT as any);
  vi.spyOn(
    OrderUseCase as any,
    "getRecentMagaluOrdersWithRefresh",
  ).mockResolvedValue(magaluOrders);
  vi.spyOn(prisma.order, "findMany").mockResolvedValue(existing as any);
  vi.spyOn(prisma.productListing, "findMany").mockResolvedValue(
    listings as any,
  );
  const createSpy = vi
    .spyOn(orderRepository, "create")
    .mockResolvedValue({ id: "o-1", items: [] } as any);
  const deductSpy = vi
    .spyOn(OrderUseCase as any, "deductStockForOrder")
    .mockResolvedValue([]);
  const logError = vi
    .spyOn(SystemLogService, "logError")
    .mockResolvedValue(undefined as any);
  return { createSpy, deductSpy, logError };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeMagaluStatus", () => {
  it("desembrulha status vindo como objeto (o caso que derrubava tudo)", () => {
    expect(OrderUseCase.normalizeMagaluStatus({ type: "approved" })).toBe(
      "approved",
    );
    expect(OrderUseCase.normalizeMagaluStatus({ code: "SHIPPED" })).toBe(
      "shipped",
    );
    expect(OrderUseCase.normalizeMagaluStatus({ status: "paid" })).toBe("paid");
  });

  it("normaliza string com espaço e maiúsculas", () => {
    expect(OrderUseCase.normalizeMagaluStatus("  Delivered ")).toBe(
      "delivered",
    );
  });

  it("devolve string vazia para nulo, indefinido e objeto sem chave conhecida", () => {
    expect(OrderUseCase.normalizeMagaluStatus(null)).toBe("");
    expect(OrderUseCase.normalizeMagaluStatus(undefined)).toBe("");
    expect(OrderUseCase.normalizeMagaluStatus({ foo: "bar" })).toBe("");
  });
});

describe("importRecentMagaluOrdersForAccount — descarte por status", () => {
  it("status desconhecido: conta, registra o rótulo e loga (antes era continue mudo)", async () => {
    const { createSpy } = setup({
      magaluOrders: [
        { id: "MG-1", status: "aguardando_pagamento", items: [{ sku: "S1" }] },
      ],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(r.skippedByStatus).toBe(1);
    expect(r.skippedStatuses).toEqual(["aguardando_pagamento"]);

    const evento = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("magalu.order.skipped_status"));
    expect(evento).toBeTruthy();
    expect(JSON.parse(evento as string)).toMatchObject({
      event: "magalu.order.skipped_status",
      externalOrderId: "MG-1",
      rawStatus: "aguardando_pagamento",
    });
    logSpy.mockRestore();
  });

  it('status "paid" passa a importar (não estava no vocabulário original)', async () => {
    const { createSpy } = setup({
      magaluOrders: [
        {
          id: "MG-2",
          status: "paid",
          total: 10,
          items: [{ product_id: "L1", quantity: 1, unit_price: 10 }],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(r.imported).toBe(1);
    expect(r.skippedByStatus ?? 0).toBe(0);
  });

  it("status como OBJETO é reconhecido e o pedido entra", async () => {
    const { createSpy } = setup({
      magaluOrders: [
        {
          id: "MG-3",
          status: { type: "approved" },
          total: 20,
          items: [{ product_id: "L1", quantity: 1, unit_price: 20 }],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(r.imported).toBe(1);
  });

  it("pedido cancelado continua sendo descartado (sem criar Order)", async () => {
    const { createSpy } = setup({
      magaluOrders: [{ id: "MG-4", status: "cancelled", items: [] }],
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(r.imported).toBe(0);
    expect(r.skippedByStatus).toBe(1);
  });
});

describe("importRecentMagaluOrdersForAccount — perda de dado vira SystemLog", () => {
  it("nenhum item vinculado: registra erro em SystemLog", async () => {
    const { logError } = setup({
      magaluOrders: [
        { id: "MG-5", status: "approved", items: [{ foo: "sem sku nem id" }] },
      ],
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    expect(r.noProducts).toBe(1);
    const chamada = logError.mock.calls.find((c) =>
      String(c[1]).includes("nao pode ser vinculado"),
    );
    expect(chamada).toBeTruthy();
    expect((chamada as any[])[2].details).toMatchObject({
      externalOrderId: "MG-5",
      platform: "MAGALU",
    });
  });

  it("pedido sem vínculo NÃO regrava o SystemLog a cada ciclo do poll", async () => {
    // Um pedido sem vínculo nunca vira Order, então reaparece em todo ciclo
    // (15 min). Sem dedupe seria um INSERT em SystemLog por ciclo, para
    // sempre, pelo mesmo pedido.
    const pedido = {
      id: "MG-ORFAO-UNICO",
      status: "approved",
      deliveries: [{ items: [{ info: {}, quantity: 1 }] }],
    };
    const { logError } = setup({ magaluOrders: [pedido] });

    const r1 = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );
    const r2 = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    // O contador do resultado continua reportando nas DUAS passagens...
    expect(r1.noProducts).toBe(1);
    expect(r2.noProducts).toBe(1);
    // ...mas o SystemLog é gravado uma única vez.
    const gravacoes = logError.mock.calls.filter((c) =>
      String(c[1]).includes("MG-ORFAO-UNICO"),
    );
    expect(gravacoes).toHaveLength(1);
  });

  it("falha na baixa de estoque: pedido entra, mas o erro vira SystemLog", async () => {
    const { logError, deductSpy } = setup({
      magaluOrders: [
        {
          id: "MG-6",
          status: "approved",
          total: 30,
          items: [{ product_id: "L1", quantity: 1, unit_price: 30 }],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });
    deductSpy.mockRejectedValue(new Error("pool esgotado"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      7,
      true,
    );

    expect(r.imported).toBe(1);
    expect(r.stockDeductions).toBe(0);
    const chamada = logError.mock.calls.find((c) =>
      String(c[1]).includes("SEM baixa de estoque"),
    );
    expect(chamada).toBeTruthy();
    expect((chamada as any[])[2].details).toMatchObject({
      externalOrderId: "MG-6",
      productIds: ["p-1"],
    });
  });

  it("quantidade do item ausente é avisada (baixa de zero, silenciosa antes)", async () => {
    setup({
      magaluOrders: [
        {
          id: "MG-7",
          status: "approved",
          items: [{ product_id: "L1", unit_price: 5 }],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 7, true);

    const evento = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("magalu.order.item_quantity_missing"));
    expect(evento).toBeTruthy();
    warnSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────
// Shape REAL da API, capturado em 28/07/2026 da conta do cliente Ribeiro.
// Os dois pedidos abaixo são as vendas que nunca entraram no sistema.
//
// O que o codigo antigo fazia com isto: lia `order.items` (que NAO existe) →
// items vazio → `no_products` → nenhum Order criado, nenhuma baixa de estoque.
// ──────────────────────────────────────────────────────────
const PEDIDO_REAL_4085 = {
  id: "e12e2e6b-da61-40be-87e7-5492a39e3d33",
  code: "1556570118572354",
  status: "approved",
  purchased_at: "2026-07-25T12:00:00Z",
  amounts: { currency: "BRL", normalizer: 100, total: 19999 },
  customer: { name: "Comprador Teste" },
  deliveries: [
    {
      id: "d-1",
      code: "D1",
      items: [
        {
          sequencial: 1,
          info: {
            sku: "4085",
            id: "37a690c1-8b61-4c68-9c96-dbe7842388a6",
            brand: "Ford",
            name: "Bomba Combustível Ford Fiesta Flex 2004 A 2007",
          },
          unit_price: { currency: "BRL", normalizer: 100, value: 19999 },
          amounts: { currency: "BRL", normalizer: 100, total: 19999 },
          quantity: 1,
        },
      ],
    },
  ],
};

const PEDIDO_REAL_5735 = {
  id: "cdd4de61-53f4-429c-bd62-531e4ceeeb55",
  code: "1556670118624033",
  status: "approved",
  // Total do pedido inclui frete (49,99 + 14,90 = 64,89).
  amounts: { currency: "BRL", normalizer: 100, total: 6489 },
  deliveries: [
    {
      id: "d-2",
      items: [
        {
          sequencial: 1,
          info: { sku: "5735", id: "uuid-5735" },
          unit_price: { currency: "BRL", normalizer: 100, value: 4999 },
          quantity: 1,
        },
      ],
    },
  ],
};

describe("shape REAL da API (pedidos do cliente Ribeiro)", () => {
  it("importa o pedido do SKU 4085 lendo deliveries[].items[].info.sku", async () => {
    const { createSpy, deductSpy } = setup({
      magaluOrders: [PEDIDO_REAL_4085],
      listings: [
        {
          id: "l-4085",
          productId: "p-4085",
          marketplaceAccountId: "acc-mg",
          // O anúncio Magalu é criado com externalListingId = SKU.
          externalListingId: "4085",
          product: { id: "p-4085" },
        },
      ],
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      30,
      true,
    );

    expect(r.imported).toBe(1);
    expect(r.noProducts).toBe(0);
    const pedido = createSpy.mock.calls[0][0] as any;
    expect(pedido.externalOrderId).toBe(
      "e12e2e6b-da61-40be-87e7-5492a39e3d33",
    );
    expect(pedido.status).toBe("PAID");
    // Centavos convertidos: 19999/100.
    expect(pedido.totalAmount).toBe(199.99);
    expect(pedido.items).toEqual([
      {
        productId: "p-4085",
        listingId: "l-4085",
        quantity: 1,
        unitPrice: 199.99,
      },
    ]);
    // E a baixa de estoque acontece.
    expect(deductSpy).toHaveBeenCalledTimes(1);
    expect(r.stockDeductions).toBe(1);
  });

  it("importa o pedido do SKU 5735 e usa o total do pedido (com frete)", async () => {
    const { createSpy } = setup({
      magaluOrders: [PEDIDO_REAL_5735],
      listings: [
        {
          id: "l-5735",
          productId: "p-5735",
          marketplaceAccountId: "acc-mg",
          externalListingId: "5735",
          product: { id: "p-5735" },
        },
      ],
    });

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 30, true);

    const pedido = createSpy.mock.calls[0][0] as any;
    // Item a 49,99; total do pedido 64,89 porque inclui 14,90 de frete.
    expect(pedido.items[0].unitPrice).toBe(49.99);
    expect(pedido.totalAmount).toBe(64.89);
  });

  it("vincula por SKU quando o anúncio não casa por externalListingId", async () => {
    const { createSpy } = setup({
      magaluOrders: [PEDIDO_REAL_4085],
      listings: [],
    });
    vi.spyOn(OrderUseCase as any, "findProductByFallbackSku").mockResolvedValue({
      id: "p-4085",
    });
    vi.spyOn(OrderUseCase as any, "upsertFallbackListing").mockResolvedValue({
      id: "l-novo",
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      30,
      true,
    );

    expect(r.imported).toBe(1);
    expect((createSpy.mock.calls[0][0] as any).items[0].productId).toBe(
      "p-4085",
    );
  });

  it("pedido cancelado real (SKU 8374) continua sendo descartado", async () => {
    const { createSpy } = setup({
      magaluOrders: [
        {
          id: "b44974d3-0b54-45dd-b363-59659c574613",
          code: "1555470118272862",
          status: "cancelled",
          amounts: { normalizer: 100, total: 79995 },
          deliveries: [
            {
              items: [
                {
                  info: { sku: "8374" },
                  unit_price: { normalizer: 100, value: 79995 },
                  quantity: 1,
                },
              ],
            },
          ],
        },
      ],
    });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      30,
      true,
    );

    expect(createSpy).not.toHaveBeenCalled();
    expect(r.skippedByStatus).toBe(1);
  });

  it("nome do comprador vem de customer.name", async () => {
    const { createSpy } = setup({
      magaluOrders: [PEDIDO_REAL_4085],
      listings: [
        {
          id: "l-4085",
          productId: "p-4085",
          marketplaceAccountId: "acc-mg",
          externalListingId: "4085",
          product: { id: "p-4085" },
        },
      ],
    });

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 30, true);

    expect((createSpy.mock.calls[0][0] as any).customerName).toBe(
      "Comprador Teste",
    );
  });
});

describe("importRecentMagaluOrdersForAccount — importar pedido por id", () => {
  it("busca o pedido exato pelo code e mescla com o poll, sem duplicar", async () => {
    const { createSpy } = setup({
      // O poll não devolve o pedido do webhook (fora da janela / além do teto).
      magaluOrders: [],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });
    const byId = vi
      .spyOn(OrderUseCase as any, "getMagaluOrderWithRefresh")
      .mockResolvedValue({
        id: "1556570118572354",
        status: "approved",
        total: 99,
        items: [{ product_id: "L1", quantity: 1, unit_price: 99 }],
      });

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
      { orderIds: ["1556570118572354"] },
    );

    expect(byId).toHaveBeenCalledWith(expect.anything(), "1556570118572354");
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(r.imported).toBe(1);
  });

  it("UUID não gasta requisição: o detalhe só aceita code numérico", async () => {
    // O webhook manda `data.params.id`, que é UUID. O endpoint de detalhe
    // responde 404 para UUID, então buscar seria uma chamada garantidamente
    // inútil — o poll por janela, que já rodou, é quem cobre.
    setup({ magaluOrders: [], listings: [] });
    const byId = vi
      .spyOn(OrderUseCase as any, "getMagaluOrderWithRefresh")
      .mockResolvedValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 2, true, {
      orderIds: ["e12e2e6b-da61-40be-87e7-5492a39e3d33"],
    });

    expect(byId).not.toHaveBeenCalled();
    const evento = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("magalu.order.fetch_by_id_skipped"));
    expect(evento).toBeTruthy();
    logSpy.mockRestore();
  });

  it("não busca por id quando o poll já trouxe o pedido pelo code", async () => {
    setup({
      magaluOrders: [
        {
          id: "uuid-abc",
          code: "1556570118572354",
          status: "approved",
          amounts: { normalizer: 100, total: 100 },
          deliveries: [
            {
              items: [
                {
                  info: { sku: "L1" },
                  quantity: 1,
                  unit_price: { normalizer: 100, value: 100 },
                },
              ],
            },
          ],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });
    const byId = vi
      .spyOn(OrderUseCase as any, "getMagaluOrderWithRefresh")
      .mockResolvedValue(null);

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 2, true, {
      orderIds: ["1556570118572354"],
    });

    expect(byId).not.toHaveBeenCalled();
  });

  it("não busca por id o pedido que o poll já trouxe", async () => {
    setup({
      magaluOrders: [
        {
          id: "MG-JA",
          status: "approved",
          total: 1,
          items: [{ product_id: "L1", quantity: 1, unit_price: 1 }],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });
    const byId = vi
      .spyOn(OrderUseCase as any, "getMagaluOrderWithRefresh")
      .mockResolvedValue(null);

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 2, true, {
      orderIds: ["MG-JA"],
    });

    expect(byId).not.toHaveBeenCalled();
  });

  it("falha ao buscar um id não derruba o ciclo", async () => {
    const { createSpy } = setup({
      magaluOrders: [
        {
          id: "MG-OK",
          status: "approved",
          total: 1,
          items: [{ product_id: "L1", quantity: 1, unit_price: 1 }],
        },
      ],
      listings: [
        {
          id: "l-1",
          productId: "p-1",
          marketplaceAccountId: "acc-mg",
          externalListingId: "L1",
          product: { id: "p-1" },
        },
      ],
    });
    vi.spyOn(OrderUseCase as any, "getMagaluOrderWithRefresh").mockRejectedValue(
      new Error("404"),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
      { orderIds: ["1555470118272862"] },
    );

    expect(r.imported).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const evento = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("magalu.order.fetch_by_id_failed"));
    expect(evento).toBeTruthy();
    warnSpy.mockRestore();
  });
});

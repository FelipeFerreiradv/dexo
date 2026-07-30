import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Auditoria adversarial de 29/07/2026 — três achados da janela de busca Shopee.
//
// 1. (ALTA) A janela era clampada em `now - 15d` e a marca d'água avançava para
//    "agora" de qualquer forma. A API rejeita INTERVALOS maiores que 15 dias,
//    mas aceita `time_to` no passado — então o certo é varrer em BLOCOS de 15
//    dias, como o script de recuperação já fazia. Com o clamp, uma parada longa
//    deixava um período sem leitura e a marca d'água declarava esse período
//    sincronizado: perda permanente, sem quarentena e com SyncLog SUCCESS.
//
// 2. (ALTA) A busca dirigida por `order_sn` somava a varredura da janela ao
//    `get_order_detail` dirigido. Cada re-tentativa de pendência fazia um
//    `get_order_list` paginado + detalhes de tudo na janela + releitura de TODOS
//    os ProductListing da conta. Com 89 pendências abertas em produção e o
//    backoff no teto de 1h, ~22x o tráfego de import — para sempre. E ainda
//    avançava a marca d'água sem ter varrido a janela.
//
// 3. (MEDIA) `order_sn` que a listagem devolvia mas cujo detalhe não voltava
//    desaparecia sem contador, sem quarentena e sem afetar o veredito do ciclo.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import prisma from "@/app/lib/prisma";

const DIA = 24 * 60 * 60;

const ACC = {
  id: "acc-1",
  userId: "owner-1",
  accessToken: "token",
  refreshToken: "refresh",
  shopId: 123,
};

let flagAnterior: string | undefined;

beforeEach(() => {
  flagAnterior = process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;
  delete process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;

  vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  vi.spyOn(prisma.marketplaceAccount, "update").mockResolvedValue({} as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (flagAnterior === undefined) {
    delete process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;
  } else {
    process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED = flagAnterior;
  }
});

describe("getRecentOrders — varredura em blocos de 15 dias", () => {
  it("janela de 7 dias usa UM bloco só", async () => {
    const list = vi
      .spyOn(ShopeeApiService as any, "getOrderList")
      .mockResolvedValue({ order_list: [], more: false });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    await ShopeeApiService.getRecentOrders("t", 123, 7, {
      timeRangeField: "update_time",
    });

    expect(list).toHaveBeenCalledTimes(1);
  });

  it("janela de 40 dias é varrida em 3 blocos CONTÍGUOS, sem buraco", async () => {
    const list = vi
      .spyOn(ShopeeApiService as any, "getOrderList")
      .mockResolvedValue({ order_list: [], more: false });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    const agora = Math.floor(Date.now() / 1000);
    const pedidoDesde = agora - 40 * DIA;

    await ShopeeApiService.getRecentOrders("t", 123, 3, {
      timeFrom: pedidoDesde,
      timeRangeField: "update_time",
    });

    // 40 dias / 15 = 3 blocos (15 + 15 + 10).
    expect(list).toHaveBeenCalledTimes(3);

    const janelas = list.mock.calls.map((c: any[]) => ({
      from: c[2].time_from,
      to: c[2].time_to,
    }));

    // Nenhum intervalo pode ficar de fora: o `to` de um bloco é o `from` do
    // anterior. Era exatamente o buraco que o clamp abria.
    for (const j of janelas) {
      expect(j.to - j.from).toBeLessThanOrEqual(
        ShopeeApiService.ORDER_LIST_MAX_WINDOW_DAYS * DIA,
      );
    }
    const ordenadas = [...janelas].sort((a, b) => a.from - b.from);
    for (let i = 1; i < ordenadas.length; i++) {
      expect(ordenadas[i].from).toBe(ordenadas[i - 1].to);
    }
    expect(ordenadas[0].from).toBe(pedidoDesde);
    expect(ordenadas[ordenadas.length - 1].to).toBeGreaterThanOrEqual(agora - 5);
  });

  it("acima do teto de blocos avisa o período que ficou de fora", async () => {
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [],
      more: false,
    });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    const truncado: Array<{ desdeSec: number; ateSec: number }> = [];
    const agora = Math.floor(Date.now() / 1000);

    await ShopeeApiService.getRecentOrders("t", 123, 3, {
      // 200 dias: muito além de 6 blocos (90 dias).
      timeFrom: agora - 200 * DIA,
      timeRangeField: "update_time",
      onWindowTruncated: (info) => truncado.push(info),
    });

    // Truncar em silêncio é o que o invariante proíbe.
    expect(truncado).toHaveLength(1);
    expect(truncado[0].desdeSec).toBeLessThan(truncado[0].ateSec);
  });

  it("pedido repetido na borda de dois blocos é buscado uma vez só", async () => {
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [{ order_sn: "SN-BORDA" }],
      more: false,
    });
    const details = vi
      .spyOn(ShopeeApiService as any, "getOrderDetails")
      .mockResolvedValue([]);

    const agora = Math.floor(Date.now() / 1000);
    await ShopeeApiService.getRecentOrders("t", 123, 3, {
      timeFrom: agora - 40 * DIA,
      timeRangeField: "update_time",
    });

    expect(details).toHaveBeenCalledTimes(1);
    expect(details.mock.calls[0][2]).toEqual(["SN-BORDA"]);
  });

  it("order_sn listado sem detalhe é reportado, não desaparece", async () => {
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [{ order_sn: "SN-COM" }, { order_sn: "SN-SEM" }],
      more: false,
    });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([
      { order_sn: "SN-COM", order_status: "SHIPPED" },
    ]);

    const faltando: string[] = [];
    await ShopeeApiService.getRecentOrders("t", 123, 7, {
      timeRangeField: "update_time",
      statusFilter: "exclude_non_sale",
      onDetailMissing: (sns) => faltando.push(...sns),
    });

    expect(faltando).toEqual(["SN-SEM"]);
  });
});

describe("marca d'água só avança quando a janela foi realmente varrida", () => {
  beforeEach(() => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      ...ACC,
      shopeeOrdersSyncedThrough: new Date(Date.now() - 60 * 60 * 1000),
    } as any);
  });

  it("ciclo limpo da janela AVANÇA a marca d'água", async () => {
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [],
      more: false,
    });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, false);

    expect(prisma.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "acc-1" },
        data: { shopeeOrdersSyncedThrough: expect.any(Date) },
      }),
    );
  });

  it("busca DIRIGIDA não varre a janela e NÃO avança a marca d'água", async () => {
    const list = vi
      .spyOn(ShopeeApiService as any, "getOrderList")
      .mockResolvedValue({ order_list: [], more: false });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 1, false, {
      orderSns: ["SN-DIRIGIDO"],
    });

    // O ganho de custo: nenhuma listagem paginada.
    expect(list).not.toHaveBeenCalled();
    // E a honestidade: não varreu a janela, não pode declará-la sincronizada.
    expect(prisma.marketplaceAccount.update).not.toHaveBeenCalled();
  });

  it("busca dirigida pede o detalhe SÓ dos order_sn informados", async () => {
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [],
      more: false,
    });
    const details = vi
      .spyOn(ShopeeApiService as any, "getOrderDetails")
      .mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 1, false, {
      orderSns: ["SN-A", "SN-B"],
    });

    expect(details).toHaveBeenCalledTimes(1);
    expect(details.mock.calls[0][2]).toEqual(["SN-A", "SN-B"]);
  });

  it("janela truncada NÃO avança a marca d'água", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      ...ACC,
      // Marca d'água de 200 dias atrás: além do teto de blocos.
      shopeeOrdersSyncedThrough: new Date(Date.now() - 200 * DIA * 1000),
    } as any);
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [],
      more: false,
    });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, false);

    // Antes: marca d'água ia para "agora" e o intervalo não lido virava perda
    // permanente.
    expect(prisma.marketplaceAccount.update).not.toHaveBeenCalled();
  });

  it("detalhe faltando conta como erro e travar a marca d'água", async () => {
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [{ order_sn: "SN-SEM" }],
      more: false,
    });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    const r = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-1",
      7,
      false,
    );

    expect(r.errors).toBeGreaterThan(0);
    expect(prisma.marketplaceAccount.update).not.toHaveBeenCalled();
  });
});

describe("busca dirigida não relê o catálogo da conta", () => {
  // Achado ALTA de egress (30/07/2026): a ingestão dirigida de UM pedido montava
  // o listingMap lendo TODOS os ProductListing da conta. Numa conta de produção
  // com 11.670 anúncios são ~1,6 MB de egress por chamada, contra 1-2 findUnique
  // por id no caminho de fallback — que produz o MESMO resultado.
  beforeEach(() => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(ACC as any);
  });

  it("com orderSns NÃO lê ProductListing da conta", async () => {
    const listings = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([]);

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 1, false, {
      orderSns: ["SN-DIRIGIDO"],
    });

    expect(listings).not.toHaveBeenCalled();
  });

  it("no poll em lote CONTINUA lendo (o mapa evita N+1 ali)", async () => {
    const listings = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);
    vi.spyOn(ShopeeApiService as any, "getOrderList").mockResolvedValue({
      order_list: [{ order_sn: "SN-NOVO" }],
      more: false,
    });
    vi.spyOn(ShopeeApiService as any, "getOrderDetails").mockResolvedValue([
      {
        order_sn: "SN-NOVO",
        order_status: "COMPLETED",
        total_amount: 10,
        create_time: 1783000000,
        item_list: [{ item_id: 1, item_sku: "X", model_quantity_purchased: 1 }],
      },
    ]);
    // Sem isto a cadeia de vinculo iria ao banco de verdade: o objetivo aqui e
    // so afirmar que o prefetch continua acontecendo no caminho em lote.
    vi.spyOn(OrderUseCase as any, "ingestShopeeOrder").mockResolvedValue({
      success: true,
      orderId: "o1",
      externalOrderId: "SN-NOVO",
      status: "imported",
      message: "",
      stockDeducted: false,
      itemsLinked: 1,
      itemsTotal: 1,
    });

    await OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, false);

    // O ganho é só no caminho dirigido: o poll segue prefetchando.
    expect(listings).toHaveBeenCalled();
  });
});

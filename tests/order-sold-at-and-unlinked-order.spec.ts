import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Dois defeitos medidos em produção em 29/07/2026.
//
// 1. VENDA QUE NÃO VIRA PEDIDO
//    89 vendas concretizadas da Shopee, de 3 tenants (26 de um só cliente em 12
//    dias), presas na quarentena e sem existir como Order. Logo: fora de
//    /pedidos, fora do Financeiro, fora do Dashboard. O faturamento do cliente
//    ficava incompleto.
//    Investigação contra o banco real: o produto de fato NÃO existe no Dexo —
//    item_id, SKU exato, skuNormalized e partNumber, todos zero, num tenant com
//    28.910 produtos. Então não há estoque a baixar. Mas a VENDA existe, e o
//    invariante manda ela virar Order.
//    Agora: Order com ZERO itens, carregando o valor. A pendência fica aberta
//    para a parte do estoque e o reconciliador fecha sozinho quando o cliente
//    cadastrar o produto.
//
// 2. DATA DA VENDA NÃO EXISTIA
//    `OrderRepositoryPrisma.create` nunca passava `createdAt`, então caía no
//    `default(now())` — a hora do IMPORT. E Dashboard e Financeiro filtram por
//    ela. Com o ciclo de sync levando até 71,9 h, vendas eram datadas com até 3
//    dias de atraso, atravessando virada de mês. `Order` não tinha nenhum campo
//    de data de venda.
//    Agora: `soldAt`, preenchido do marketplace, e todo filtro por
//    COALESCE(soldAt, createdAt) — o histórico (soldAt NULL) não muda.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";
import { orderRepository } from "@/app/repositories/order.repository";

const resolver = (v: any) => (OrderUseCase as any).resolveSoldAt(v);

const guardadas: Record<string, string | undefined> = {};
const NOMES = [
  "ORDER_SOLD_AT_DISABLED",
  "ORDER_CREATE_WITHOUT_ITEMS_DISABLED",
];

beforeEach(() => {
  for (const n of NOMES) {
    guardadas[n] = process.env[n];
    delete process.env[n];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const n of NOMES) {
    if (guardadas[n] === undefined) delete process.env[n];
    else process.env[n] = guardadas[n]!;
  }
});

describe("resolveSoldAt — cada marketplace num formato diferente", () => {
  it("Shopee: epoch em SEGUNDOS", () => {
    // 1783000000 s = 2026-07-30T... Se fosse tratado como ms, daria 1970.
    const d = resolver(1783000000);
    expect(d).toBeInstanceOf(Date);
    expect(d!.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("ML: ISO 8601 com offset", () => {
    const d = resolver("2026-07-15T13:45:00.000-03:00");
    expect(d!.toISOString()).toBe("2026-07-15T16:45:00.000Z");
  });

  it("Magalu: ISO 8601 em UTC", () => {
    const d = resolver("2026-07-15T16:45:00Z");
    expect(d!.toISOString()).toBe("2026-07-15T16:45:00.000Z");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string vazia", ""],
    ["texto qualquer", "ontem"],
    ["zero", 0],
    ["negativo", -1],
    ["NaN", Number.NaN],
  ])("%s devolve null (cai no createdAt)", (_n, v) => {
    expect(resolver(v)).toBeNull();
  });

  it("data absurdamente antiga devolve null", () => {
    // Mais provável bug de parsing do que venda de 1970.
    expect(resolver("1970-01-01T00:00:00Z")).toBeNull();
  });

  it("data absurdamente futura devolve null", () => {
    expect(resolver("2999-01-01T00:00:00Z")).toBeNull();
  });

  it("kill-switch ORDER_SOLD_AT_DISABLED=1 devolve sempre null", () => {
    process.env.ORDER_SOLD_AT_DISABLED = "1";
    expect(resolver(1783000000)).toBeNull();
    expect(resolver("2026-07-15T16:45:00Z")).toBeNull();
  });
});

describe("venda sem item vinculado vira Order com zero itens", () => {
  const PEDIDO = {
    order_sn: "SN-SEM-PRODUTO",
    order_status: "COMPLETED",
    total_amount: 149.9,
    create_time: 1783000000,
    buyer_username: "comprador",
    item_list: [{ item_id: 58250609910, item_sku: "68385", model_quantity_purchased: 1 }],
  };

  beforeEach(() => {
    vi.spyOn(OrderIngestionIssueService, "open").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [],
      linkedCount: 0,
      unlinked: [
        { itemId: "58250609910", sku: "68385", reason: "PRODUCT_NOT_FOUND" },
      ],
    });
  });

  it("cria o Order com o valor da venda e NENHUM item", async () => {
    const create = vi
      .spyOn(orderRepository, "create")
      .mockResolvedValue({ id: "order-novo" } as any);

    const r = await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const dados = create.mock.calls[0][0] as any;
    expect(dados.items).toEqual([]);
    expect(dados.totalAmount).toBe(149.9);
    expect(dados.externalOrderId).toBe("SN-SEM-PRODUTO");
    // A venda passa a existir em /pedidos, no Financeiro e no Dashboard.
    expect(r.orderId).toBe("order-novo");
  });

  it("grava soldAt da data da venda, não da hora do import", async () => {
    const create = vi
      .spyOn(orderRepository, "create")
      .mockResolvedValue({ id: "order-novo" } as any);

    await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    const dados = create.mock.calls[0][0] as any;
    expect(dados.soldAt).toBeInstanceOf(Date);
    expect(dados.soldAt.getTime()).toBe(1783000000 * 1000);
  });

  it("NUNCA reporta baixa de estoque (não há produto para baixar)", async () => {
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-novo",
    } as any);
    const deduz = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const r = await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    expect(deduz).not.toHaveBeenCalled();
    // `stockDeducted: true` aqui seria mentira e faria o ciclo virar SUCCESS.
    expect(r.stockDeducted).toBe(false);
    expect(r.status).toBe("no_products");
  });

  it("abre a pendência COM o orderId, para o reconciliador achar o pedido", async () => {
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-novo",
    } as any);

    await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    expect(OrderIngestionIssueService.open).toHaveBeenCalledTimes(1);
    expect(
      (OrderIngestionIssueService.open as any).mock.calls[0][0],
    ).toMatchObject({ reason: "NO_LINKED_ITEMS", orderId: "order-novo" });
  });

  it("P2002 (outro caminho criou o mesmo pedido) não vira erro", async () => {
    vi.spyOn(orderRepository, "create").mockRejectedValue(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );

    const r = await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    // O @@unique fez o trabalho; a pendência ainda é registrada.
    expect(r.status).toBe("no_products");
    expect(OrderIngestionIssueService.open).toHaveBeenCalledTimes(1);
  });

  it("falha ao criar o Order não impede o registro da pendência", async () => {
    vi.spyOn(orderRepository, "create").mockRejectedValue(
      new Error("banco fora"),
    );

    const r = await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    // Perder o Order é ruim; perder o RASTRO é o que o invariante proíbe.
    expect(OrderIngestionIssueService.open).toHaveBeenCalledTimes(1);
    expect(r.orderId).toBeNull();
  });

  it("kill-switch ORDER_CREATE_WITHOUT_ITEMS_DISABLED=1 volta a não criar Order", async () => {
    process.env.ORDER_CREATE_WITHOUT_ITEMS_DISABLED = "1";
    const create = vi.spyOn(orderRepository, "create");

    const r = await OrderUseCase.ingestShopeeOrder("acc-1", PEDIDO as any, {
      userId: "dono-1",
      deductStock: true,
      alreadyExists: false,
    });

    expect(create).not.toHaveBeenCalled();
    expect(r.orderId).toBeNull();
    // A pendência continua sendo aberta — isso nunca dependeu da flag.
    expect(OrderIngestionIssueService.open).toHaveBeenCalledTimes(1);
  });
});

describe("pedido COM itens também grava soldAt", () => {
  it("Shopee: create_time vira soldAt", async () => {
    vi.spyOn(OrderIngestionIssueService, "resolve").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [{ productId: "p1", listingId: "l1", quantity: 1, unitPrice: 149.9 }],
      linkedCount: 1,
      unlinked: [],
    });
    const create = vi
      .spyOn(orderRepository, "create")
      .mockResolvedValue({ id: "order-1", items: [] } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);

    await OrderUseCase.ingestShopeeOrder(
      "acc-1",
      {
        order_sn: "SN-OK",
        order_status: "COMPLETED",
        total_amount: 149.9,
        create_time: 1783000000,
        item_list: [
          { item_id: 1, item_sku: "X", model_quantity_purchased: 1 },
        ],
      } as any,
      { userId: "dono-1", deductStock: true, alreadyExists: false },
    );

    const dados = create.mock.calls[0][0] as any;
    expect(dados.soldAt.getTime()).toBe(1783000000 * 1000);
  });
});

describe("filtro de período usa COALESCE(soldAt, createdAt)", () => {
  const DE = new Date("2026-07-01T00:00:00Z");
  const ATE = new Date("2026-07-31T23:59:59Z");

  async function whereDeFindAllForList(): Promise<any> {
    const prisma = (await import("@/app/lib/prisma")).default;
    const findMany = vi
      .spyOn(prisma.order, "findMany")
      .mockResolvedValue([] as any);
    vi.spyOn(prisma.order, "count").mockResolvedValue(0 as any);

    await orderRepository.findAllForList({
      dateFrom: DE,
      dateTo: ATE,
      search: "joao",
    } as any);

    return (findMany.mock.calls[0][0] as any).where;
  }

  it("pedido com soldAt é filtrado por soldAt; sem soldAt, por createdAt", async () => {
    const where = await whereDeFindAllForList();

    expect(where.AND).toEqual([
      {
        OR: [
          { soldAt: { gte: DE, lte: ATE } },
          { soldAt: null, createdAt: { gte: DE, lte: ATE } },
        ],
      },
    ]);
    // Antes o período ia em `where.createdAt` direto.
    expect(where.createdAt).toBeUndefined();
  });

  it("não atropela o OR da busca textual", async () => {
    const where = await whereDeFindAllForList();

    // O filtro vai em AND de propósito: escrever em `where.OR` faria a busca
    // por nome ignorar o período (ou vice-versa).
    expect(where.OR).toEqual([
      { customerName: { contains: "joao", mode: "insensitive" } },
      { externalOrderId: { contains: "joao", mode: "insensitive" } },
    ]);
  });

  it("kill-switch ORDER_SOLD_AT_DISABLED=1 volta a filtrar só por createdAt", async () => {
    process.env.ORDER_SOLD_AT_DISABLED = "1";
    const where = await whereDeFindAllForList();

    expect(where.createdAt).toEqual({ gte: DE, lte: ATE });
    expect(where.AND).toBeUndefined();
  });

  it("sem período nenhum não adiciona filtro de data", async () => {
    const prisma = (await import("@/app/lib/prisma")).default;
    const findMany = vi
      .spyOn(prisma.order, "findMany")
      .mockResolvedValue([] as any);
    vi.spyOn(prisma.order, "count").mockResolvedValue(0 as any);

    await orderRepository.findAllForList({} as any);

    const where = (findMany.mock.calls[0][0] as any).where;
    expect(where.AND).toBeUndefined();
    expect(where.createdAt).toBeUndefined();
  });
});

describe("criarOrderSemItens — helper compartilhado pelos 3 marketplaces", () => {
  const base = {
    marketplaceAccountId: "acc-1",
    externalOrderId: "EXT-1",
    status: "PAID" as any,
    totalAmount: 99.5,
    customerName: "cliente",
    soldAt: new Date("2026-07-15T10:00:00Z"),
    itemsTotal: 2,
  };
  const criar = (over: any = {}) =>
    (OrderUseCase as any).criarOrderSemItens({ ...base, ...over });

  it("SHOPEE cria o Order com items vazio e devolve o id", async () => {
    const create = vi
      .spyOn(orderRepository, "create")
      .mockResolvedValue({ id: "order-x" } as any);

    const id = await criar({ plataforma: "SHOPEE" });

    expect(id).toBe("order-x");
    const dados = create.mock.calls[0][0] as any;
    expect(dados.items).toEqual([]);
    expect(dados.totalAmount).toBe(99.5);
    expect(dados.soldAt).toEqual(base.soldAt);
  });

  it.each(["MERCADO_LIVRE", "MAGALU"] as const)(
    "%s NAO cria Order vazio — nao existe caminho para completa-lo depois",
    async (plataforma) => {
      const create = vi.spyOn(orderRepository, "create");

      // O Order vazio e metade de um par. A outra metade
      // (`completePartialShopeeOrder`) so existe na Shopee; sem ela o
      // `exists()` passa a devolver true, o import responde `already_exists` e a
      // venda fica permanentemente incompleta. A quarentena continua
      // registrando — o invariante nao e furado.
      expect(await criar({ plataforma })).toBeNull();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("kill-switch=1 não chega a chamar o repositório", async () => {
    process.env.ORDER_CREATE_WITHOUT_ITEMS_DISABLED = "1";
    const create = vi.spyOn(orderRepository, "create");

    expect(await criar({ plataforma: "SHOPEE" })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("P2002 devolve null sem lançar (o @@unique fez o trabalho)", async () => {
    vi.spyOn(orderRepository, "create").mockRejectedValue(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );

    await expect(criar({ plataforma: "SHOPEE" })).resolves.toBeNull();
  });

  it("erro qualquer devolve null sem lançar", async () => {
    // Perder o Order é ruim; derrubar o laço de import e perder os OUTROS
    // pedidos do ciclo seria pior.
    vi.spyOn(orderRepository, "create").mockRejectedValue(
      new Error("banco fora"),
    );

    await expect(criar({ plataforma: "SHOPEE" })).resolves.toBeNull();
  });
});

describe("ML: venda sem produto NAO cria Order vazio (mas fica na quarentena)", () => {
  const ML_ORDER = {
    id: 2000000123,
    status: "paid",
    total_amount: 250.4,
    date_created: "2026-07-10T09:30:00.000-03:00",
    order_items: [
      { item: { id: "MLB1", seller_sku: "ABC" }, quantity: 1, unit_price: 250.4 },
    ],
    buyer: { nickname: "comprador" },
  };

  beforeEach(() => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false as any);
    vi.spyOn(OrderUseCase as any, "mapOrderItems").mockResolvedValue({
      items: [],
      linkedCount: 0,
    });
  });

  it("devolve no_products sem orderId e sem criar nada", async () => {
    const create = vi.spyOn(orderRepository, "create");

    const r = await (OrderUseCase as any).processOrder(
      ML_ORDER,
      "acc-ml",
      true,
      undefined,
      "dono-1",
    );

    // O Order vazio no ML seria armadilha: `exists()` viraria true e o import
    // seguinte responderia `already_exists` para sempre, sem nunca acrescentar
    // os itens. Quem registra a venda e a quarentena (aberta pelo chamador).
    expect(r.status).toBe("no_products");
    expect(r.orderId).toBeNull();
    expect(r.stockDeducted).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("quarentena NO_LINKED_ITEMS leva o orderId", () => {
  it("sem o orderId o reconciliador não acha o pedido para completar", async () => {
    delete process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED;
    const abrir = vi
      .spyOn(OrderIngestionIssueService, "open")
      .mockResolvedValue(undefined as any);

    await (OrderUseCase as any).registrarDesfechoIngestao({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: {
        success: false,
        orderId: "order-ml",
        externalOrderId: "ML-1",
        status: "no_products",
        message: "",
        stockDeducted: false,
        itemsLinked: 0,
        itemsTotal: 1,
      },
      esperavaBaixa: true,
    });

    expect(abrir.mock.calls[0][0]).toMatchObject({
      reason: "NO_LINKED_ITEMS",
      orderId: "order-ml",
    });
    process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED = "1";
  });
});

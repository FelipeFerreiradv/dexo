import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// A OUTRA METADE do Order sem itens — medido em produção em 30/07/2026.
//
// O pedido de zero itens registra a venda (valor, data, visibilidade em
// /pedidos, no Financeiro e no Dashboard) mas, por construção, faz
// `orderRepository.exists()` devolver true. A partir daí o poll respondia
// `already_exists` e NUNCA mais revisitava o pedido: quando o cliente cadastrava
// o produto que faltava, nada acontecia. Venda no faturamento pelo valor, sem
// baixa de estoque, para sempre.
//
// Números do banco de produção:
//  - 84 pedidos do ML com zero itens, R$ 27.731,47, de 8 tenants;
//  - 77 deles com a pendência FECHADA em falso (a regressão do
//    `retryStockDeduction` que devolvia true para pedido sem itens);
//  - 90 pedidos da Shopee com zero itens, pendência OPEN.
//
// Na Shopee havia meia solução: o reconciliador re-buscava o pedido por
// `order_sn` (`completePartialShopeeOrder`). Mas ela vale só enquanto a
// pendência está OPEN — ao esgotar as tentativas ela vira NEEDS_ACTION, sai da
// fila automática (`runOnce` filtra status OPEN) e a partir daí o cliente
// cadastrar o produto também não completava mais nada.
//
// A correção: ANTES de tratar o pedido como "já importado", o poll verifica se o
// Order local está sem item nenhum e, se estiver, completa com o payload que
// acabou de buscar. Nenhuma chamada externa a mais — o pedido já veio na
// varredura.
//
// O que estes testes provam:
//  1. a consulta que descobre os vazios filtra por zero itens E exclui
//     cancelado, e nem acontece com o kill-switch ligado;
//  2. pedido vazio completado baixa estoque passando o ENUM da plataforma (é o
//     `rotuloDaPlataforma` que evita a `reason` inexistente e a baixa dupla);
//  3. pedido vazio que continua sem vínculo NÃO fecha pendência — devolve
//     `no_products`, que rebaixa o ciclo para WARNING;
//  4. corrida (outro processo inseriu primeiro) não conta desfecho novo;
//  5. o laço do ML completa em vez de pular, e conta como perda quando o
//     produto continua fora do Dexo.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import prisma from "@/app/lib/prisma";

const UC = OrderUseCase as any;

const guardadas: Record<string, string | undefined> = {};
const NOMES = [
  "ORDER_COMPLETE_EMPTY_ORDER_DISABLED",
  "ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED",
  "ORDER_INGESTION_ISSUES_DISABLED",
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

describe("pedidosVaziosNaJanela — quais pedidos existentes estão sem item", () => {
  it("filtra por ZERO itens e exclui cancelado", async () => {
    const findMany = vi
      .spyOn(prisma.order, "findMany")
      .mockResolvedValue([
        { id: "o-1", externalOrderId: "EXT-1" },
      ] as never);

    const mapa = await UC.pedidosVaziosNaJanela("acc-1", ["EXT-1", "EXT-2"]);

    expect(mapa.get("EXT-1")).toBe("o-1");
    expect(mapa.has("EXT-2")).toBe(false);
    const where = (findMany.mock.calls[0][0] as any).where;
    // Sem `items: { none: {} }` a consulta traria TODO pedido da janela e o
    // caminho de completar rodaria sobre pedido completo.
    expect(where.items).toEqual({ none: {} });
    // Pedido cancelado não tem venda a completar nem estoque a baixar.
    expect(where.status).toEqual({ not: "CANCELLED" });
    expect(where.marketplaceAccountId).toBe("acc-1");
    expect(where.externalOrderId).toEqual({ in: ["EXT-1", "EXT-2"] });
  });

  it("kill-switch ligado NÃO faz a consulta (caminho byte-idêntico ao anterior)", async () => {
    process.env.ORDER_COMPLETE_EMPTY_ORDER_DISABLED = "1";
    const findMany = vi.spyOn(prisma.order, "findMany");

    const mapa = await UC.pedidosVaziosNaJanela("acc-1", ["EXT-1"]);

    expect(findMany).not.toHaveBeenCalled();
    expect(mapa.size).toBe(0);
  });

  it("lista de ids vazia não faz consulta", async () => {
    const findMany = vi.spyOn(prisma.order, "findMany");
    const mapa = await UC.pedidosVaziosNaJanela("acc-1", []);
    expect(findMany).not.toHaveBeenCalled();
    expect(mapa.size).toBe(0);
  });

  it("falha na consulta devolve mapa vazio e não propaga", async () => {
    vi.spyOn(prisma.order, "findMany").mockRejectedValue(
      new Error("banco fora"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const mapa = await UC.pedidosVaziosNaJanela("acc-1", ["EXT-1"]);

    // Falhar aqui só faz o ciclo se comportar como antes da correção.
    expect(mapa.size).toBe(0);
  });
});

describe("completarOrderSemItens", () => {
  const ITENS = [
    { productId: "p1", listingId: "l1", quantity: 2, unitPrice: 10 },
  ];

  beforeEach(() => {
    vi.spyOn(UC, "registrarDesfechoIngestao").mockResolvedValue(undefined);
    vi.spyOn(OrderIngestionIssueService, "open").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(OrderIngestionIssueService, "resolve").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("acrescenta os itens e baixa o estoque passando o ENUM da plataforma", async () => {
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(1);
    const baixa = vi.spyOn(UC, "retryStockDeduction").mockResolvedValue(true);

    const r = await UC.completarOrderSemItens({
      plataforma: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "2000017658297096",
      orderId: "o-1",
      itens: ITENS,
      itemsTotal: 1,
      esperavaBaixa: true,
    });

    // O ENUM, não o rótulo: é `rotuloDaPlataforma` dentro de
    // `retryStockDeduction` que traduz para "Venda ML #id". Passar
    // "MERCADO_LIVRE" adiante sem tradução era a baixa DUPLA.
    expect(baixa).toHaveBeenCalledWith(
      "o-1",
      "MERCADO_LIVRE",
      "2000017658297096",
    );
    expect(r.status).toBe("imported");
    expect(r.stockDeducted).toBe(true);
    expect(r.itemsLinked).toBe(1);
    expect(r.orderId).toBe("o-1");
  });

  it("não baixa estoque quando a baixa não era esperada", async () => {
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(1);
    const baixa = vi.spyOn(UC, "retryStockDeduction").mockResolvedValue(true);

    const r = await UC.completarOrderSemItens({
      plataforma: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "EXT-1",
      orderId: "o-1",
      itens: ITENS,
      itemsTotal: 1,
      esperavaBaixa: false,
    });

    expect(baixa).not.toHaveBeenCalled();
    expect(r.stockDeducted).toBe(false);
  });

  it("sem item vinculado devolve no_products e NUNCA fecha a pendência", async () => {
    const acrescenta = vi.spyOn(UC, "acrescentarItensAoPedido");
    const baixa = vi.spyOn(UC, "retryStockDeduction");

    const r = await UC.completarOrderSemItens({
      plataforma: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "EXT-1",
      orderId: "o-1",
      itens: [],
      itemsTotal: 2,
      esperavaBaixa: true,
    });

    expect(acrescenta).not.toHaveBeenCalled();
    expect(baixa).not.toHaveBeenCalled();
    expect(r.status).toBe("no_products");
    expect(r.orderId).toBe("o-1");
    // Quem decide a pendência de ML/Magalu é o `registrarDesfechoIngestao`, e
    // com `no_products` ele ABRE NO_LINKED_ITEMS. Fechar aqui era o estado
    // terminal silencioso que o invariante proíbe.
    expect(OrderIngestionIssueService.resolve).not.toHaveBeenCalled();
    expect(UC.registrarDesfechoIngestao).toHaveBeenCalledTimes(1);
    expect(
      (UC.registrarDesfechoIngestao as any).mock.calls[0][0].resultado.status,
    ).toBe("no_products");
  });

  it("corrida (outro processo inseriu primeiro) não conta desfecho novo", async () => {
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(0);
    const baixa = vi.spyOn(UC, "retryStockDeduction");

    const r = await UC.completarOrderSemItens({
      plataforma: "MAGALU",
      marketplaceAccountId: "acc-1",
      externalOrderId: "EXT-1",
      orderId: "o-1",
      itens: ITENS,
      itemsTotal: 1,
      esperavaBaixa: true,
    });

    expect(r.status).toBe("already_exists");
    expect(baixa).not.toHaveBeenCalled();
    expect(UC.registrarDesfechoIngestao).not.toHaveBeenCalled();
  });

  it("Shopee completa e com baixa: FECHA a pendência", async () => {
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(1);
    vi.spyOn(UC, "retryStockDeduction").mockResolvedValue(true);

    await UC.completarOrderSemItens({
      plataforma: "SHOPEE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "SN-1",
      orderId: "o-1",
      itens: ITENS,
      itemsTotal: 1,
      esperavaBaixa: true,
      payload: { order_sn: "SN-1" },
    });

    expect(OrderIngestionIssueService.resolve).toHaveBeenCalledWith(
      "acc-1",
      "SN-1",
      "o-1",
    );
    // A árvore da Shopee é a própria, não a de ML/Magalu.
    expect(UC.registrarDesfechoIngestao).not.toHaveBeenCalled();
  });

  it("Shopee sem baixa: abre STOCK_DEDUCTION_FAILED com o payload", async () => {
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(1);
    vi.spyOn(UC, "retryStockDeduction").mockResolvedValue(false);

    await UC.completarOrderSemItens({
      plataforma: "SHOPEE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "SN-1",
      orderId: "o-1",
      itens: ITENS,
      itemsTotal: 1,
      esperavaBaixa: true,
      payload: { order_sn: "SN-1" },
    });

    expect(OrderIngestionIssueService.resolve).not.toHaveBeenCalled();
    expect(
      (OrderIngestionIssueService.open as any).mock.calls[0][0],
    ).toMatchObject({
      reason: "STOCK_DEDUCTION_FAILED",
      orderId: "o-1",
      platform: "SHOPEE",
    });
  });

  it("Shopee parcial: abre PARTIAL_LINK, não fecha", async () => {
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(1);
    vi.spyOn(UC, "retryStockDeduction").mockResolvedValue(true);

    await UC.completarOrderSemItens({
      plataforma: "SHOPEE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "SN-1",
      orderId: "o-1",
      itens: ITENS,
      itemsTotal: 3,
      esperavaBaixa: true,
      payload: { order_sn: "SN-1" },
      detalheSemVinculo: "item 9 sem produto",
    });

    expect(OrderIngestionIssueService.resolve).not.toHaveBeenCalled();
    expect(
      (OrderIngestionIssueService.open as any).mock.calls[0][0],
    ).toMatchObject({ reason: "PARTIAL_LINK", detail: "item 9 sem produto" });
  });

  it("Shopee sem vínculo: abre NO_LINKED_ITEMS com o orderId", async () => {
    await UC.completarOrderSemItens({
      plataforma: "SHOPEE",
      marketplaceAccountId: "acc-1",
      externalOrderId: "SN-1",
      orderId: "o-1",
      itens: [],
      itemsTotal: 1,
      esperavaBaixa: true,
      payload: { order_sn: "SN-1" },
    });

    expect(
      (OrderIngestionIssueService.open as any).mock.calls[0][0],
    ).toMatchObject({ reason: "NO_LINKED_ITEMS", orderId: "o-1" });
    expect(OrderIngestionIssueService.resolve).not.toHaveBeenCalled();
  });
});

describe("acrescentarItensAoPedido — extração sem mudança de comportamento", () => {
  function buildTx(itensAtuais: Array<{ productId: string }>) {
    const sequencia: string[] = [];
    return {
      sequencia,
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings)
          ? strings.join("?")
          : String(strings);
        if (sql.includes('"Order"')) sequencia.push("lock:order");
        return Promise.resolve([]);
      }),
      orderItem: {
        findMany: vi.fn(() => {
          sequencia.push("read:itens");
          return Promise.resolve(itensAtuais);
        }),
        createMany: vi.fn((args: any) => {
          sequencia.push("insert:" + args.data.length);
          return Promise.resolve({ count: args.data.length });
        }),
      },
    };
  }

  it("locka o Order ANTES de ler e inserir", async () => {
    const tx = buildTx([]);
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: any) =>
      fn(tx)) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const n = await UC.acrescentarItensAoPedido({
      orderId: "o-1",
      externalOrderId: "EXT-1",
      itens: [{ productId: "p1", listingId: null, quantity: 1, unitPrice: 5 }],
      evento: "evento.teste",
    });

    expect(n).toBe(1);
    // Sem o lock, dois processos liam o conjunto vazio e inseriam o MESMO item:
    // pedido com quantidade dobrada e baixa dobrada em seguida.
    expect(tx.sequencia).toEqual(["lock:order", "read:itens", "insert:1"]);
  });

  it("ignora produto que já está no pedido (idempotência)", async () => {
    const tx = buildTx([{ productId: "p1" }]);
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: any) =>
      fn(tx)) as never);

    const n = await UC.acrescentarItensAoPedido({
      orderId: "o-1",
      externalOrderId: "EXT-1",
      itens: [{ productId: "p1", listingId: null, quantity: 1, unitPrice: 5 }],
      evento: "evento.teste",
    });

    expect(n).toBe(0);
    expect(tx.orderItem.createMany).not.toHaveBeenCalled();
  });

  it("o caminho da Shopee preserva o nome do evento de log", async () => {
    const tx = buildTx([]);
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: any) =>
      fn(tx)) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(UC, "mapShopeeOrderItems").mockResolvedValue({
      items: [{ productId: "p1", listingId: null, quantity: 1, unitPrice: 5 }],
      linkedCount: 1,
      unlinked: [],
    });

    await OrderUseCase.completePartialShopeeOrder(
      "acc-1",
      { order_sn: "SN-1", item_list: [{ item_id: 1 }] } as any,
      "o-1",
      "dono-1",
    );

    const linha = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(linha.event).toBe("shopee.order_import.partial_completed");
    expect(linha.itensAcrescentados).toBe(1);
  });
});

describe("laço do ML: pedido existente SEM itens é completado, não pulado", () => {
  const ML_ORDER = {
    id: 2000017658297096,
    status: "paid",
    total_amount: 55,
    date_created: "2026-07-28T10:00:00Z",
    order_items: [
      {
        item: { id: "MLB123", seller_custom_field: "SKU-1" },
        quantity: 1,
        unit_price: 55,
      },
    ],
  };

  beforeEach(() => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      id: "acc-1",
      userId: "dono-1",
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: "123",
    } as never);
    vi.spyOn(UC, "getRecentMLOrdersWithRefresh").mockResolvedValue([ML_ORDER]);
    vi.spyOn(UC, "logSync").mockResolvedValue(undefined);
    vi.spyOn(UC, "registrarDesfechoIngestao").mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // findMany é chamado duas vezes: o batch check e a consulta dos vazios.
    vi.spyOn(prisma.order, "findMany").mockImplementation(((args: any) =>
      args?.where?.items
        ? Promise.resolve([
            { id: "o-vazio", externalOrderId: "2000017658297096" },
          ])
        : Promise.resolve([
            { externalOrderId: "2000017658297096" },
          ])) as never);
  });

  it("completa o pedido, baixa o estoque e conta como importado", async () => {
    vi.spyOn(UC, "mapOrderItems").mockResolvedValue({
      items: [{ productId: "p1", listingId: "l1", quantity: 1, unitPrice: 55 }],
      linkedCount: 1,
    });
    vi.spyOn(UC, "acrescentarItensAoPedido").mockResolvedValue(1);
    const baixa = vi.spyOn(UC, "retryStockDeduction").mockResolvedValue(true);
    const processa = vi.spyOn(UC, "processOrder");

    const r = await OrderUseCase.importRecentOrdersForAccount(
      "acc-1",
      7,
      true,
      500,
    );

    // Não passa por `processOrder`: o Order já existe, o que falta são os itens.
    expect(processa).not.toHaveBeenCalled();
    expect(baixa).toHaveBeenCalledWith(
      "o-vazio",
      "MERCADO_LIVRE",
      "2000017658297096",
    );
    expect(r.imported).toBe(1);
    expect(r.stockDeductions).toBe(1);
    expect(r.alreadyExists).toBe(0);
  });

  it("produto ainda fora do Dexo: conta como PERDA, não como já importado", async () => {
    vi.spyOn(UC, "mapOrderItems").mockResolvedValue({
      items: [],
      linkedCount: 0,
    });

    const r = await OrderUseCase.importRecentOrdersForAccount(
      "acc-1",
      7,
      true,
      500,
    );

    // `alreadyExists` faria o ciclo gravar SUCCESS com a venda sem baixa —
    // "sincronizado sem erro" é exatamente o que não pode ser reportado aqui.
    expect(r.noProducts).toBe(1);
    expect(r.alreadyExists).toBe(0);
    expect(r.imported).toBe(0);
  });

  it("com o kill-switch ligado, volta a pular o pedido como já importado", async () => {
    process.env.ORDER_COMPLETE_EMPTY_ORDER_DISABLED = "1";
    const mapeia = vi.spyOn(UC, "mapOrderItems");

    const r = await OrderUseCase.importRecentOrdersForAccount(
      "acc-1",
      7,
      true,
      500,
    );

    expect(mapeia).not.toHaveBeenCalled();
    expect(r.alreadyExists).toBe(1);
    expect(r.imported).toBe(0);
    expect(r.noProducts).toBe(0);
  });
});

describe("criarOrderSemItens vale para as três plataformas", () => {
  const NOME_FLAG = "ORDER_CREATE_WITHOUT_ITEMS_ML_MAGALU_DISABLED";

  beforeEach(() => {
    delete process.env[NOME_FLAG];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env[NOME_FLAG];
  });

  it.each([["MERCADO_LIVRE"], ["MAGALU"], ["SHOPEE"]])(
    "%s cria o Order com zero itens",
    async (plataforma) => {
      const { orderRepository } = await import(
        "@/app/repositories/order.repository"
      );
      const create = vi
        .spyOn(orderRepository, "create")
        .mockResolvedValue({ id: "o-novo" } as never);

      const id = await UC.criarOrderSemItens({
        marketplaceAccountId: "acc-1",
        externalOrderId: "EXT-1",
        status: "PAID",
        totalAmount: 10,
        soldAt: null,
        plataforma,
        itemsTotal: 1,
      });

      expect(id).toBe("o-novo");
      expect((create.mock.calls[0][0] as any).items).toEqual([]);
    },
  );

  it("kill-switch volta ao recorte de Shopee-apenas", async () => {
    process.env[NOME_FLAG] = "1";
    const { orderRepository } = await import(
      "@/app/repositories/order.repository"
    );
    const create = vi.spyOn(orderRepository, "create");

    const idMl = await UC.criarOrderSemItens({
      marketplaceAccountId: "acc-1",
      externalOrderId: "EXT-1",
      status: "PAID",
      totalAmount: 10,
      soldAt: null,
      plataforma: "MERCADO_LIVRE",
      itemsTotal: 1,
    });

    expect(idMl).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

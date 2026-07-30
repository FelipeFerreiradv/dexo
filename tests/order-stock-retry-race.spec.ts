import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Auditoria adversarial de 29/07/2026 — achado CRÍTICO de baixa dupla.
//
// `retryStockDeduction` lia a única âncora de idempotência (o NET do StockLog
// por `reason`) com `prisma.stockLog.groupBy` — conexão própria, FORA de
// transação e sem lock — e só depois abria a transação da baixa para aplicar o
// delta. Entre a leitura e a escrita não havia nada que serializasse.
//
// E era pior do que uma corrida comum: o `SELECT status FROM "Order" ... FOR
// UPDATE` que já existia dentro de `deductStockForOrder` fazia a segunda
// execução ESPERAR a primeira commitar e então aplicar o delta calculado com o
// net VELHO. Corrida convertida em decremento duplo determinístico.
//
// Os dois pontos de entrada que se cruzam existem de verdade e em processos pm2
// distintos: o poll (`dexo-sync-orders`, a cada 15 min) e o reconciliador de
// pendências (`dexo-api`, a cada 10 min), mais o botão "Tentar novamente" como
// terceiro caminho.
//
// O padrão correto já estava no repo, em `processOrderCancellation`: locka os
// produtos DENTRO da tx e só então lê o net ("Lock dos produtos ... ANTES do
// net — serializa com uma baixa em voo do importador"). Esta era a única baixa
// fora desse padrão.
//
// O que estes testes provam, e que uma refatoração cosmética não passaria:
//  1. o net NÃO é mais lido fora da transação;
//  2. dentro da tx a ordem é Order FOR UPDATE → Product FOR UPDATE → net;
//  3. o delta entregue ao motor de estoque vem do net lido lá dentro;
//  4. duas execuções sequenciais (a segunda vendo o StockLog da primeira) não
//     baixam nada na segunda — que é o desfecho da corrida depois do lock.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import prisma from "@/app/lib/prisma";

const ORDER = {
  id: "order-1",
  status: "SHIPPED",
  stockDeductedAt: null,
  items: [{ productId: "p1", quantity: 2, unitPrice: 10, listingId: null }],
};

/**
 * `tx` que registra a sequência de operações, para os testes poderem afirmar a
 * ORDEM — é nela que a correção mora.
 */
function buildTx(netPorProduto: Array<{ productId: string; change: number }>) {
  const sequencia: string[] = [];
  const tx = {
    sequencia,
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('"Order"')) {
        sequencia.push("lock:order");
        return Promise.resolve([{ status: "SHIPPED" }]);
      }
      if (sql.includes('"Product"')) {
        sequencia.push("lock:product");
        return Promise.resolve([{ id: "p1" }]);
      }
      sequencia.push("queryRaw:outro");
      return Promise.resolve([]);
    }),
    stockLog: {
      groupBy: vi.fn(() => {
        sequencia.push("net:dentro-da-tx");
        return Promise.resolve(
          netPorProduto.map((n) => ({
            productId: n.productId,
            _sum: { change: n.change },
          })),
        );
      }),
    },
    order: {
      update: vi.fn(() => {
        sequencia.push("stamp:stockDeductedAt");
        return Promise.resolve({});
      }),
    },
  };
  return tx;
}

let flagAnterior: string | undefined;
let flagStamp: string | undefined;

beforeEach(() => {
  flagAnterior = process.env.ORDER_STOCK_RETRY_TX_NET_DISABLED;
  flagStamp = process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED;
  // A suíte desliga as duas por default (vitest.config) para os specs antigos
  // ficarem byte-idênticos. Aqui exercitamos o caminho que roda em PRODUÇÃO.
  delete process.env.ORDER_STOCK_RETRY_TX_NET_DISABLED;
  delete process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  const restaura = (nome: string, valor: string | undefined) => {
    if (valor === undefined) delete process.env[nome];
    else process.env[nome] = valor;
  };
  restaura("ORDER_STOCK_RETRY_TX_NET_DISABLED", flagAnterior);
  restaura("ORDER_STOCK_DEDUCTED_AT_DISABLED", flagStamp);
});

describe("retryStockDeduction — o net é lido dentro da transação", () => {
  it("NÃO lê o net fora da transação", async () => {
    const tx = buildTx([]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const netFora = vi
      .spyOn(prisma.stockLog as any, "groupBy")
      .mockResolvedValue([] as any);
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(true);
    // Era ESTA chamada a causa da baixa dupla.
    expect(netFora).not.toHaveBeenCalled();
    expect(tx.stockLog.groupBy).toHaveBeenCalledTimes(1);
  });

  it("locka Order e Product ANTES de ler o net", async () => {
    const tx = buildTx([]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    const iLockOrder = tx.sequencia.indexOf("lock:order");
    const iLockProduct = tx.sequencia.indexOf("lock:product");
    const iNet = tx.sequencia.indexOf("net:dentro-da-tx");

    expect(iLockOrder).toBeGreaterThanOrEqual(0);
    expect(iLockProduct).toBeGreaterThan(iLockOrder);
    // O coração da correção: sem isto, o net pode ser lido enquanto outra
    // transação ainda não commitou a baixa dela.
    expect(iNet).toBeGreaterThan(iLockProduct);
  });

  it("o net lido na tx é o que define o delta entregue ao motor de estoque", async () => {
    // Pedido de 2; o net já mostra -1 (baixa parcial por clamp de oversell).
    const tx = buildTx([{ productId: "p1", change: -1 }]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    expect(deduct).toHaveBeenCalledTimes(1);
    const [, input] = deduct.mock.calls[0] as any[];
    // Falta 1, não 2: passar o pedido cheio baixaria de novo a unidade que saiu.
    expect(input.items).toEqual([{ productId: "p1", quantity: 1 }]);
    expect(input.reason).toBe("Venda Shopee #SN-1");
  });

  it("segunda execução, já vendo o StockLog da primeira, não baixa nada", async () => {
    // É o desfecho da corrida DEPOIS do lock: a segunda transação espera, lê o
    // net atualizado (-2) e conclui que não falta nada. Antes ela lia -0.
    const tx = buildTx([{ productId: "p1", change: -2 }]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(true);
    expect(deduct).not.toHaveBeenCalled();
  });

  it("agrega por PRODUTO: duas linhas do mesmo produto viram um delta só", async () => {
    const tx = buildTx([{ productId: "p1", change: -1 }]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue({
      ...ORDER,
      items: [
        { productId: "p1", quantity: 1, unitPrice: 10, listingId: null },
        { productId: "p1", quantity: 1, unitPrice: 10, listingId: null },
      ],
    } as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    // Linha a linha, as duas pareceriam quitadas (1 >= 1) e a unidade que falta
    // ficaria sem baixa para sempre. E o produto é lockado UMA vez.
    const locksDeProduto = tx.sequencia.filter(
      (s) => s === "lock:product",
    ).length;
    expect(locksDeProduto).toBe(1);
    const [, input] = deduct.mock.calls[0] as any[];
    expect(input.items).toEqual([{ productId: "p1", quantity: 1 }]);
  });

  it("pedido cancelado dentro da tx não baixa", async () => {
    const tx = buildTx([]);
    tx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('"Order"')) return Promise.resolve([{ status: "CANCELLED" }]);
      return Promise.resolve([]);
    });
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    expect(deduct).not.toHaveBeenCalled();
    expect(tx.stockLog.groupBy).not.toHaveBeenCalled();
  });

  it("não sobrescreve um stockDeductedAt que já existe", async () => {
    const tx = buildTx([{ productId: "p1", change: -2 }]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue({
      ...ORDER,
      stockDeductedAt: new Date("2026-07-01T10:00:00Z"),
    } as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    // Perder a hora da baixa original tiraria o valor da coluna de auditoria.
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("kill-switch ORDER_STOCK_RETRY_TX_NET_DISABLED=1 volta a ler o net fora da tx", async () => {
    process.env.ORDER_STOCK_RETRY_TX_NET_DISABLED = "1";
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    const netFora = vi
      .spyOn(prisma.stockLog as any, "groupBy")
      .mockResolvedValue([] as any);
    const deduct = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    expect(netFora).toHaveBeenCalledTimes(1);
    // Caminho anterior: a lista já filtrada, e SEM o terceiro argumento.
    expect(deduct).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ productId: "p1", quantity: 2 }] }),
      "Venda Shopee #SN-1",
    );
  });
});

describe("completePartialShopeeOrder — acréscimo de item é atômico", () => {
  const PEDIDO_SHOPEE = {
    order_sn: "SN-1",
    item_list: [
      { item_id: 111, item_sku: "SKU-1", model_quantity_purchased: 1 },
    ],
  };

  it("lê os itens atuais e insere dentro da MESMA transação, com o Order lockado", async () => {
    const sequencia: string[] = [];
    const tx = {
      $queryRaw: vi.fn(() => {
        sequencia.push("lock:order");
        return Promise.resolve([{ id: "order-1" }]);
      }),
      orderItem: {
        findMany: vi.fn(() => {
          sequencia.push("read:itens");
          return Promise.resolve([]);
        }),
        createMany: vi.fn(() => {
          sequencia.push("insert:itens");
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 10, listingId: "l1" },
      ],
      linkedCount: 1,
      unlinked: [],
    });

    const n = await OrderUseCase.completePartialShopeeOrder(
      "conta-1",
      PEDIDO_SHOPEE as any,
      "order-1",
      "user-1",
    );

    expect(n).toBe(1);
    // Sem unique em (orderId, productId), o read e o insert precisam estar sob
    // o mesmo lock: duas execuções concorrentes liam as duas o conjunto vazio e
    // inseriam as duas o mesmo item, dobrando a quantidade do pedido.
    expect(sequencia).toEqual(["lock:order", "read:itens", "insert:itens"]);
  });

  it("produto que já está no pedido não é inserido de novo", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "order-1" }]),
      orderItem: {
        findMany: vi.fn().mockResolvedValue([{ productId: "p1" }]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [
        { productId: "p1", quantity: 1, unitPrice: 10, listingId: "l1" },
      ],
      linkedCount: 1,
      unlinked: [],
    });

    const n = await OrderUseCase.completePartialShopeeOrder(
      "conta-1",
      PEDIDO_SHOPEE as any,
      "order-1",
      "user-1",
    );

    expect(n).toBe(0);
    expect(tx.orderItem.createMany).not.toHaveBeenCalled();
  });

  it("nenhum item vinculável não abre transação", async () => {
    const tx$ = vi.spyOn(prisma, "$transaction");
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [],
      linkedCount: 0,
      unlinked: [{ itemId: "111", sku: "SKU-1", reason: "PRODUCT_NOT_FOUND" }],
    });

    const n = await OrderUseCase.completePartialShopeeOrder(
      "conta-1",
      PEDIDO_SHOPEE as any,
      "order-1",
      "user-1",
    );

    expect(n).toBe(0);
    expect(tx$).not.toHaveBeenCalled();
  });
});

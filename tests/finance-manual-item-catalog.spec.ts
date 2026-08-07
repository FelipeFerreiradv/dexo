import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco F — peça avulsa cadastrada na venda dá ENTRADA e SAÍDA no estoque.
//
// A assimetria que isto corrige: hoje o item manual entra na sucata em
// DINHEIRO (getScrapMoney usa COALESCE(ri.scrapId, p.scrapId) sobre um LEFT
// JOIN, então a linha sobrevive sem produto) mas NÃO entra em QUANTIDADE
// (getScrapParts agrupa por productId, e NULL nunca casa).
//
// A flag precisa estar ligada ANTES do import de finance.usecase — o módulo lê
// process.env no topo. `vi.hoisted` roda antes de qualquer import.
// ──────────────────────────────────────────────────────────

// `vi.mock` é HOISTED para o topo do arquivo — qualquer const declarada aqui
// embaixo ainda não existiria quando a factory rodar. `vi.hoisted` é o único
// lugar onde dá para criar os spies (e ligar a flag antes dos imports).
const { productCreateMock, stockMock } = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_MANUAL_ITEM_CATALOG_ENABLED = "true";
  return {
    productCreateMock: vi.fn(),
    stockMock: {
      deductWithinTx: vi.fn(),
      restoreWithinTx: vi.fn(),
      firePostEffects: vi.fn(),
    },
  };
});

vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    create = productCreateMock;
  },
}));
vi.mock("@/app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    create = productCreateMock;
  },
}));

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: stockMock,
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: stockMock,
}));

vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));
vi.mock("@/app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logUserActivity: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: { logUserActivity: vi.fn().mockResolvedValue(undefined) },
}));

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
    customer: { findFirst: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return prisma;
}
vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prisma from "../app/lib/prisma";
import { FinanceUseCase } from "../app/usecases/finance.usecase";

const USER = "user-owner";

/** Venda com uma peça CADASTRADA e uma peça AVULSA marcada p/ catálogo. */
function vendaMista(overrides: Partial<any> = {}) {
  return {
    id: "r-1",
    userId: USER,
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "800.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-09-01"),
    status: "PENDENTE",
    paidAt: null,
    paymentMethod: "PIX",
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "ri-cad",
        productId: "p-cadastrado",
        description: null,
        scrapId: null,
        listingId: null,
        quantity: 1,
        unitPrice: "500.00",
        createdAt: new Date(),
        createCatalogProduct: false,
        autoCreatedProduct: false,
        product: { id: "p-cadastrado", sku: "SKU-1", name: "Peça cadastrada" },
      },
      {
        id: "ri-avulsa",
        productId: null,
        description: "Farol dianteiro direito",
        scrapId: "scrap-1",
        listingId: null,
        quantity: 2,
        unitPrice: "150.00",
        createdAt: new Date(),
        createCatalogProduct: true,
        autoCreatedProduct: false,
        product: null,
      },
    ],
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivableItem.update.mockResolvedValue({});
  stockMock.deductWithinTx.mockResolvedValue({
    deductions: [],
    oversellAlerts: [],
  });
  stockMock.restoreWithinTx.mockResolvedValue({ deductions: [] });
  productCreateMock.mockResolvedValue({ id: "p-novo", sku: "042" });
});

describe("markPaid — promoção da peça avulsa", () => {
  beforeEach(() => {
    (prisma as any).receivable.findFirst.mockResolvedValue(vendaMista());
    (prisma as any).receivable.findUnique.mockResolvedValue(
      vendaMista({ status: "PAGA" }),
    );
  });

  it("cria o produto com SKU automático, herdando a sucata do item", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(productCreateMock).toHaveBeenCalledTimes(1);
    const [payload, tx] = productCreateMock.mock.calls[0];
    expect(payload).toMatchObject({
      userId: USER,
      autoSku: true,
      name: "Farol dianteiro direito",
      price: 150,
      stock: 0, // nasce zerado — a ENTRADA abaixo é que move
      scrapId: "scrap-1",
      autoCreatedFromSale: true,
    });
    // Segundo argumento = client transacional: o produto nasce DENTRO da tx do
    // pagamento, então um rollback não deixa produto órfão no catálogo.
    expect(tx).toBe(prisma);
  });

  it("vincula o item ao produto e marca autoCreatedProduct", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect((prisma as any).receivableItem.update).toHaveBeenCalledWith({
      where: { id: "ri-avulsa" },
      data: { productId: "p-novo", autoCreatedProduct: true },
    });
  });

  it("gera ENTRADA (+qty) com reason própria, antes da saída", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(stockMock.restoreWithinTx).toHaveBeenCalledTimes(1);
    expect(stockMock.restoreWithinTx).toHaveBeenCalledWith(prisma, {
      items: [{ productId: "p-novo", quantity: 2 }],
      reason: "Entrada — peça avulsa PDV · Conta a Receber r-1",
      orderId: "receivable:r-1",
      logPrefix: "[FinanceUseCase]",
    });
    // A ordem importa: entrada ANTES da saída, senão a baixa seria clampada
    // em 0 e o par entrada/saída não existiria.
    const ordemEntrada = stockMock.restoreWithinTx.mock.invocationCallOrder[0];
    const ordemSaida = stockMock.deductWithinTx.mock.invocationCallOrder[0];
    expect(ordemEntrada).toBeLessThan(ordemSaida);
  });

  it("a SAÍDA inclui a peça promovida junto com as cadastradas", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(stockMock.deductWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [
          { productId: "p-cadastrado", quantity: 1 },
          { productId: "p-novo", quantity: 2 },
        ],
        reason: "Venda balcão — Conta a Receber r-1",
      }),
    );
  });

  // O alerta STOCK_ZEROED_IN_ONE_MOVE dispara para previousStock>1 e
  // newStock=0 — que é EXATAMENTE o ciclo de vida da peça avulsa. Sem o
  // filtro, toda venda avulsa com qty>1 poluiria o log com um falso positivo.
  it("produtos promovidos NÃO vão para o firePostEffects", async () => {
    stockMock.deductWithinTx.mockResolvedValue({
      deductions: [
        { productId: "p-cadastrado", previousStock: 5, newStock: 4, quantity: 1 },
        { productId: "p-novo", previousStock: 2, newStock: 0, quantity: 2 },
      ],
      oversellAlerts: [],
    });

    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    const arg = stockMock.firePostEffects.mock.calls[0][0];
    expect(arg.deductions.map((d: any) => d.productId)).toEqual([
      "p-cadastrado",
    ]);
  });

  it("item avulso SEM o opt-in não vira produto (mão de obra, taxa, frete)", async () => {
    const venda = vendaMista();
    venda.items[1].createCatalogProduct = false;
    (prisma as any).receivable.findFirst.mockResolvedValue(venda);

    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(productCreateMock).not.toHaveBeenCalled();
    expect(stockMock.restoreWithinTx).not.toHaveBeenCalled();
    // A saída continua só com o item cadastrado — igual a hoje.
    expect(stockMock.deductWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [{ productId: "p-cadastrado", quantity: 1 }],
      }),
    );
  });

  // Idempotência: o laço só olha itens com productId == null. Depois da
  // promoção o item TEM productId, então pagar de novo não duplica nada — e
  // markPaid já é no-op em conta PAGA, o que é a primeira barreira.
  it("item já promovido não é promovido de novo", async () => {
    const venda = vendaMista();
    venda.items[1].productId = "p-ja-existente";
    venda.items[1].autoCreatedProduct = true;
    (prisma as any).receivable.findFirst.mockResolvedValue(venda);

    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(productCreateMock).not.toHaveBeenCalled();
  });

  it("conta já PAGA é no-op — não cria produto nenhum", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      vendaMista({ status: "PAGA" }),
    );

    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(productCreateMock).not.toHaveBeenCalled();
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });

  it("REGRESSÃO: venda só com itens cadastrados não muda em nada", async () => {
    const venda = vendaMista();
    venda.items = [venda.items[0]];
    (prisma as any).receivable.findFirst.mockResolvedValue(venda);

    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(productCreateMock).not.toHaveBeenCalled();
    expect(stockMock.restoreWithinTx).not.toHaveBeenCalled();
    expect(stockMock.deductWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [{ productId: "p-cadastrado", quantity: 1 }],
        reason: "Venda balcão — Conta a Receber r-1",
        orderId: "receivable:r-1",
      }),
    );
  });
});

describe("reverse — estorno simétrico da peça avulsa", () => {
  function vendaPagaComAvulsaPromovida() {
    const v = vendaMista({ status: "PAGA", paidAt: new Date() });
    v.items[1].productId = "p-novo";
    v.items[1].autoCreatedProduct = true;
    return v;
  }

  beforeEach(() => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      vendaPagaComAvulsaPromovida(),
    );
    (prisma as any).receivable.findUnique.mockResolvedValue(
      vendaPagaComAvulsaPromovida(),
    );
  });

  it("devolve estoque de tudo e depois COMPENSA a peça avulsa (volta a 0)", async () => {
    await new FinanceUseCase().reverse("r-1", USER);

    // 1) restore normal (+qty) para todos os itens com produto
    expect(stockMock.restoreWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [
          { productId: "p-cadastrado", quantity: 1 },
          { productId: "p-novo", quantity: 2 },
        ],
        reason: "Estorno venda balcão — Conta a Receber r-1",
      }),
    );
    // 2) saída compensatória SÓ da peça que nasceu nesta venda — sem isto o
    //    catálogo ficaria com um produto fantasma com estoque.
    expect(stockMock.deductWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [{ productId: "p-novo", quantity: 2 }],
        reason: "Estorno entrada — peça avulsa PDV · Conta a Receber r-1",
      }),
    );
  });

  it("a peça avulsa não entra no reopenOnRefill (não tem anúncio e voltou a 0)", async () => {
    stockMock.restoreWithinTx.mockResolvedValue({
      deductions: [
        { productId: "p-cadastrado", previousStock: 0, newStock: 1, quantity: 1 },
        { productId: "p-novo", previousStock: 0, newStock: 2, quantity: 2 },
      ],
    });

    await new FinanceUseCase().reverse("r-1", USER);

    const arg = stockMock.firePostEffects.mock.calls[0][0];
    expect(arg.deductions.map((d: any) => d.productId)).toEqual([
      "p-cadastrado",
    ]);
    expect(arg.reopenOnRefill).toEqual({ userId: USER });
  });

  it("REGRESSÃO: venda sem peça avulsa não ganha saída compensatória", async () => {
    const v = vendaMista({ status: "PAGA", paidAt: new Date() });
    v.items = [v.items[0]];
    (prisma as any).receivable.findFirst.mockResolvedValue(v);

    await new FinanceUseCase().reverse("r-1", USER);

    expect(stockMock.deductWithinTx).not.toHaveBeenCalled();
  });
});

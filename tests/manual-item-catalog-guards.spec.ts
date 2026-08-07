import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco F — os dois guard-rails do bloco:
//
//  1. FLAG DESLIGADA => o pagamento é byte-idêntico ao de hoje. Mesmo com o
//     opt-in gravado no item, nada é promovido. É o kill-switch de produção.
//
//  2. A reconciliação de status da sucata IGNORA as peças promovidas. Sem
//     isto, uma sucata com venda avulsa e zero produtos catalogados
//     (deriveScrapStatus(true, 0, 0) = IN_USE) passaria a DEPLETED assim que a
//     primeira peça avulsa virasse produto com estoque 0.
//
// A flag é lida no topo do módulo, então tem de ser fixada ANTES dos imports —
// e explicitamente como "false": `process.env` é do PROCESSO, e outro spec do
// mesmo worker pode tê-la deixado ligada.
// ──────────────────────────────────────────────────────────

const { productCreateMock, stockMock } = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_MANUAL_ITEM_CATALOG_ENABLED = "false";
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
    scrap: { update: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return prisma;
}
vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prisma from "../app/lib/prisma";
import { FinanceUseCase } from "../app/usecases/finance.usecase";
import { ScrapStatusReconcileService } from "../app/marketplaces/services/scrap-status-reconcile.service";

const USER = "user-owner";

function vendaComAvulsaOptIn() {
  return {
    id: "r-1",
    userId: USER,
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "300.00",
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
        id: "ri-avulsa",
        productId: null,
        description: "Farol",
        scrapId: "scrap-1",
        listingId: null,
        quantity: 2,
        unitPrice: "150.00",
        createdAt: new Date(),
        // Opt-in GRAVADO — mas a flag está desligada.
        createCatalogProduct: true,
        autoCreatedProduct: false,
        product: null,
      },
    ],
    payments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  stockMock.deductWithinTx.mockResolvedValue({
    deductions: [],
    oversellAlerts: [],
  });
  stockMock.restoreWithinTx.mockResolvedValue({ deductions: [] });
});

describe("kill-switch: flag desligada", () => {
  beforeEach(() => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      vendaComAvulsaOptIn(),
    );
    (prisma as any).receivable.findUnique.mockResolvedValue({
      ...vendaComAvulsaOptIn(),
      status: "PAGA",
    });
  });

  it("nenhum produto é criado, mesmo com o opt-in gravado no item", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);
    expect(productCreateMock).not.toHaveBeenCalled();
  });

  it("nenhuma entrada de estoque é gerada", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);
    expect(stockMock.restoreWithinTx).not.toHaveBeenCalled();
  });

  it("o item continua sem vínculo — nada é escrito no ReceivableItem", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);
    expect((prisma as any).receivableItem.update).not.toHaveBeenCalled();
  });

  it("a baixa sai VAZIA (item manual não baixa estoque) — igual a hoje", async () => {
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);
    expect(stockMock.deductWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [],
        reason: "Venda balcão — Conta a Receber r-1",
        orderId: "receivable:r-1",
      }),
    );
  });
});

describe("reconciliação de sucata ignora peças promovidas", () => {
  it("as subqueries de catálogo filtram autoCreatedFromSale", async () => {
    (prisma as any).$queryRaw
      // (A) sucatas efetivas tocadas pela conta
      .mockResolvedValueOnce([{ scrapId: "scrap-1" }])
      // (B) fatos por sucata
      .mockResolvedValueOnce([{ hasSales: true, regCount: 0, sumStock: 0 }]);

    ScrapStatusReconcileService.reconcileForReceivable({
      receivableId: "r-1",
      userId: USER,
    });
    // Drena os setImmediate do best-effort.
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    const raw = (prisma as any).$queryRaw.mock.calls[1][0];
    // `Prisma.sql` guarda os fragmentos literais em `.strings` — melhor que
    // stringificar o objeto, que traria também o texto dos comentários.
    const sqlB: string = Array.isArray(raw?.strings)
      ? raw.strings.join(" ")
      : String(raw);

    // Tanto a CONTAGEM de produtos quanto a SOMA de estoque precisam do filtro:
    // deixar um dos dois de fora já bastaria para virar DEPLETED indevido.
    const predicado = /"autoCreatedFromSale" = false/g;
    expect((sqlB.match(predicado) ?? []).length).toBe(2);
  });

  // Prova do "no-op provado": a coluna é false em 100% das linhas existentes,
  // então o filtro não muda nenhum resultado para dados de hoje. Esta é a
  // decision table pura, que continua valendo palavra por palavra.
  it("deriveScrapStatus segue inalterada", async () => {
    const { deriveScrapStatus } = await import(
      "../app/marketplaces/services/scrap-status-reconcile.service"
    );
    expect(deriveScrapStatus(false, 0, 0)).toBe("AVAILABLE");
    expect(deriveScrapStatus(false, 3, 10)).toBe("AVAILABLE");
    // O cenário do §17.6: com venda e ZERO catálogo, continua IN_USE.
    expect(deriveScrapStatus(true, 0, 0)).toBe("IN_USE");
    expect(deriveScrapStatus(true, 1, 0)).toBe("DEPLETED");
    expect(deriveScrapStatus(true, 1, 5)).toBe("IN_USE");
  });
});

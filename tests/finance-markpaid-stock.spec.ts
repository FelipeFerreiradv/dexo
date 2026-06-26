import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Fase 6 — markPaid integrado a baixa de estoque (venda balcao).
//
// O que esta fase prova:
//  - Idempotencia: pagar uma conta ja PAGA nao decrementa de novo.
//  - Atomicidade: status + estoque (deductWithinTx) na MESMA $transaction
//    com { timeout: 60_000, maxWait: 20_000 } — mesmos opts do Order.
//  - Pos-commit: firePostEffects e disparado (e enfileira runOnce).
//  - Caminho atual preservado byte-identico: receivable SEM items e
//    payable continuam usando o repo.update direto, sem tx e sem stock.
// ──────────────────────────────────────────────────────────

// Mock StockDeductionService — isola este teste da logica interna do
// servico compartilhado (que tem cobertura propria via a suite Order).
vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));

// Mock ScrapStatusReconcileService — isola o reflexo de status da sucata
// (best-effort, cobertura própria em scrap-status-reconcile.spec).
vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));
vi.mock("@/app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));

// Mock prisma — o mesmo padrao das outras specs de finance.
vi.mock("../app/lib/prisma", () => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any, _opts?: any) => cb(prisma));
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any, _opts?: any) => cb(prisma));
  return { default: prisma };
});

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import { StockDeductionService } from "../app/marketplaces/services/stock-deduction.service";
import { ScrapStatusReconcileService } from "../app/marketplaces/services/scrap-status-reconcile.service";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

// Linha "raw" como vinda do prisma — inclui items + product snapshot quando
// o include de receivable e usado (findById com kind="receivable").
function makeReceivableRaw(overrides: Partial<any> = {}) {
  return {
    id: "r-1",
    userId: "user-owner",
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "100.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-06-01"),
    status: "PENDENTE",
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (StockDeductionService as any).deductWithinTx.mockResolvedValue({
    deductions: [],
    oversellAlerts: [],
  });
});

describe("Fase 6 — markPaid: receivable COM itens (venda balcao)", () => {
  it("baixa estoque e marca PAGA na MESMA $transaction (atomico)", async () => {
    // findById retorna entry com items.
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 2,
            unitPrice: "50.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "Produto" },
          },
          {
            id: "ri-2",
            productId: "p-2",
            listingId: "lst-1",
            quantity: 1,
            unitPrice: "20.00",
            createdAt: new Date(),
            product: { id: "p-2", sku: "SKU-2", name: "Produto 2" },
          },
        ],
      }),
    );
    // update dentro da tx → repo.update faz updateMany + findUnique.
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeReceivableRaw({
        status: "PAGA",
        paidAt: new Date("2026-05-22T22:00:00Z"),
      }),
    );
    // deductWithinTx retorna duas deducoes.
    (StockDeductionService as any).deductWithinTx.mockResolvedValue({
      deductions: [
        {
          productId: "p-1",
          productName: "Produto",
          previousStock: 5,
          newStock: 3,
          quantity: 2,
        },
        {
          productId: "p-2",
          productName: "Produto 2",
          previousStock: 4,
          newStock: 3,
          quantity: 1,
        },
      ],
      oversellAlerts: [],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // $transaction foi aberta com os opts certos.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    const txCall = (prisma as any).$transaction.mock.calls[0];
    expect(txCall[1]).toMatchObject({ timeout: 60_000, maxWait: 20_000 });
    // Status foi atualizado pra PAGA dentro da tx.
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r-1", userId: "user-owner" },
        data: expect.objectContaining({ status: "PAGA", paidAt: expect.any(Date) }),
      }),
    );
    // deductWithinTx chamado com os items mapeados (productId+quantity), reason
    // descritivo, orderId="receivable:<id>" e logPrefix do FinanceUseCase.
    expect(StockDeductionService.deductWithinTx).toHaveBeenCalledTimes(1);
    expect(StockDeductionService.deductWithinTx).toHaveBeenCalledWith(
      prisma, // tx === prisma (mock $transaction repassa o prisma como tx)
      {
        items: [
          { productId: "p-1", quantity: 2 },
          { productId: "p-2", quantity: 1 },
        ],
        reason: "Venda balcão — Conta a Receber r-1",
        orderId: "receivable:r-1",
        logPrefix: "[FinanceUseCase]",
      },
    );
    // firePostEffects disparado pos-commit COM pauseOnZero (Fase 7 wired).
    // Balcao pausa anuncios ao zerar; Order nao (preserva comportamento atual).
    expect(StockDeductionService.firePostEffects).toHaveBeenCalledTimes(1);
    const postArg = (StockDeductionService.firePostEffects as any).mock
      .calls[0][0];
    expect(postArg.logPrefix).toBe("[FinanceUseCase]");
    expect(postArg.pauseOnZero).toEqual({ userId: "user-owner" });
    expect(postArg.deductions).toHaveLength(2);
    // Reflexo na sucata disparado pós-commit (best-effort, irmão do firePostEffects).
    expect(
      ScrapStatusReconcileService.reconcileForReceivable,
    ).toHaveBeenCalledWith({
      receivableId: "r-1",
      userId: "user-owner",
      logPrefix: "[FinanceUseCase]",
    });
  });

  it("itens MANUAIS nao baixam estoque (deductWithinTx so recebe itens com productId)", async () => {
    // Conta MISTA: 1 item cadastrado (p-1) + 1 item manual (productId null).
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            description: null,
            scrapId: null,
            listingId: null,
            quantity: 2,
            unitPrice: "50.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "Produto" },
          },
          {
            id: "ri-m1",
            productId: null,
            description: "Mao de obra",
            scrapId: null,
            listingId: null,
            quantity: 1,
            unitPrice: "30.00",
            createdAt: new Date(),
            product: null,
          },
        ],
      }),
    );
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeReceivableRaw({ status: "PAGA", paidAt: new Date() }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // Tem itens (manual + cadastrado) => abre $transaction.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    // Mas a baixa SO recebe o item cadastrado — o manual (productId null) e
    // filtrado e nao gera baixa de catalogo (nem StockLog).
    expect(StockDeductionService.deductWithinTx).toHaveBeenCalledTimes(1);
    expect(StockDeductionService.deductWithinTx).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 2 }],
      }),
    );
  });

  it("se a tx falhar, status NAO muda e nada e enfileirado (rollback total)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 1,
            unitPrice: "50.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "Produto" },
          },
        ],
      }),
    );
    // deductWithinTx lanca dentro da tx → $transaction rejeita.
    (StockDeductionService as any).deductWithinTx.mockRejectedValue(
      new Error("estoque insuficiente — simulacao"),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(500);
    // Apos a falha: firePostEffects NUNCA e chamado (so dispara pos-commit).
    expect(StockDeductionService.firePostEffects).not.toHaveBeenCalled();
  });
});

describe("Fase 6 — markPaid: idempotencia", () => {
  it("conta ja PAGA: no-op (nao abre tx, nao decrementa, nao enfileira)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        status: "PAGA",
        paidAt: new Date("2026-05-20"),
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 2,
            unitPrice: "50.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "Produto" },
          },
        ],
      }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // Critico: NADA mais aconteceu apos o findFirst.
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).receivable.updateMany).not.toHaveBeenCalled();
    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
    expect(StockDeductionService.firePostEffects).not.toHaveBeenCalled();
    // Idempotência também no reflexo da sucata: não reconcilia de novo.
    expect(
      ScrapStatusReconcileService.reconcileForReceivable,
    ).not.toHaveBeenCalled();
    // Response contem a entry no estado atual (PAGA).
    const body = JSON.parse(res.payload);
    expect(body.entry.status).toBe("PAGA");
  });
});

describe("Fase 6 — markPaid: caminhos preservados byte-identicos", () => {
  it("receivable SEM itens: caminho atual (sem tx, sem stock)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ items: [] }),
    );
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeReceivableRaw({
        status: "PAGA",
        paidAt: new Date(),
      }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // Sem itens => sem tx, sem stock service.
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
    expect(StockDeductionService.firePostEffects).not.toHaveBeenCalled();
    // Mas o update foi feito.
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r-1", userId: "user-owner" },
        data: expect.objectContaining({ status: "PAGA" }),
      }),
    );
  });

  it("payable: caminho atual (sem tx, sem stock — items nunca se aplica)", async () => {
    (prisma as any).payable.findFirst.mockResolvedValue({
      ...makeReceivableRaw({ items: undefined }),
      // payable nao tem `items` no include — undefined.
    });
    (prisma as any).payable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).payable.findUnique.mockResolvedValue(
      makeReceivableRaw({ status: "PAGA", paidAt: new Date() }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/payables/p-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
  });
});

describe("Fase 6 — markPaid: entry inexistente", () => {
  it("findFirst retorna null: 404", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/nope/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/não encontrado/i);
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });
});

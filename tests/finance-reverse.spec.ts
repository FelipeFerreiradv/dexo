import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Fase 9 — Estorno explícito de conta PAGA com itens.
//
// Prova:
//  - DELETE de conta PAGA com itens é bloqueado (409 "use Estornar").
//  - DELETE de conta sem itens / não-PAGA / payable: byte-idêntico atual.
//  - POST /reverse: atômico ($transaction), idempotente (CANCELADA → no-op),
//    chama restoreWithinTx + firePostEffects(reopenOnRefill).
//  - Validações: 404 sem entry, 400 sem itens, 400 não-PAGA.
// ──────────────────────────────────────────────────────────

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi.fn().mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi.fn().mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));
vi.mock("@/app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));

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
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
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
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
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
    status: "PAGA",
    paidAt: new Date("2026-05-22"),
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (StockDeductionService as any).restoreWithinTx.mockResolvedValue({
    deductions: [
      {
        productId: "p-1",
        productName: "Produto",
        previousStock: 0,
        newStock: 2,
        quantity: 2,
      },
    ],
  });
});

describe("Fase 9 — POST /finance/receivables/:id/reverse", () => {
  it("estorno feliz: status CANCELADA + restoreWithinTx + firePostEffects(reopenOnRefill)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw(),
    );
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeReceivableRaw({ status: "CANCELADA" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // $transaction com mesmos opts do markPaid.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as any).$transaction.mock.calls[0][1]).toMatchObject({
      timeout: 60_000,
      maxWait: 20_000,
    });
    // Status → CANCELADA dentro da tx.
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r-1", userId: "user-owner" },
        data: expect.objectContaining({ status: "CANCELADA" }),
      }),
    );
    // restoreWithinTx com items mapeados + reason + orderId tag.
    expect(StockDeductionService.restoreWithinTx).toHaveBeenCalledTimes(1);
    expect(StockDeductionService.restoreWithinTx).toHaveBeenCalledWith(
      prisma,
      {
        items: [{ productId: "p-1", quantity: 2 }],
        reason: "Estorno venda balcão — Conta a Receber r-1",
        orderId: "receivable:r-1",
        logPrefix: "[FinanceUseCase]",
      },
    );
    // firePostEffects pós-commit com reopenOnRefill (SEM pauseOnZero).
    expect(StockDeductionService.firePostEffects).toHaveBeenCalledTimes(1);
    const postArg = (StockDeductionService.firePostEffects as any).mock
      .calls[0][0];
    expect(postArg.logPrefix).toBe("[FinanceUseCase]");
    expect(postArg.reopenOnRefill).toEqual({ userId: "user-owner" });
    expect(postArg.pauseOnZero).toBeUndefined();
    // Reflexo na sucata reavaliado pós-commit (simetria com o pagamento).
    expect(
      ScrapStatusReconcileService.reconcileForReceivable,
    ).toHaveBeenCalledWith({
      receivableId: "r-1",
      userId: "user-owner",
      logPrefix: "[FinanceUseCase]",
    });
  });

  it("idempotência: já CANCELADA → no-op (sem tx, sem restoreWithinTx)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ status: "CANCELADA" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(StockDeductionService.restoreWithinTx).not.toHaveBeenCalled();
    expect(StockDeductionService.firePostEffects).not.toHaveBeenCalled();
    expect(
      ScrapStatusReconcileService.reconcileForReceivable,
    ).not.toHaveBeenCalled();
    expect(JSON.parse(res.payload).entry.status).toBe("CANCELADA");
  });

  it("PENDENTE: 400 (apenas PAGA pode ser estornada)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ status: "PENDENTE" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/PAGA/i);
    expect(StockDeductionService.restoreWithinTx).not.toHaveBeenCalled();
  });

  it("sem itens: 400 (use exclusão simples)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ items: [] }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/inválida/i);
  });

  it("não encontrada: 404", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/nope/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("Fase 9 — DELETE bloqueado / preservado", () => {
  it("PAGA com itens: bloqueia DELETE (409 'use Estornar')", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw(),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toMatch(/Estornar/i);
    // Não chama deleteMany do banco.
    expect((prisma as any).receivable.deleteMany).not.toHaveBeenCalled();
  });

  it("PENDENTE com itens: DELETE permitido (caminho atual)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ status: "PENDENTE" }),
    );
    (prisma as any).receivable.deleteMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("PAGA SEM itens: DELETE permitido (caminho atual)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ items: [] }),
    );
    (prisma as any).receivable.deleteMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("payable: guard não se aplica (delete atual byte-idêntico)", async () => {
    (prisma as any).payable.findFirst.mockResolvedValue(
      makeReceivableRaw({ status: "PAGA" }),
    );
    (prisma as any).payable.deleteMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/payables/p-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).payable.deleteMany).toHaveBeenCalledTimes(1);
    // findFirst NUNCA é chamado para payable (skip do guard).
    expect((prisma as any).payable.findFirst).not.toHaveBeenCalled();
  });
});

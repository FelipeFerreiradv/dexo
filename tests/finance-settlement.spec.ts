// BLOCO A, 2ª METADE — liquidação: o dinheiro caiu ou está a caminho?
//
// A decisão que este spec protege é a de NÃO TOCAR NO QUE JÁ EXISTE. Há UMA
// única fórmula de "quanto entrou" no produto (`SUM(totalAmount) WHERE
// status='PAGA'`), repetida em 8 lugares. A liquidação é métrica NOVA ao lado —
// se ela começar a mexer em `status` ou `paidAt`, os oito passam a mentir de
// uma vez, incluindo o "Caixa de hoje" que o balconista usa para conferir a
// gaveta.
//
// E a segunda: QUASE TUDO É DERIVADO. A regra por forma responde sem gravar
// nada no caso comum (PIX cai no ato, crédito não). As colunas guardam só a
// exceção — "conferi o extrato, o cartão caiu". Por isso `settledAt` NULL não
// significa "não caiu"; significa "ninguém marcou".

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    receivablePayment: fmodel(),
    receivableEvent: { create: vi.fn(), findMany: vi.fn() },
    bankAccount: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return prisma;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "u-op", name: "Operador", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import {
  hasPendingSettlement,
  isSettlementEnabled,
  lineSettledAt,
  normalizeSettleFlag,
  saleSettledAt,
  settlementBreakdown,
  settlesImmediately,
} from "../app/financeiro/lib/settlement";

const OWNER = "owner@test.com";
const ORIG = process.env.SALE_SETTLEMENT_ENABLED;
const PAGO_EM = new Date("2026-08-10T12:00:00.000Z");

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

function venda(over: Record<string, unknown> = {}) {
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
    dueDate: new Date("2026-09-01"),
    status: "PAGA",
    paidAt: PAGO_EM,
    paymentMethod: "CREDITO",
    settledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivablePayment.updateMany.mockResolvedValue({ count: 1 });
  delete process.env.SALE_SETTLEMENT_ENABLED;
});

afterAll(() => {
  if (ORIG === undefined) delete process.env.SALE_SETTLEMENT_ENABLED;
  else process.env.SALE_SETTLEMENT_ENABLED = ORIG;
});

describe("A regra por forma", () => {
  it("dinheiro, PIX, débito e transferência caem NO ATO", () => {
    for (const m of ["DINHEIRO", "PIX", "DEBITO", "TRANSFERENCIA"]) {
      expect(settlesImmediately(m), m).toBe(true);
    }
  });

  it("crédito e boleto NÃO — é onde o caixa do dia mentia", () => {
    expect(settlesImmediately("CREDITO")).toBe(false);
    expect(settlesImmediately("BOLETO")).toBe(false);
  });

  it("FIADO não é dinheiro recebido: a venda nem fica PAGA", () => {
    expect(settlesImmediately("FIADO")).toBe(false);
  });

  it("forma desconhecida ou ausente ⇒ não liquida sozinha (fail-closed)", () => {
    // Afirmar que caiu sem saber é o erro que infla o caixa em silêncio.
    expect(settlesImmediately("QUALQUER")).toBe(false);
    expect(settlesImmediately(null)).toBe(false);
    expect(settlesImmediately(undefined)).toBe(false);
  });
});

describe("Derivação — nada é gravado no caso comum", () => {
  const PAGA = { status: "PAGA", paidAt: PAGO_EM };

  it("PIX numa venda PAGA já caiu, sem nenhuma escrita", () => {
    expect(saleSettledAt({ ...PAGA, paymentMethod: "PIX" })).toEqual(PAGO_EM);
  });

  it("crédito numa venda PAGA ainda NÃO caiu", () => {
    expect(saleSettledAt({ ...PAGA, paymentMethod: "CREDITO" })).toBeNull();
  });

  it("venda NÃO PAGA não liquidou nada, qualquer que seja a forma", () => {
    expect(
      saleSettledAt({
        status: "PENDENTE",
        paidAt: null,
        paymentMethod: "PIX",
      }),
    ).toBeNull();
  });

  it("a marca EXPLÍCITA precede a regra", () => {
    // "Conferi o extrato: o cartão caiu no dia 15."
    const caiu = new Date("2026-08-15T00:00:00.000Z");
    expect(
      saleSettledAt({ ...PAGA, paymentMethod: "CREDITO", settledAt: caiu }),
    ).toEqual(caiu);
  });

  it("a mesma regra vale por LINHA — PIX caiu, cartão não, na mesma venda", () => {
    const v = { ...PAGA, paymentMethod: "PIX" };
    expect(lineSettledAt({ method: "PIX", amount: 60 }, v)).toEqual(PAGO_EM);
    expect(lineSettledAt({ method: "CREDITO", amount: 40 }, v)).toBeNull();
  });
});

describe("settlementBreakdown — quanto caiu e quanto falta", () => {
  const PAGA = { status: "PAGA", paidAt: PAGO_EM };

  it("sem linhas, a venda inteira decide pela forma", () => {
    // É o caso de 77 das 82 vendas com forma (medido em 14/08).
    expect(
      settlementBreakdown({ ...PAGA, paymentMethod: "PIX" }, [], 100),
    ).toEqual({ settledAmount: 100, pendingAmount: 0 });
    expect(
      settlementBreakdown({ ...PAGA, paymentMethod: "CREDITO" }, null, 100),
    ).toEqual({ settledAmount: 0, pendingAmount: 100 });
  });

  it("com linhas, cada forma decide sozinha", () => {
    const b = settlementBreakdown(
      { ...PAGA, paymentMethod: "PIX" },
      [
        { method: "PIX", amount: 60 },
        { method: "CREDITO", amount: 40 },
      ],
      100,
    );
    expect(b).toEqual({ settledAmount: 60, pendingAmount: 40 });
  });

  it("linha marcada explicitamente entra no que caiu", () => {
    const b = settlementBreakdown(
      { ...PAGA, paymentMethod: "PIX" },
      [
        { method: "PIX", amount: 60 },
        { method: "CREDITO", amount: 40, settledAt: new Date() },
      ],
      100,
    );
    expect(b).toEqual({ settledAmount: 100, pendingAmount: 0 });
  });

  it("venda NÃO PAGA devolve ZERO nos dois", () => {
    // Dinheiro que nem foi cobrado é "a receber", não "a liquidar" — e isso o
    // `pendingAmount` do resumo já conta. Somar aqui faria o MESMO real
    // aparecer em duas métricas.
    expect(
      settlementBreakdown(
        { status: "PENDENTE", paidAt: null, paymentMethod: "CREDITO" },
        [],
        100,
      ),
    ).toEqual({ settledAmount: 0, pendingAmount: 0 });
  });

  it("venda CANCELADA idem", () => {
    expect(
      settlementBreakdown(
        { status: "CANCELADA", paidAt: PAGO_EM, paymentMethod: "PIX" },
        [],
        100,
      ),
    ).toEqual({ settledAmount: 0, pendingAmount: 0 });
  });

  it("centavos não viram dízima", () => {
    const b = settlementBreakdown(
      { ...PAGA, paymentMethod: "PIX" },
      [
        { method: "PIX", amount: 0.1 },
        { method: "PIX", amount: 0.2 },
      ],
      0.3,
    );
    expect(b.settledAmount).toBe(0.3);
  });

  it("hasPendingSettlement responde o selo da listagem", () => {
    expect(
      hasPendingSettlement({ ...PAGA, paymentMethod: "CREDITO" }, [], 100),
    ).toBe(true);
    expect(
      hasPendingSettlement({ ...PAGA, paymentMethod: "PIX" }, [], 100),
    ).toBe(false);
  });
});

describe("normalizeSettleFlag — fronteira", () => {
  const ON = { SALE_SETTLEMENT_ENABLED: "1" };

  it("flag ausente ⇒ undefined", () => {
    expect(normalizeSettleFlag(true, {})).toBeUndefined();
    expect(isSettlementEnabled({})).toBe(false);
  });

  it("aceita só booleano — string 'true' não passa", () => {
    expect(normalizeSettleFlag(true, ON)).toBe(true);
    expect(normalizeSettleFlag(false, ON)).toBe(false);
    expect(normalizeSettleFlag("true", ON)).toBeUndefined();
    expect(normalizeSettleFlag(1, ON)).toBeUndefined();
    expect(normalizeSettleFlag(undefined, ON)).toBeUndefined();
  });
});

describe("PATCH /receivables/:id/settlement", () => {
  it("flag desligada ⇒ 400 e nada é escrito", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(venda());
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/finance/receivables/r-1/settlement",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { settled: true },
    });
    expect(res.statusCode).toBe(400);
    expect((prisma as any).receivable.updateMany).not.toHaveBeenCalled();
  });

  describe("com a flag ligada", () => {
    beforeEach(() => {
      process.env.SALE_SETTLEMENT_ENABLED = "1";
      (prisma as any).receivable.findFirst.mockResolvedValue(venda());
      (prisma as any).receivable.findUnique.mockResolvedValue(venda());
    });

    it("marca a VENDA e grava SÓ settledAt", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/settlement",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: { settled: true },
      });
      expect(res.statusCode).toBe(200);
      const data = (prisma as any).receivable.updateMany.mock.calls[0][0].data;
      // A chave ÚNICA: status e paidAt não podem ser tocados, senão os 8
      // lugares que somam dinheiro mudam de resposta.
      expect(data).toEqual({ settledAt: expect.any(Date) });
    });

    it("desmarcar volta para NULL — conferência de extrato erra", async () => {
      const app = buildApp();
      await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/settlement",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: { settled: false },
      });
      const data = (prisma as any).receivable.updateMany.mock.calls[0][0].data;
      expect(data).toEqual({ settledAt: null });
    });

    it("com paymentId marca a LINHA, escopada pela venda", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/settlement",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: { settled: true, paymentId: "rp-1" },
      });
      expect(res.statusCode).toBe(200);
      const call = (prisma as any).receivablePayment.updateMany.mock
        .calls[0][0];
      // `receivableId` no where ALÉM do id: sem ele, um id de linha de outro
      // tenant marcaria liquidação numa venda alheia.
      expect(call.where).toEqual({ id: "rp-1", receivableId: "r-1" });
      expect(call.data).toEqual({ settledAt: expect.any(Date) });
      // E a venda em si NÃO é tocada.
      expect((prisma as any).receivable.updateMany).not.toHaveBeenCalled();
    });

    it("linha de outra venda ⇒ 404", async () => {
      (prisma as any).receivablePayment.updateMany.mockResolvedValue({
        count: 0,
      });
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/settlement",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: { settled: true, paymentId: "rp-de-outro" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("venda inexistente ⇒ 404", async () => {
      (prisma as any).receivable.findFirst.mockResolvedValue(null);
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/settlement",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: { settled: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it("body sem `settled` ⇒ 400", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/settlement",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("GET /finance/settlement-summary — métrica NOVA, ao lado", () => {
  it("flag desligada ⇒ zeros, sem consultar", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/settlement-summary",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({
      settledAmount: 0,
      pendingAmount: 0,
      pendingCount: 0,
    });
    expect((prisma as any).receivable.findMany).not.toHaveBeenCalled();
  });

  it("soma o que caiu e o que falta, e conta as vendas pendentes", async () => {
    process.env.SALE_SETTLEMENT_ENABLED = "1";
    (prisma as any).receivable.findMany.mockResolvedValue([
      // PIX: caiu inteiro.
      {
        totalAmount: "100.00",
        status: "PAGA",
        paidAt: PAGO_EM,
        paymentMethod: "PIX",
        settledAt: null,
        payments: [],
      },
      // Crédito: a caminho.
      {
        totalAmount: "200.00",
        status: "PAGA",
        paidAt: PAGO_EM,
        paymentMethod: "CREDITO",
        settledAt: null,
        payments: [],
      },
      // Combinada: metade caiu.
      {
        totalAmount: "50.00",
        status: "PAGA",
        paidAt: PAGO_EM,
        paymentMethod: "PIX",
        settledAt: null,
        payments: [
          { method: "PIX", amount: "30.00", settledAt: null },
          { method: "CREDITO", amount: "20.00", settledAt: null },
        ],
      },
    ]);
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/settlement-summary",
      headers: { email: OWNER },
    });
    expect(res.json().summary).toEqual({
      settledAmount: 130,
      pendingAmount: 220,
      pendingCount: 2,
    });
    delete process.env.SALE_SETTLEMENT_ENABLED;
  });
});

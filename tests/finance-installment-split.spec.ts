import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Bloco B — entrada no ato + parcelamento do saldo.
//
// Modelagem: 1 conta-ENTRADA (com os itens; é ela que baixa o estoque, pelo
// caminho que já existe) + N contas-PARCELA, filhas e sem itens. Cada parcela
// é um Receivable comum — por isso baixa individual, vencimento próprio e
// VENCIDA derivada funcionam SEM valor novo em FinanceStatus e SEM tocar
// markPaid, summary, relatórios ou dashboards.
//
// A regra que vale mais: SEM `installmentPlan`, tudo continua como hoje.
// ──────────────────────────────────────────────────────────

const stockMock = vi.hoisted(() => ({
  deductWithinTx: vi.fn(),
  restoreWithinTx: vi.fn(),
  firePostEffects: vi.fn(),
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
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
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

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

function rawReceivable(over: Partial<any> = {}) {
  return {
    id: "r-mae",
    userId: "user-owner",
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: "Venda balcão",
    debtDetails: null,
    totalAmount: "300.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-09-10"),
    status: "PAGA",
    paidAt: new Date(),
    paymentMethod: "PIX",
    parentReceivableId: null,
    installmentNumber: null,
    installmentTotal: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "ri-1",
        productId: "p-1",
        description: null,
        scrapId: null,
        listingId: null,
        quantity: 1,
        unitPrice: "1000.00",
        createdAt: new Date(),
        createCatalogProduct: false,
        autoCreatedProduct: false,
        product: { id: "p-1", sku: "SKU-1", name: "Peça" },
      },
    ],
    payments: [],
    ...over,
  };
}

const PLANO_OK = {
  downPayment: 300,
  installments: [
    { dueDate: "2026-09-10T00:00:00.000Z", amount: 350 },
    { dueDate: "2026-10-10T00:00:00.000Z", amount: 350 },
  ],
};

function postVenda(payload: any) {
  const app = buildApp();
  return app.inject({
    method: "POST",
    url: "/finance/receivables",
    headers: { email: OWNER, "content-type": "application/json" },
    payload: {
      customerId: "c-1",
      totalAmount: 1000,
      dueDate: "2026-09-10",
      installments: 1,
      items: [{ productId: "p-1", quantity: 1, unitPrice: 1000 }],
      ...payload,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
  (prisma as any).customer.findFirst.mockResolvedValue({
    id: "c-1",
    userId: "user-owner",
  });
  (prisma as any).receivable.create.mockResolvedValue({ id: "r-mae" });
  (prisma as any).receivable.findUnique.mockResolvedValue(rawReceivable());
  (prisma as any).receivable.findMany.mockResolvedValue([]);
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  stockMock.deductWithinTx.mockResolvedValue({
    deductions: [],
    oversellAlerts: [],
  });
  stockMock.restoreWithinTx.mockResolvedValue({ deductions: [] });
});

describe("POST /finance/receivables com installmentPlan", () => {
  it("a conta-ENTRADA fica com o valor da entrada, não com o total da venda", async () => {
    const res = await postVenda({ installmentPlan: PLANO_OK });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalAmount: 300, installments: 1 }),
      }),
    );
  });

  it("cria uma conta-PARCELA por linha, tudo na MESMA transação", async () => {
    await postVenda({ installmentPlan: PLANO_OK });

    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    const call = (prisma as any).receivable.createMany.mock.calls[0][0];
    expect(call.data).toHaveLength(2);
    expect(call.data[0]).toMatchObject({
      totalAmount: 350,
      parentReceivableId: "r-mae",
      installmentNumber: 1,
      installmentTotal: 2,
      status: "PENDENTE",
      installments: 1,
    });
    expect(call.data[1]).toMatchObject({
      installmentNumber: 2,
      installmentTotal: 2,
    });
  });

  it("a parcela NÃO herda forma de pagamento", async () => {
    // Herdar faria uma parcela ainda não paga aparecer como "PIX" nos
    // gráficos de forma de pagamento, inflando o método.
    await postVenda({ installmentPlan: PLANO_OK, paymentMethod: "PIX" });

    const call = (prisma as any).receivable.createMany.mock.calls[0][0];
    expect(call.data.every((d: any) => d.paymentMethod === null)).toBe(true);
  });

  it("a parcela HERDA os encargos (é ela que atrasa)", async () => {
    await postVenda({
      installmentPlan: PLANO_OK,
      fineAmount: 10,
      finePercent: 2,
      interestPercent: 1,
      toleranceDays: 5,
    });

    const call = (prisma as any).receivable.createMany.mock.calls[0][0];
    expect(call.data[0]).toMatchObject({
      fineAmount: 10,
      finePercent: 2,
      interestPercent: 1,
      toleranceDays: 5,
    });
  });

  it("a parcela não recebe itens — a mercadoria saiu uma vez só", async () => {
    await postVenda({ installmentPlan: PLANO_OK });

    // createMany de ReceivableItem roda UMA vez (só para a conta-entrada).
    expect((prisma as any).receivableItem.createMany).toHaveBeenCalledTimes(1);
    expect(
      (prisma as any).receivableItem.createMany.mock.calls[0][0].data[0]
        .receivableId,
    ).toBe("r-mae");
  });

  it("a parcela é identificada no título", async () => {
    await postVenda({ installmentPlan: PLANO_OK, reason: "Farol Gol" });
    const call = (prisma as any).receivable.createMany.mock.calls[0][0];
    expect(call.data[0].reason).toBe("Parcela 1/2 — Farol Gol");
  });
});

describe("validação do plano", () => {
  it("entrada + parcelas abaixo do total => 400 dizendo quanto falta", async () => {
    const res = await postVenda({
      installmentPlan: {
        downPayment: 300,
        installments: [{ dueDate: "2026-09-10", amount: 300 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("R$ 400.00 abaixo");
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("entrada + parcelas acima do total => 400", async () => {
    const res = await postVenda({
      installmentPlan: {
        downPayment: 300,
        installments: [{ dueDate: "2026-09-10", amount: 900 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("excedem R$ 200.00");
  });

  it("entrada zero => 400 (venda sem entrada é fiado)", async () => {
    const res = await postVenda({
      installmentPlan: {
        downPayment: 0,
        installments: [{ dueDate: "2026-09-10", amount: 1000 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("entrada");
  });

  it("parcela com valor zero => 400", async () => {
    const res = await postVenda({
      installmentPlan: {
        downPayment: 1000,
        installments: [{ dueDate: "2026-09-10", amount: 0 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("vencimento inválido => 400", async () => {
    const res = await postVenda({
      installmentPlan: {
        downPayment: 300,
        installments: [{ dueDate: "não é data", amount: 700 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("vencimento");
  });

  it("payable não pode ser parcelado assim", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/payables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 1000,
        dueDate: "2026-09-10",
        installments: 1,
        installmentPlan: PLANO_OK,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("somente contas a receber");
  });

  // Bloco A + B juntos: as linhas de pagamento descrevem a ENTRADA, não o
  // total da venda — senão toda venda parcelada seria rejeitada.
  it("payments fecham contra a ENTRADA, não contra o total", async () => {
    const res = await postVenda({
      installmentPlan: PLANO_OK,
      payments: [
        { method: "PIX", amount: 200 },
        { method: "DINHEIRO", amount: 100 },
      ],
    });
    expect(res.statusCode).toBe(201);
  });

  it("payments que não fecham a entrada => 400", async () => {
    const res = await postVenda({
      installmentPlan: PLANO_OK,
      payments: [{ method: "PIX", amount: 1000 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("excedem");
  });

  // REGRESSÃO (bug encontrado em teste local, 06/08): o bloco de pagamento
  // combinado fechava contra o TOTAL enquanto o backend cobrava a ENTRADA.
  // Resultado: com os dois blocos ligados a venda era IMPOSSÍVEL de salvar —
  // pagar o total dava 400 no servidor, e pagar só a entrada era barrado pelo
  // zod do cliente. A mensagem tem de dizer "a entrada", senão manda o
  // operador procurar um erro de digitação que não existe.
  it("a mensagem diz ENTRADA, não 'total da venda'", async () => {
    const res = await postVenda({
      installmentPlan: PLANO_OK, // entrada 300
      payments: [
        { method: "PIX", amount: 100 },
        { method: "DEBITO", amount: 21.11 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("a entrada");
    expect(res.json().error).not.toContain("o total da venda");
  });

  it("o caso do usuário: entrada 100 paga em 2 formas, saldo 21,11 em 1x", async () => {
    const res = await postVenda({
      totalAmount: 121.11,
      installmentPlan: {
        downPayment: 100,
        installments: [{ dueDate: "2026-08-07", amount: 21.11 }],
      },
      payments: [
        { method: "PIX", amount: 80 },
        { method: "DEBITO", amount: 20 },
      ],
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("REGRESSÃO: venda sem installmentPlan", () => {
  it("não cria conta-parcela nenhuma", async () => {
    const res = await postVenda({});
    expect(res.statusCode).toBe(201);
    expect((prisma as any).receivable.createMany).not.toHaveBeenCalled();
  });

  it("a conta fica com o total da venda (não é dividido)", async () => {
    await postVenda({});
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalAmount: 1000 }),
      }),
    );
  });
});

describe("estorno de venda parcelada", () => {
  beforeEach(() => {
    (prisma as any).receivable.findFirst.mockResolvedValue(rawReceivable());
  });

  it("cancela SÓ as parcelas em aberto", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-mae/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledWith({
      where: {
        parentReceivableId: "r-mae",
        userId: "user-owner",
        status: { in: ["PENDENTE", "VENCIDA"] },
      },
      data: { status: "CANCELADA" },
    });
  });

  it("informa quantas parcelas já estavam PAGAS (devolução é decisão do operador)", async () => {
    (prisma as any).receivable.findMany.mockResolvedValue([
      rawReceivable({ id: "p1", status: "CANCELADA", items: undefined }),
      rawReceivable({ id: "p2", status: "PAGA", items: undefined }),
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-mae/reverse",
      headers: { email: OWNER },
    });

    expect(res.json().installments).toEqual({ cancelled: 1, alreadyPaid: 1 });
  });

  it("REGRESSÃO: a resposta continua trazendo `entry`", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-mae/reverse",
      headers: { email: OWNER },
    });
    expect(res.json().entry).toBeTruthy();
  });
});

// REGRESSÃO (encontrado em teste local, 06/08): o saldo parcelado sumia de
// "A receber (balcão)" no PDV. O card usa GET /finance/summary?hasItems=true,
// e a parcela não tem itens. O mesmo ajuste já tinha sido feito no relatório e
// no dashboard — o summary ficou para trás.
describe("summary do PDV enxerga o saldo parcelado", () => {
  it("hasItems=true agrega as parcelas SEM alterar o where original", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?hasItems=true",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // O where das vendas continua EXATAMENTE o de antes (pinado em
    // finance-hasitems-filter) — nada de contrato alterado...
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", items: { some: {} } },
      }),
    );
    // ...e as parcelas entram por um agregado ADICIONAL.
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", parentReceivableId: { not: null } },
      }),
    );
  });

  it("os dois conjuntos são disjuntos — parcela nunca tem itens", async () => {
    // Vendas: 1 conta de 50. Parcelas: 1 de 81,11. Total = 131,11, sem
    // contar ninguém duas vezes.
    // `receivable.groupBy` e `payable.groupBy` são mocks DISTINTOS — só as
    // duas chamadas de receivable (vendas, depois parcelas) entram nesta fila.
    (prisma as any).receivable.groupBy
      .mockResolvedValueOnce([
        { status: "PAGA", _sum: { totalAmount: "50.00" }, _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        {
          status: "PENDENTE",
          _sum: { totalAmount: "81.11" },
          _count: { _all: 1 },
        },
      ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?hasItems=true",
      headers: { email: OWNER },
    });

    const r = res.json().summary.receivables;
    expect(r.totalAmount).toBeCloseTo(131.11, 2);
    expect(r.paidAmount).toBeCloseTo(50, 2);
    expect(r.pendingAmount).toBeCloseTo(81.11, 2);
  });

  it("REGRESSÃO: sem hasItems roda só os 2 agregados de sempre", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/finance/summary",
      headers: { email: OWNER },
    });

    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
    // Nenhuma consulta de parcelas quando o filtro do PDV não está ligado.
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledTimes(1);
  });
});

describe("livro do dia enxerga o tamanho da venda", () => {
  it("agrega as parcelas da página numa única query", async () => {
    (prisma as any).receivable.findMany.mockResolvedValue([
      rawReceivable({ id: "r-mae", totalAmount: "50.00", items: undefined }),
    ]);
    (prisma as any).receivable.count.mockResolvedValue(1);
    (prisma as any).receivable.groupBy.mockResolvedValue([
      {
        parentReceivableId: "r-mae",
        _sum: { totalAmount: "81.11" },
        _count: { _all: 1 },
      },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?hasItems=true&page=1&limit=50",
      headers: { email: OWNER },
    });

    const item = res.json().items[0];
    // A entrada continua sendo o totalAmount; o agregado vem ao lado para a
    // tela somar (50 + 81,11 = 131,11) sem inflar o caixa do dia.
    expect(item.totalAmount).toBe(50);
    expect(item.installmentsAmount).toBe(81.11);
    expect(item.installmentsCount).toBe(1);
  });

  it("REGRESSÃO: sem hasItems não roda query extra nenhuma", async () => {
    (prisma as any).receivable.findMany.mockResolvedValue([]);
    (prisma as any).receivable.count.mockResolvedValue(0);

    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/finance/receivables",
      headers: { email: OWNER },
    });

    expect((prisma as any).receivable.groupBy).not.toHaveBeenCalled();
  });
});

describe("exclusão de venda parcelada", () => {
  it("é bloqueada — o SetNull da FK deixaria parcelas órfãs", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      rawReceivable({ status: "PENDENTE", items: [] }),
    );
    (prisma as any).receivable.findMany.mockResolvedValue([
      rawReceivable({ id: "p1", status: "PENDENTE", items: undefined }),
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-mae",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Estornar");
    expect((prisma as any).receivable.deleteMany).not.toHaveBeenCalled();
  });

  it("REGRESSÃO: conta sem parcelas continua sendo excluída normalmente", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      rawReceivable({ status: "PENDENTE", items: [] }),
    );
    (prisma as any).receivable.findMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-mae",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.deleteMany).toHaveBeenCalled();
  });
});

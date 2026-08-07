import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Bloco A — mais de uma forma de pagamento na mesma venda.
//
// A regra que vale mais: SEM `payments` no payload, tudo continua exatamente
// como hoje — mesmo caminho de persistência (sem transação), mesmo escalar
// `paymentMethod`, mesmo pagamento único no rascunho fiscal.
//
// Com `payments`, o fechamento tem de FECHAR (soma == total, em centavos) e o
// escalar passa a ser DERIVADO do método predominante, para que os 41 pontos
// que leem `Receivable.paymentMethod` continuem funcionando sem saber que
// existe detalhamento.
// ──────────────────────────────────────────────────────────

const createPopulatedMock = vi.fn().mockResolvedValue({ id: "draft-1" });
vi.mock("../app/usecases/nfe-draft.usecase", () => ({
  NfeDraftUseCase: class {
    createPopulatedFromReceivable = createPopulatedMock;
  },
}));
vi.mock("@/app/usecases/nfe-draft.usecase", () => ({
  NfeDraftUseCase: class {
    createPopulatedFromReceivable = createPopulatedMock;
  },
}));

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
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
    receivablePayment: fmodel(),
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
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import {
  predominantPaymentMethod,
  sumPaymentsCents,
  toCents,
} from "../app/lib/payment-methods";
import { decideAutoReceive } from "../app/pdv/lib/pdv-finalize";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

function rawReceivable(overrides: Partial<any> = {}) {
  return {
    id: "r-1",
    userId: "user-owner",
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "1000.00",
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
    items: [],
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
  (prisma as any).customer.findFirst.mockResolvedValue({
    id: "c-1",
    userId: "user-owner",
  });
});

// ── Regras puras ──

describe("toCents / sumPaymentsCents — dinheiro é inteiro, nunca float", () => {
  it("o clássico 0.1 + 0.2 fecha em centavos", () => {
    // Em float isto daria 0.30000000000000004 e o caixa não fecharia.
    expect(sumPaymentsCents([{ method: "PIX", amount: 0.1 }, { method: "DINHEIRO", amount: 0.2 }])).toBe(30);
    expect(toCents(0.3)).toBe(30);
  });

  it("centavos de venda real fecham exatos", () => {
    const lines = [
      { method: "PIX", amount: 333.33 },
      { method: "DINHEIRO", amount: 333.33 },
      { method: "CREDITO", amount: 333.34 },
    ];
    expect(sumPaymentsCents(lines)).toBe(toCents(1000));
  });
});

describe("predominantPaymentMethod — o que vai para o escalar", () => {
  it("sem linhas: null (a conta simplesmente não tem método, como hoje)", () => {
    expect(predominantPaymentMethod(undefined)).toBeNull();
    expect(predominantPaymentMethod(null)).toBeNull();
    expect(predominantPaymentMethod([])).toBeNull();
  });

  it("uma linha: o método dela", () => {
    expect(predominantPaymentMethod([{ method: "DEBITO", amount: 50 }])).toBe(
      "DEBITO",
    );
  });

  it("vence o de MAIOR valor", () => {
    expect(
      predominantPaymentMethod([
        { method: "DINHEIRO", amount: 400 },
        { method: "PIX", amount: 600 },
      ]),
    ).toBe("PIX");
  });

  it("soma linhas repetidas do mesmo método antes de comparar", () => {
    // 300 + 300 de dinheiro batem os 500 do PIX.
    expect(
      predominantPaymentMethod([
        { method: "PIX", amount: 500 },
        { method: "DINHEIRO", amount: 300 },
        { method: "DINHEIRO", amount: 300 },
      ]),
    ).toBe("DINHEIRO");
  });

  it("empate é determinístico: vence a ordem de PAYMENT_METHODS", () => {
    // PIX vem antes de DINHEIRO na lista — a MESMA venda nunca pode ser
    // classificada de dois jeitos diferentes.
    const a = predominantPaymentMethod([
      { method: "DINHEIRO", amount: 500 },
      { method: "PIX", amount: 500 },
    ]);
    const b = predominantPaymentMethod([
      { method: "PIX", amount: 500 },
      { method: "DINHEIRO", amount: 500 },
    ]);
    expect(a).toBe("PIX");
    expect(b).toBe("PIX");
  });
});

describe("decideAutoReceive — FIADO no pagamento combinado", () => {
  it("REGRESSÃO: sem `payments`, a decisão é a de sempre", () => {
    expect(decideAutoReceive({ receiveNow: true, paymentMethod: "PIX" })).toEqual({
      pay: true,
      reason: "ok",
    });
    expect(
      decideAutoReceive({ receiveNow: true, paymentMethod: "FIADO" }),
    ).toEqual({ pay: false, reason: "fiado" });
    expect(
      decideAutoReceive({ receiveNow: false, paymentMethod: "PIX" }),
    ).toEqual({ pay: false, reason: "switch-off" });
  });

  it("UMA linha FIADO no meio já impede o recebimento automático", () => {
    // Marcar PAGA baixaria o estoque de uma venda que ainda tem saldo.
    expect(
      decideAutoReceive({
        receiveNow: true,
        paymentMethod: "PIX", // predominante seria PIX
        payments: [
          { method: "PIX", amount: 700 },
          { method: "FIADO", amount: 300 },
        ],
      }),
    ).toEqual({ pay: false, reason: "fiado" });
  });

  it("combinado sem FIADO recebe normalmente", () => {
    expect(
      decideAutoReceive({
        receiveNow: true,
        paymentMethod: "PIX",
        payments: [
          { method: "PIX", amount: 600 },
          { method: "DINHEIRO", amount: 400 },
        ],
      }),
    ).toEqual({ pay: true, reason: "ok" });
  });
});

// ── Persistência ──

describe("POST /finance/receivables — com e sem payments", () => {
  it("REGRESSÃO: sem `payments` não abre transação (caminho atual intacto)", async () => {
    (prisma as any).receivable.create.mockResolvedValue(rawReceivable());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 1000,
        dueDate: "2026-09-01",
        installments: 1,
        paymentMethod: "PIX",
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).receivablePayment.createMany).not.toHaveBeenCalled();
    // O escalar continua sendo o que o payload mandou.
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: "PIX" }),
      }),
    );
  });

  it("com `payments`: grava as linhas na MESMA transação", async () => {
    (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      rawReceivable({
        paymentMethod: "PIX",
        payments: [
          { id: "pp-1", method: "PIX", amount: "600.00", createdAt: new Date() },
          { id: "pp-2", method: "DINHEIRO", amount: "400.00", createdAt: new Date() },
        ],
      }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 1000,
        dueDate: "2026-09-01",
        installments: 1,
        payments: [
          { method: "PIX", amount: 600 },
          { method: "DINHEIRO", amount: 400 },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as any).receivablePayment.createMany).toHaveBeenCalledWith({
      data: [
        { receivableId: "r-1", method: "PIX", amount: 600 },
        { receivableId: "r-1", method: "DINHEIRO", amount: 400 },
      ],
    });
    // A resposta devolve o detalhamento ao cliente (o PDV precisa dele para
    // decidir o recebimento automático).
    expect(res.json().entry.payments).toHaveLength(2);
  });

  it("o escalar `paymentMethod` é DERIVADO do predominante, não do payload", async () => {
    (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
    (prisma as any).receivable.findUnique.mockResolvedValue(rawReceivable());

    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 1000,
        dueDate: "2026-09-01",
        installments: 1,
        // O payload mente: diz DINHEIRO, mas o maior valor é PIX.
        paymentMethod: "DINHEIRO",
        payments: [
          { method: "PIX", amount: 700 },
          { method: "DINHEIRO", amount: 300 },
        ],
      },
    });

    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: "PIX" }),
      }),
    );
  });
});

describe("validação de fechamento de caixa", () => {
  async function post(payments: any, totalAmount = 1000) {
    const app = buildApp();
    return app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount,
        dueDate: "2026-09-01",
        installments: 1,
        payments,
      },
    });
  }

  it("soma menor que o total => 400 dizendo QUANTO falta", async () => {
    const res = await post([{ method: "PIX", amount: 900 }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("faltam R$ 100.00");
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("soma maior que o total => 400 dizendo QUANTO excede", async () => {
    const res = await post([
      { method: "PIX", amount: 600 },
      { method: "DINHEIRO", amount: 500 },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("excedem R$ 100.00");
  });

  it("centavos que fecham exato passam (comparação em inteiros)", async () => {
    (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
    (prisma as any).receivable.findUnique.mockResolvedValue(rawReceivable());
    const res = await post([
      { method: "PIX", amount: 333.33 },
      { method: "DINHEIRO", amount: 333.33 },
      { method: "CREDITO", amount: 333.34 },
    ]);
    expect(res.statusCode).toBe(201);
  });

  // O status HTTP destas rotas é derivado por SUBSTRING da mensagem
  // (finance.routes.ts:178 casa "inválido", masculino). Uma mensagem no
  // feminino viraria 500 silenciosamente — este teste é o cadeado disso.
  it("forma desconhecida => 400 (mensagem tem de casar o mapeamento)", async () => {
    const res = await post([{ method: "BITCOIN", amount: 1000 }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("inválido");
    expect(res.json().error).toContain("não reconhecida");
  });

  it("valor zero => 400 (linha sem dinheiro não é pagamento)", async () => {
    const res = await post([
      { method: "PIX", amount: 1000 },
      { method: "DINHEIRO", amount: 0 },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("maior que zero");
  });

  it("valor negativo => 400", async () => {
    const res = await post([
      { method: "PIX", amount: 1100 },
      { method: "DINHEIRO", amount: -100 },
    ]);
    expect(res.statusCode).toBe(400);
  });

  it("payable NÃO aceita múltiplas formas", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/payables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-09-01",
        installments: 1,
        payments: [{ method: "PIX", amount: 100 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("somente contas a receber");
  });
});

// ── Reflexo fiscal ──

describe("rascunho fiscal com N meios de pagamento", () => {
  it("REGRESSÃO: sem detalhamento, 1 pagamento com o total (igual a hoje)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      rawReceivable({
        paymentMethod: "PIX",
        payments: [],
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
            product: { id: "p-1", sku: "SKU-1", name: "Peça" },
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c-1",
      userId: "user-owner",
      name: "Cliente",
      personType: "PF",
    });

    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(createPopulatedMock.mock.calls[0][1].pagamentos).toEqual([
      { meio: "PIX", valor: 1000 },
    ]);
  });

  it("com detalhamento, a nota sai com N pagamentos mapeados", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      rawReceivable({
        paymentMethod: "PIX",
        payments: [
          { id: "pp-1", method: "PIX", amount: "600.00", createdAt: new Date() },
          { id: "pp-2", method: "CREDITO", amount: "400.00", createdAt: new Date() },
        ],
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
            product: { id: "p-1", sku: "SKU-1", name: "Peça" },
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c-1",
      userId: "user-owner",
      name: "Cliente",
      personType: "PF",
    });

    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    // PAYMENT_METHOD_TO_MEIO: CREDITO -> CARTAO_CREDITO (domínio SEFAZ).
    expect(createPopulatedMock.mock.calls[0][1].pagamentos).toEqual([
      { meio: "PIX", valor: 600 },
      { meio: "CARTAO_CREDITO", valor: 400 },
    ]);
  });
});

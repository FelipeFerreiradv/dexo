import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// Fase D — Conversão orçamento → Conta a Receber (venda balcão).
// Atômica numa $transaction: cria Receivable + itens pelo MESMO caminho do
// balcão (financeRepo.create), seta Receivable.budgetId e marca o orçamento
// CONVERTIDO. Idempotente (CONVERTIDO/CANCELADO → 409).

const { prismaMock } = vi.hoisted(() => {
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
  });
  const p: any = {
    budget: fmodel(),
    budgetItem: fmodel(),
    receivable: fmodel(),
    receivableItem: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
  };
  p.$transaction = vi.fn(async (cb: any) => cb(p));
  return { prismaMock: p };
});

vi.mock("../app/lib/prisma", () => ({ default: prismaMock }));
vi.mock("@/app/lib/prisma", () => ({ default: prismaMock }));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { budgetRoutes } from "../app/routes/budget.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(budgetRoutes, { prefix: "/budgets" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
});

const budgetWithItems = {
  id: "b-1",
  userId: "user-owner",
  customerId: "c-1",
  unidadeId: null,
  document: null,
  reason: "Orçamento — Peça",
  totalAmount: "100.00",
  status: "ABERTO",
  validUntil: null,
  items: [
    {
      id: "bi-1",
      productId: "p-1",
      description: null,
      scrapId: null,
      listingId: null,
      quantity: 2,
      unitPrice: "50.00",
    },
  ],
};

const receivableRow = {
  id: "r-1",
  userId: "user-owner",
  customerId: "c-1",
  unidadeId: null,
  document: null,
  reason: "Orçamento — Peça",
  debtDetails: null,
  totalAmount: "100.00",
  fineAmount: null,
  finePercent: null,
  interestPercent: null,
  toleranceDays: null,
  installments: 1,
  periodDays: null,
  dueDate: new Date(),
  status: "PENDENTE",
  paidAt: null,
  paymentMethod: null,
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
      quantity: 2,
      unitPrice: "50.00",
      createdAt: new Date(),
      product: { id: "p-1", sku: "SKU1", name: "Peça" },
    },
  ],
};

describe("POST /budgets/:id/convert", () => {
  it("converte ABERTO → Receivable PENDENTE com itens, vincula budgetId e marca CONVERTIDO", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue(budgetWithItems);
    (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
    (prisma as any).receivable.findUnique.mockResolvedValue(receivableRow);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/convert",
      headers: { email: OWNER },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    // Receivable criado com os itens copiados (markPaid futuro baixa o estoque).
    expect(body.receivable.status).toBe("PENDENTE");
    expect(body.receivable.items).toHaveLength(1);
    expect(body.receivable.items[0]).toMatchObject({
      productId: "p-1",
      quantity: 2,
    });

    // Tudo na MESMA transação.
    expect((prisma as any).$transaction).toHaveBeenCalled();
    // Itens copiados via createMany (mesmo caminho do balcão).
    expect((prisma as any).receivableItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            receivableId: "r-1",
            productId: "p-1",
            quantity: 2,
          }),
        ],
      }),
    );
    // Vínculo bidirecional.
    expect((prisma as any).receivable.update).toHaveBeenCalledWith({
      where: { id: "r-1" },
      data: { budgetId: "b-1" },
    });
    expect((prisma as any).budget.update).toHaveBeenCalledWith({
      where: { id: "b-1" },
      // pipelineStage=GANHO é aditivo (CRM): a coluna Fechado deriva de
      // status=CONVERTIDO; o GANHO só torna o dado do funil explícito.
      data: { status: "CONVERTIDO", pipelineStage: "GANHO" },
    });
  });

  it("bloqueia conversão de orçamento já CONVERTIDO (409, idempotência)", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...budgetWithItems,
      status: "CONVERTIDO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/convert",
      headers: { email: OWNER },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    // Nenhuma conta criada.
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("bloqueia conversão de orçamento CANCELADO (409)", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...budgetWithItems,
      status: "CANCELADO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/convert",
      headers: { email: OWNER },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("rejeita paymentMethod inválido (400)", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue(budgetWithItems);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/convert",
      headers: { email: OWNER },
      payload: { paymentMethod: "MOEDA_FALSA" },
    });

    expect(res.statusCode).toBe(400);
  });
});

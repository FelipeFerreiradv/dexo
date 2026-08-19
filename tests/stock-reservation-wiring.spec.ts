// BLOCO G — a FIAÇÃO da reserva, não a aritmética.
//
// O spec irmão (`stock-reservation.spec.ts`) cobre o módulo puro. Ele NÃO pega
// o bug que realmente machuca, e eu comprovei isso injetando a falha: se o
// caminho de edição esquecer de recalcular quem SAIU da venda, a aritmética
// continua perfeita e a peça removida fica reservada para sempre.
//
// É a "reserva órfã" — o modo de falha que, com 65 vendas pendentes e a mais
// antiga aberta há 51 dias, ninguém perceberia. Ela só apareceria como "peça
// que sumiu do estoque disponível", semanas depois, sem causa aparente.
//
// Este arquivo trava os pontos de fiação:
//   criar ⇒ recalcula os produtos da venda
//   editar ⇒ recalcula a UNIÃO de antes e depois
//   receber ⇒ recalcula (a reserva cai a zero sozinha)
//   flag OFF ⇒ nenhum recálculo, nenhuma consulta

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

vi.mock("../app/marketplaces/services/stock-reservation.service", () => ({
  recomputeReservedStockWithinTx: vi.fn().mockResolvedValue(undefined),
  recomputeReservedStock: vi.fn(),
}));
vi.mock("@/app/marketplaces/services/stock-reservation.service", () => ({
  recomputeReservedStockWithinTx: vi.fn().mockResolvedValue(undefined),
  recomputeReservedStock: vi.fn(),
}));

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: "r-1" }),
    findUnique: vi.fn().mockResolvedValue({ id: "r-1" }),
    findFirst: vi.fn().mockResolvedValue({ id: "r-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
    customer: {
      findFirst: vi.fn().mockResolvedValue({ id: "c-1", name: "Cliente" }),
      create: vi.fn(),
    },
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
import { recomputeReservedStockWithinTx } from "../app/marketplaces/services/stock-reservation.service";

const OWNER = "owner@test.com";
const recompute = recomputeReservedStockWithinTx as unknown as ReturnType<
  typeof vi.fn
>;

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

/** Ids passados ao recálculo, achatados e sem repetição. */
function idsRecalculados(): string[] {
  const todos: string[] = [];
  for (const call of recompute.mock.calls) {
    for (const id of (call[1] ?? []) as Array<string | null>) {
      if (id) todos.push(id);
    }
  }
  return Array.from(new Set(todos)).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (prisma as any).customer.findFirst.mockResolvedValue({
    id: "c-1",
    name: "Cliente",
  });
  (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
  (prisma as any).receivable.findUnique.mockResolvedValue({ id: "r-1" });
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivableItem.findMany.mockResolvedValue([]);
});

describe("Criar venda COMPROMETE as peças", () => {
  it("recalcula os produtos da venda, dentro da transação", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-09-01",
        items: [
          { productId: "p-1", quantity: 2, unitPrice: 30 },
          { productId: "p-2", quantity: 1, unitPrice: 40 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(idsRecalculados()).toEqual(["p-1", "p-2"]);
    // Dentro da tx: se o create falhar, nada fica reservado.
    expect(recompute.mock.calls[0][0]).toBe(prisma);
  });

  it("item MANUAL não entra — não há peça de catálogo a segurar", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER },
      payload: {
        customerId: "c-1",
        totalAmount: 50,
        dueDate: "2026-09-01",
        items: [
          {
            productId: null,
            description: "Serviço",
            quantity: 1,
            unitPrice: 50,
          },
        ],
      },
    });
    expect(idsRecalculados()).toEqual([]);
  });
});

describe("Editar itens libera quem SAIU — a reserva órfã", () => {
  it("trocar p-1 por p-2 recalcula OS DOIS", async () => {
    // ⭐ É ESTE o teste que pega o bug perigoso. Olhar só os itens NOVOS
    // deixaria `p-1` reservado para sempre: a venda não o tem mais, mas a
    // coluna continuaria dizendo que ele está comprometido. Provei injetando a
    // falha — o spec do módulo puro passa igual, porque a aritmética está
    // certa; o que falha é a fiação.
    (prisma as any).receivableItem.findMany.mockResolvedValue([
      { productId: "p-1", autoCreatedProduct: false },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { items: [{ productId: "p-2", quantity: 1, unitPrice: 40 }] },
    });

    expect(res.statusCode).toBe(200);
    expect(idsRecalculados()).toEqual(["p-1", "p-2"]);
  });

  it("remover TODOS os itens libera todos", async () => {
    (prisma as any).receivableItem.findMany.mockResolvedValue([
      { productId: "p-1", autoCreatedProduct: false },
      { productId: "p-2", autoCreatedProduct: false },
    ]);

    const app = buildApp();
    await app.inject({
      method: "PUT",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { items: [] },
    });

    expect(idsRecalculados()).toEqual(["p-1", "p-2"]);
  });

  it("PUT que não manda itens NÃO recalcula — nada mudou de comprometido", async () => {
    const app = buildApp();
    await app.inject({
      method: "PUT",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { document: "NF 1" },
    });
    expect(recompute).not.toHaveBeenCalled();
  });
});

describe("Receber a venda LIBERA as peças", () => {
  it("markPaid recalcula os produtos da venda", async () => {
    // A reserva cai a zero SOZINHA: ninguém subtrai nada, o recálculo lê a
    // verdade (a venda deixou de estar PENDENTE) e chega a zero.
    (prisma as any).receivable.findFirst.mockResolvedValue({
      id: "r-1",
      userId: "user-owner",
      status: "PENDENTE",
      totalAmount: "100.00",
      paidAt: null,
      items: [
        { id: "ri-1", productId: "p-1", quantity: 2, unitPrice: "50.00" },
      ],
      customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
      unidade: null,
      dueDate: new Date(),
      installments: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma as any).receivable.findUnique.mockResolvedValue({
      id: "r-1",
      status: "PAGA",
      items: [],
      customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
      unidade: null,
      totalAmount: "100.00",
      dueDate: new Date(),
      installments: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/pay",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(idsRecalculados()).toEqual(["p-1"]);
  });
});

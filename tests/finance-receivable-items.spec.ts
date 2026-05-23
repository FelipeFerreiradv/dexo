import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Fase 4 — Venda balcão: items opcionais em Receivable + lookup de produto.
//   - POST/PUT aceitam `items?` (só receivable; payable rejeita).
//   - Com items: persistência atômica dentro de $transaction.
//   - Sem items: fluxo atual 100% inalterado (sem $transaction).
//   - GET /finance/products/lookup delega ao NfeDraftUseCase.
// ──────────────────────────────────────────────────────────

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

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // O `$transaction` precisa ser re-armado a cada teste pois é um vi.fn
  // recriado pelo mock acima — mas como o mock é singleton, ele persiste.
  // Garantimos que cb(prisma) volte a funcionar:
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
});

const baseReceivableRow = {
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
};

describe("Fase 4 — POST /finance/receivables com items", () => {
  it("cria conta + items dentro de $transaction (atômico)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
    (prisma as any).receivable.findUnique.mockResolvedValue({
      ...baseReceivableRow,
      items: [
        {
          id: "ri-1",
          productId: "p-1",
          listingId: null,
          quantity: 2,
          unitPrice: "50.00",
          createdAt: new Date(),
          product: { id: "p-1", sku: "SKU-1", name: "Produto 1" },
        },
      ],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
        items: [
          { productId: "p-1", quantity: 2, unitPrice: 50 },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    // Atomicidade: $transaction foi aberta porque tem items.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    // Receivable foi criado dentro da tx.
    expect((prisma as any).receivable.create).toHaveBeenCalledTimes(1);
    // Items persistidos via createMany na MESMA tx.
    expect((prisma as any).receivableItem.createMany).toHaveBeenCalledTimes(1);
    expect((prisma as any).receivableItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          receivableId: "r-1",
          productId: "p-1",
          listingId: null,
          quantity: 2,
          unitPrice: 50,
        },
      ],
    });
    // Response inclui items mapeados (com snapshot de unitPrice).
    const body = JSON.parse(res.payload);
    expect(body.entry.items).toHaveLength(1);
    expect(body.entry.items[0]).toMatchObject({
      productId: "p-1",
      quantity: 2,
      unitPrice: 50,
      product: { id: "p-1", sku: "SKU-1", name: "Produto 1" },
    });
  });

  it("sem items: NÃO abre $transaction (fluxo atual preservado)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).receivable.create.mockResolvedValue({
      ...baseReceivableRow,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    // Sem items => caminho histórico => sem $transaction.
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).receivableItem.createMany).not.toHaveBeenCalled();
  });

  it("items vazio []: trata como sem-items (caminho histórico)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).receivable.create.mockResolvedValue({
      ...baseReceivableRow,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
        items: [],
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).receivableItem.createMany).not.toHaveBeenCalled();
  });

  it("rejeita items em Payable (400)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/payables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
        items: [{ productId: "p-1", quantity: 1, unitPrice: 50 }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/contas a receber/);
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });

  it("rejeita item com quantity zero/negativa (400)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
        items: [{ productId: "p-1", quantity: 0, unitPrice: 50 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/quantidade/i);
  });

  it("rejeita item sem productId (400)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
        items: [{ productId: "", quantity: 1, unitPrice: 50 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/produto/i);
  });
});

describe("Fase 4 — PUT /finance/receivables/:id com items", () => {
  it("replace strategy: deleteMany + createMany dentro de $transaction", async () => {
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivableItem.deleteMany.mockResolvedValue({ count: 2 });
    (prisma as any).receivableItem.createMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue({
      ...baseReceivableRow,
      items: [
        {
          id: "ri-new",
          productId: "p-2",
          listingId: null,
          quantity: 3,
          unitPrice: "30.00",
          createdAt: new Date(),
          product: { id: "p-2", sku: "SKU-2", name: "Produto 2" },
        },
      ],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        totalAmount: 90,
        dueDate: "2026-06-01",
        installments: 1,
        items: [{ productId: "p-2", quantity: 3, unitPrice: 30 }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledTimes(1);
    // Replace: deleteMany dos antigos + createMany dos novos.
    expect((prisma as any).receivableItem.deleteMany).toHaveBeenCalledWith({
      where: { receivableId: "r-1" },
    });
    expect((prisma as any).receivableItem.createMany).toHaveBeenCalledWith({
      data: [
        {
          receivableId: "r-1",
          productId: "p-2",
          listingId: null,
          quantity: 3,
          unitPrice: 30,
        },
      ],
    });
  });

  it("items: [] vazio remove todos os itens (sem createMany)", async () => {
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivableItem.deleteMany.mockResolvedValue({ count: 2 });
    (prisma as any).receivable.findUnique.mockResolvedValue({
      ...baseReceivableRow,
      items: [],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        totalAmount: 0,
        dueDate: "2026-06-01",
        installments: 1,
        items: [],
      },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivableItem.deleteMany).toHaveBeenCalled();
    expect((prisma as any).receivableItem.createMany).not.toHaveBeenCalled();
  });

  it("sem field items: NÃO toca em ReceivableItem (preserva existentes)", async () => {
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue({
      ...baseReceivableRow,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        reason: "Atualizando motivo",
      },
    });

    expect(res.statusCode).toBe(200);
    // Sem field items => sem $transaction nem deleteMany/createMany.
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).receivableItem.deleteMany).not.toHaveBeenCalled();
    expect((prisma as any).receivableItem.createMany).not.toHaveBeenCalled();
  });

  it("PUT em payable com items: rejeita (500 — limitação herdada do buildUpdateHandler que só mapeia 'não encontrado'→404)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/payables/p-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        items: [{ productId: "p-1", quantity: 1, unitPrice: 50 }],
      },
    });
    // Pre-existente: buildUpdateHandler em finance.routes.ts mapeia apenas
    // "não encontrado" → 404; qualquer outro erro → 500. Mesmo padrão do
    // assertUnidade ("Identificador de unidade inválido" também caía em 500
    // no PUT antes da Fase 4). Melhorar este mapeamento está fora do escopo
    // desta fase. O importante é que a validação BARROU a operação:
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload).error).toMatch(/inválidos/i);
    // E nada foi persistido em ReceivableItem:
    expect((prisma as any).receivableItem.deleteMany).not.toHaveBeenCalled();
    expect((prisma as any).receivableItem.createMany).not.toHaveBeenCalled();
  });
});

describe("Fase 4 — GET /finance/products/lookup", () => {
  it("delega ao NfeDraftUseCase e retorna { results }", async () => {
    (prisma as any).product.findMany.mockResolvedValue([
      {
        id: "p-1",
        sku: "SKU-1",
        name: "Produto Um",
        price: "10.50",
        stock: 5,
      },
      {
        id: "p-2",
        sku: "SKU-2",
        name: "Produto Dois",
        price: "20.00",
        stock: 0,
      },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/products/lookup?q=produto",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results).toHaveLength(2);
    // price vira number (mesma transformação do nfe.repository.lookupProducts).
    expect(body.results[0]).toMatchObject({
      id: "p-1",
      sku: "SKU-1",
      name: "Produto Um",
      price: 10.5,
      stock: 5,
    });
    // O usecase fiscal de fato foi chamado (query name/sku/partNumber +
    // userId do dataOwnerId).
    expect((prisma as any).product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-owner" }),
        take: 20,
      }),
    );
  });

  it("query curta (< 2 chars): retorna [] sem hit no banco", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/products/lookup?q=a",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ results: [] });
    expect((prisma as any).product.findMany).not.toHaveBeenCalled();
  });

  it("sem auth: 401", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/products/lookup?q=teste",
      // header email ausente -> middleware mockado retorna 401
    });
    expect(res.statusCode).toBe(401);
  });
});

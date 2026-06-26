import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// Fase C — CRUD de Orçamento (/budgets). Mock total do prisma (igual aos
// specs de finance): create (cliente existente + rápido), list, edit-só-ABERTO,
// cancel e guards de CONVERTIDO. Sem DB real.

// Instância ÚNICA do mock (vi.hoisted) compartilhada pelos dois specifiers —
// código e teste enxergam o MESMO prisma (evita o split de instâncias).
const { prismaMock } = vi.hoisted(() => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  });
  const p: any = {
    budget: fmodel(),
    budgetItem: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    unidade: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
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
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
});

const baseBudgetRow = {
  id: "b-1",
  userId: "user-owner",
  customerId: "c-1",
  unidadeId: null,
  document: null,
  reason: "Orçamento — Peça",
  notes: null,
  totalAmount: "100.00",
  status: "ABERTO",
  validUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
  unidade: null,
  receivable: null,
};

const rowWithItems = {
  ...baseBudgetRow,
  items: [
    {
      id: "bi-1",
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

describe("POST /budgets", () => {
  it("cria orçamento com cliente existente + itens (atômico, com budgetItem)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).budget.create.mockResolvedValue({ id: "b-1" });
    (prisma as any).budget.findUnique.mockResolvedValue(rowWithItems);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { email: OWNER },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        reason: "Orçamento — Peça",
        items: [{ productId: "p-1", quantity: 2, unitPrice: 50 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.budget.items).toHaveLength(1);
    expect((prisma as any).$transaction).toHaveBeenCalled();
    expect((prisma as any).budgetItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ budgetId: "b-1", productId: "p-1", quantity: 2 }),
        ],
      }),
    );
  });

  it("cria orçamento com cliente rápido (cria o cliente na mesma tx)", async () => {
    (prisma as any).customer.create.mockResolvedValue({
      id: "c-new",
      name: "Novo Cliente",
    });
    (prisma as any).budget.create.mockResolvedValue({
      ...baseBudgetRow,
      customerId: "c-new",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { email: OWNER },
      payload: {
        totalAmount: 100,
        newCustomer: { name: "Novo Cliente" },
        reason: "Orçamento",
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).$transaction).toHaveBeenCalled();
    expect((prisma as any).customer.create).toHaveBeenCalled();
    expect((prisma as any).budget.create).toHaveBeenCalled();
  });

  it("rejeita item sem produto nem descrição (400)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { email: OWNER },
      payload: {
        customerId: "c-1",
        totalAmount: 100,
        items: [{ quantity: 1, unitPrice: 50 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("persiste vendedorId quando o vendedor é colaborador do dono", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).user.findUnique.mockResolvedValue({
      id: "v-1",
      email: "vend@t.com",
      password: "x",
      role: "USER",
      parentUserId: "user-owner",
      name: "Vendedor",
      avatarUrl: null,
      isActive: true,
      parent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma as any).budget.create.mockResolvedValue({
      ...baseBudgetRow,
      vendedorId: "v-1",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { email: OWNER },
      payload: { customerId: "c-1", totalAmount: 100, vendedorId: "v-1" },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).budget.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ vendedorId: "v-1" }),
      }),
    );
  });

  it("aceita o próprio dono como vendedor sem consultar a tabela User", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).budget.create.mockResolvedValue({
      ...baseBudgetRow,
      vendedorId: "user-owner",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { email: OWNER },
      payload: { customerId: "c-1", totalAmount: 100, vendedorId: "user-owner" },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });

  it("rejeita vendedor de fora da equipe (400)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({ id: "c-1" });
    (prisma as any).user.findUnique.mockResolvedValue({
      id: "v-x",
      email: "x@t.com",
      password: "x",
      role: "USER",
      parentUserId: "outro-admin",
      name: "Estranho",
      avatarUrl: null,
      isActive: true,
      parent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: { email: OWNER },
      payload: { customerId: "c-1", totalAmount: 100, vendedorId: "v-x" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /budgets (lista)", () => {
  it("retorna { items, pagination }", async () => {
    (prisma as any).budget.findMany.mockResolvedValue([baseBudgetRow]);
    (prisma as any).budget.count.mockResolvedValue(1);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/budgets?page=1&limit=20",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.items).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });
});

describe("PUT /budgets/:id (edição só ABERTO)", () => {
  it("edita um orçamento ABERTO", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue(baseBudgetRow); // guard ABERTO
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).budget.findUnique.mockResolvedValue({
      ...baseBudgetRow,
      reason: "Orçamento — editado",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/budgets/b-1",
      headers: { email: OWNER },
      payload: { reason: "Orçamento — editado" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("bloqueia edição de orçamento CONVERTIDO (409)", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...baseBudgetRow,
      status: "CONVERTIDO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/budgets/b-1",
      headers: { email: OWNER },
      payload: { reason: "x" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("cancel / delete guards", () => {
  it("cancela um orçamento ABERTO (status → CANCELADO)", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...baseBudgetRow,
      status: "CANCELADO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/cancel",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.budget.status).toBe("CANCELADO");
  });

  it("não cancela orçamento CONVERTIDO (409)", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 0 });
    (prisma as any).budget.findFirst.mockResolvedValue({ status: "CONVERTIDO" });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/cancel",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(409);
  });

  it("não exclui orçamento CONVERTIDO (409)", async () => {
    (prisma as any).budget.findFirst.mockResolvedValue({ status: "CONVERTIDO" });

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/budgets/b-1",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(409);
  });
});

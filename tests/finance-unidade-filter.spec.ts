import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Foco: o filtro de unidade é ADITIVO. SEM o parâmetro, listagem
// e summary têm where IDÊNTICO ao comportamento atual (regressão).
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
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma = {
    receivable: fmodel(),
    payable: fmodel(),
    customer: { findFirst: vi.fn() },
    unidade: { findFirst: vi.fn() },
  };
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
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma = {
    receivable: fmodel(),
    payable: fmodel(),
    customer: { findFirst: vi.fn() },
    unidade: { findFirst: vi.fn() },
  };
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
});

describe("finance — filtro de unidade (aditivo / retrocompatível)", () => {
  it("REGRESSÃO: GET /finance/receivables sem unidadeId usa where { userId } (igual a hoje)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
    expect((prisma as any).receivable.count).toHaveBeenCalledWith({
      where: { userId: "user-owner" },
    });
  });

  it("unidadeId=sem_unidade => where { userId, unidadeId: null }", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/payables?unidadeId=sem_unidade",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).payable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", unidadeId: null },
      }),
    );
  });

  it("unidadeId=U1 => where { userId, unidadeId: 'U1' }", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?unidadeId=U1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", unidadeId: "U1" },
      }),
    );
  });

  it("REGRESSÃO: GET /finance/summary sem unidadeId usa where { userId } no groupBy", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
    expect((prisma as any).payable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("GET /finance/summary?unidadeId=U1 injeta unidadeId no groupBy", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?unidadeId=U1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", unidadeId: "U1" },
      }),
    );
  });

  it("POST /finance/receivables com unidadeId válido cria com unidadeId", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).unidade.findFirst.mockResolvedValue({
      id: "U1",
      userId: "user-owner",
    });
    (prisma as any).receivable.create.mockResolvedValue({
      id: "r1",
      userId: "user-owner",
      customerId: "c1",
      unidadeId: "U1",
      totalAmount: "100.00",
      installments: 1,
      dueDate: new Date("2026-06-01"),
      status: "PENDENTE",
      createdAt: new Date(),
      updatedAt: new Date(),
      customer: { id: "c1", name: "Cli", cpf: null, email: null },
      unidade: { id: "U1", name: "Loja Centro" },
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        unidadeId: "U1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unidadeId: "U1", customerId: "c1" }),
      }),
    );
    expect(res.json().entry.unidade).toEqual({ id: "U1", name: "Loja Centro" });
  });

  it("POST /finance/receivables com unidadeId inexistente é rejeitado (4xx) e não cria", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).unidade.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        unidadeId: "U-alheia",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(400);
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("REGRESSÃO: POST /finance/receivables sem unidadeId continua funcionando (não consulta unidade)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).receivable.create.mockResolvedValue({
      id: "r2",
      userId: "user-owner",
      customerId: "c1",
      unidadeId: null,
      totalAmount: "50.00",
      installments: 1,
      dueDate: new Date("2026-06-01"),
      status: "PENDENTE",
      createdAt: new Date(),
      updatedAt: new Date(),
      customer: { id: "c1", name: "Cli", cpf: null, email: null },
      unidade: null,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        totalAmount: 50,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).unidade.findFirst).not.toHaveBeenCalled();
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unidadeId: null }),
      }),
    );
  });
});

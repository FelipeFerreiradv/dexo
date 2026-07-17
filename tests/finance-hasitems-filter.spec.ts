import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// PDV Balcão — filtro hasItems é ADITIVO. SEM o parâmetro, a listagem
// tem where IDÊNTICO ao comportamento atual (regressão). Só o literal
// "true" ativa; em payable é ignorado (Payable não tem relação items).
// Harness clonado de tests/finance-unidade-filter.spec.ts.
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

describe("finance — filtro hasItems (PDV, aditivo / retrocompatível)", () => {
  it("REGRESSÃO: GET /finance/receivables sem hasItems usa where { userId } (sem chave items)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    // where EXATO: nenhuma chave `items` pode vazar quando o param está ausente.
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
    expect((prisma as any).receivable.count).toHaveBeenCalledWith({
      where: { userId: "user-owner" },
    });
  });

  it("hasItems=true em receivables => where { userId, items: { some: {} } }", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?hasItems=true",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", items: { some: {} } },
      }),
    );
  });

  it("hasItems=false => sem filtro (where idêntico ao atual)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?hasItems=false",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("hasItems=lixo (ex.: '1') => sem filtro (só o literal 'true' ativa)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?hasItems=1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("GUARD: hasItems=true em payables é IGNORADO (Payable não tem relação items)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/payables?hasItems=true",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).payable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("REGRESSÃO: GET /finance/summary sem hasItems usa where { userId } nos dois modelos", async () => {
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

  it("GET /finance/summary?hasItems=true filtra SÓ o bucket de receivables; payables intocado", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?hasItems=true",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", items: { some: {} } },
      }),
    );
    expect((prisma as any).receivable.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-owner",
          items: { some: {} },
        }),
      }),
    );
    // GUARD: o modelo payable NUNCA recebe o filtro de items.
    expect((prisma as any).payable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("hasItems=true compõe com os filtros existentes (unidadeId, paymentMethod)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?hasItems=true&unidadeId=U1&paymentMethod=PIX",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-owner",
          unidadeId: "U1",
          paymentMethod: "PIX",
          items: { some: {} },
        },
      }),
    );
  });
});

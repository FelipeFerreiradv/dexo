import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Forma de pagamento (paymentMethod) — ADITIVO e OPCIONAL.
// Cobre: create com/sem método (receivable + payable), método inválido
// (400 no create / 500 no update — decisão Fase 1), update do método e
// filtro por método na listagem. SEM método => comportamento idêntico ao
// atual (where { userId } byte-idêntico; data.paymentMethod null).
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

function makeCreatedRaw(overrides: Partial<any> = {}) {
  return {
    id: "r1",
    userId: "user-owner",
    customerId: "c1",
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
    paymentMethod: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Forma de pagamento — create/update/filtro (aditivo)", () => {
  it("CREATE com paymentMethod válido persiste e retorna o método", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).receivable.create.mockResolvedValue(
      makeCreatedRaw({ paymentMethod: "PIX" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
        paymentMethod: "PIX",
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: "PIX" }),
      }),
    );
    expect(res.json().entry.paymentMethod).toBe("PIX");
  });

  it("REGRESSÃO: CREATE sem paymentMethod => data.paymentMethod null e entry.paymentMethod null", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).receivable.create.mockResolvedValue(
      makeCreatedRaw({ paymentMethod: null }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: null }),
      }),
    );
    expect(res.json().entry.paymentMethod).toBeNull();
  });

  it("CREATE com paymentMethod inválido => 400 e não cria", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        totalAmount: 100,
        dueDate: "2026-06-01",
        paymentMethod: "CARTAO_XYZ",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/inválido/i);
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("CREATE payable com paymentMethod válido persiste", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).payable.create.mockResolvedValue(
      makeCreatedRaw({
        id: "p1",
        paymentMethod: "BOLETO",
        totalAmount: "75.00",
      }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/payables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        customerId: "c1",
        totalAmount: 75,
        dueDate: "2026-06-01",
        paymentMethod: "BOLETO",
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).payable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: "BOLETO" }),
      }),
    );
  });

  it("UPDATE com paymentMethod válido flui pro update data e retorna", async () => {
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeCreatedRaw({ paymentMethod: "CREDITO" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { paymentMethod: "CREDITO" },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", userId: "user-owner" },
        data: expect.objectContaining({ paymentMethod: "CREDITO" }),
      }),
    );
    expect(res.json().entry.paymentMethod).toBe("CREDITO");
  });

  it("UPDATE com paymentMethod inválido => 500 (route não mapeia 400; decisão Fase 1) e não persiste", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { paymentMethod: "NOPE" },
    });

    expect(res.statusCode).toBe(500);
    expect((prisma as any).receivable.updateMany).not.toHaveBeenCalled();
  });

  it("LIST ?paymentMethod=PIX injeta where.paymentMethod", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?paymentMethod=PIX",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", paymentMethod: "PIX" },
      }),
    );
  });

  it("REGRESSÃO: LIST sem paymentMethod => where { userId } (byte-idêntico ao atual)", async () => {
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
  });

  // ── Paridade payable (mesma cadeia genérica de receivable) ──

  it("LIST payable ?paymentMethod=PIX injeta where.paymentMethod", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/payables?paymentMethod=PIX",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).payable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", paymentMethod: "PIX" },
      }),
    );
  });

  it("REGRESSÃO: LIST payable sem paymentMethod => where { userId }", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/payables",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).payable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("REGRESSÃO: CREATE payable sem paymentMethod => data.paymentMethod null", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).payable.create.mockResolvedValue(
      makeCreatedRaw({ id: "p9", paymentMethod: null, totalAmount: "40.00" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/payables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { customerId: "c1", totalAmount: 40, dueDate: "2026-06-01" },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).payable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: null }),
      }),
    );
    expect(res.json().entry.paymentMethod).toBeNull();
  });

  it("UPDATE limpando o método (paymentMethod null) => 200 e flui null pro data (sem 500)", async () => {
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeCreatedRaw({ paymentMethod: null }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/finance/receivables/r1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { paymentMethod: null },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", userId: "user-owner" },
        data: expect.objectContaining({ paymentMethod: null }),
      }),
    );
    expect(res.json().entry.paymentMethod).toBeNull();
  });
});

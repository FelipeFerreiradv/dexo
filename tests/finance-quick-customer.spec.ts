import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Alteração B — cadastro rápido de cliente (CPF-only) ao criar conta.
// Cliente + conta numa única transação. Fluxo SEM newCustomer = idêntico.
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
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
  };
  // $transaction repassa o próprio mock como "tx" (mesmo padrão do projeto).
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
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
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
const CPF = "39053344705"; // 11 dígitos

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Alteração B — cadastro rápido de cliente", () => {
  it("cria cliente + conta na mesma transação (201)", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue(null); // CPF livre
    (prisma as any).customer.create.mockResolvedValue({
      id: "c-new",
      userId: "user-owner",
      name: "Maria Silva",
      cpf: CPF,
    });
    (prisma as any).receivable.create.mockResolvedValue({
      id: "r1",
      userId: "user-owner",
      customerId: "c-new",
      unidadeId: null,
      totalAmount: "100.00",
      installments: 1,
      dueDate: new Date("2026-06-01"),
      status: "PENDENTE",
      createdAt: new Date(),
      updatedAt: new Date(),
      customer: { id: "c-new", name: "Maria Silva", cpf: CPF, email: null },
      unidade: null,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        newCustomer: { name: "Maria Silva", cpf: CPF },
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as any).customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-owner",
          name: "Maria Silva",
        }),
      }),
    );
    expect((prisma as any).receivable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerId: "c-new" }),
      }),
    );
    expect(res.json().entry.customerId).toBe("c-new");
  });

  it("atômico: criação dentro de $transaction; falha na conta propaga erro", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue(null);
    (prisma as any).customer.create.mockResolvedValue({
      id: "c-new",
      userId: "user-owner",
      name: "Maria Silva",
    });
    // A conta falha => $transaction rejeita => Prisma faz rollback do cliente.
    (prisma as any).receivable.create.mockRejectedValue(
      new Error("db down"),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        newCustomer: { name: "Maria Silva", cpf: CPF },
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(500);
    // O wrapper transacional existe (Prisma garante rollback do cliente
    // quando o callback lança).
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
  });

  it("CPF duplicado => 409 e não cria a conta", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c-old",
      userId: "user-owner",
      cpf: CPF,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        newCustomer: { name: "Maria Silva", cpf: CPF },
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(409);
    expect((prisma as any).customer.create).not.toHaveBeenCalled();
    expect((prisma as any).receivable.create).not.toHaveBeenCalled();
  });

  it("400 quando newCustomer sem nome", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        newCustomer: { cpf: CPF },
        totalAmount: 100,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(400);
    expect((prisma as any).customer.create).not.toHaveBeenCalled();
  });

  it("REGRESSÃO: sem newCustomer (cliente existente) funciona idêntico — sem $transaction", async () => {
    (prisma as any).customer.findFirst.mockResolvedValue({
      id: "c1",
      userId: "user-owner",
    });
    (prisma as any).receivable.create.mockResolvedValue({
      id: "r9",
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
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).customer.create).not.toHaveBeenCalled();
    expect((prisma as any).receivable.create).toHaveBeenCalledTimes(1);
  });

  it("REGRESSÃO: sem customerId e sem newCustomer => 400 (mensagem atual)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        totalAmount: 50,
        dueDate: "2026-06-01",
        installments: 1,
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

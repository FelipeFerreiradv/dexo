import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// GET /finance/receivables/:id (e /payables/:id) — entry único COM itens.
// Contrato do qual a EDIÇÃO depende: a lista (findAll) não traz itens (egress),
// então a tela de editar carrega os itens por aqui. Sem isso, adicionar um item
// na edição faria o update dar "replace" e APAGAR os itens pré-existentes
// (perda de dados + total recalculado errado). Este teste tranca esse contrato.
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

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

// Vencimento no futuro p/ não disparar a marcação automática de VENCIDA.
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

function rawReceivableWithItems() {
  return {
    id: "r1",
    userId: "user-owner",
    customerId: "c1",
    document: "NF 1",
    reason: "Venda balcão — Cubo de roda fiat uno e mais 1 item",
    debtDetails: null,
    totalAmount: "100.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: FUTURE,
    status: "PENDENTE",
    paidAt: null,
    paymentMethod: "DINHEIRO",
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c1", name: "Felipe", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "it-1",
        productId: null,
        description: "Cubo de roda fiat uno",
        scrapId: "scrap-9",
        listingId: null,
        quantity: 1,
        unitPrice: "40.00",
        createdAt: new Date(),
        product: null,
      },
      {
        id: "it-2",
        productId: "p-100",
        description: null,
        scrapId: null,
        listingId: null,
        quantity: 1,
        unitPrice: "60.00",
        createdAt: new Date(),
        product: { id: "p-100", sku: "ABC-1", name: "Acabamento de porta" },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /finance/receivables/:id — carrega itens p/ edição (anti-replace)", () => {
  it("retorna o entry COM todos os itens (manual + cadastrado) e seus escalares", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      rawReceivableWithItems(),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables/r1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const entry = res.json().entry;
    expect(entry.id).toBe("r1");
    // Os DOIS itens precisam voltar — é isso que a edição reenvia no update
    // para o backend NÃO apagar os pré-existentes (replace strategy).
    expect(Array.isArray(entry.items)).toBe(true);
    expect(entry.items).toHaveLength(2);

    const manual = entry.items.find((i: any) => i.productId == null);
    expect(manual.description).toBe("Cubo de roda fiat uno");
    expect(manual.scrapId).toBe("scrap-9");
    expect(manual.unitPrice).toBe(40);

    const cadastrado = entry.items.find((i: any) => i.productId === "p-100");
    expect(cadastrado.product).toEqual({
      id: "p-100",
      sku: "ABC-1",
      name: "Acabamento de porta",
    });
    expect(cadastrado.unitPrice).toBe(60);

    // Escopo de dono: a busca filtra por { id, userId } (ownership-aware).
    expect((prisma as any).receivable.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", userId: "user-owner" },
      }),
    );
  });

  it("inclui os itens via include (não pode virar lista 'magra' sem itens)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      rawReceivableWithItems(),
    );
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/finance/receivables/r1",
      headers: { email: OWNER },
    });

    const callArg = (prisma as any).receivable.findFirst.mock.calls[0][0];
    expect(callArg.include).toBeTruthy();
    expect(callArg.include.items).toBeTruthy();
  });

  it("404 quando a conta não existe (ou é de outro dono)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables/nope",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401 sem autenticação (email ausente)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables/r1",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /finance/payables/:id também responde (simetria; payable sem itens)", async () => {
    (prisma as any).payable.findFirst.mockResolvedValue({
      id: "pay-1",
      userId: "user-owner",
      customerId: "c1",
      document: null,
      reason: "Conta de luz",
      debtDetails: null,
      totalAmount: "80.00",
      installments: 1,
      periodDays: null,
      dueDate: FUTURE,
      status: "PENDENTE",
      paidAt: null,
      paymentMethod: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      customer: { id: "c1", name: "Felipe", cpf: null, email: null },
      unidade: null,
    });
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/payables/pay-1",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.id).toBe("pay-1");
  });
});

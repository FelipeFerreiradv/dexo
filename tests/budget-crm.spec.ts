import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// CRM de Orçamentos — cobre as adições ADITIVAS: PATCH /stage (funil), cancel
// com opts (Perdido/Cancelado) e a derivação/matriz de transições (pura).
// Mock total do prisma, igual aos demais specs de budget. Sem DB real.

const { prismaMock } = vi.hoisted(() => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
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
    customer: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
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
import {
  deriveColumn,
  planTransition,
  type CrmBudget,
} from "../app/clientes/components/budget-crm-shared";

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

const openRow = {
  id: "b-1",
  userId: "user-owner",
  customerId: "c-1",
  unidadeId: null,
  vendedorId: null,
  document: null,
  reason: "Orçamento",
  notes: null,
  totalAmount: "100.00",
  status: "ABERTO",
  validUntil: null,
  pipelineStage: null,
  lostReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
  unidade: null,
  vendedor: null,
  receivable: null,
};

describe("PATCH /budgets/:id/stage (funil, aberto→aberto)", () => {
  it("move um orçamento ABERTO para EM_NEGOCIACAO (200) só via pipelineStage", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...openRow,
      pipelineStage: "EM_NEGOCIACAO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/budgets/b-1/stage",
      headers: { email: OWNER },
      payload: { pipelineStage: "EM_NEGOCIACAO" },
    });

    expect(res.statusCode).toBe(200);
    // Guarda atômica: só ABERTO muda de estágio; escopo por userId.
    expect((prisma as any).budget.updateMany).toHaveBeenCalledWith({
      where: { id: "b-1", userId: "user-owner", status: "ABERTO" },
      data: { pipelineStage: "EM_NEGOCIACAO" },
    });
  });

  it("rejeita estágio não-aberto no /stage (GANHO → 400)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/budgets/b-1/stage",
      headers: { email: OWNER },
      payload: { pipelineStage: "GANHO" },
    });
    expect(res.statusCode).toBe(400);
    expect((prisma as any).budget.updateMany).not.toHaveBeenCalled();
  });

  it("409 quando o orçamento não está ABERTO (ex.: CONVERTIDO)", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 0 });
    (prisma as any).budget.findFirst.mockResolvedValue({
      status: "CONVERTIDO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/budgets/b-1/stage",
      headers: { email: OWNER },
      payload: { pipelineStage: "PROPOSTA_ENVIADA" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404 quando o orçamento não existe", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 0 });
    (prisma as any).budget.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/budgets/x/stage",
      headers: { email: OWNER },
      payload: { pipelineStage: "NOVO" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /budgets/:id/cancel (opts do kanban)", () => {
  it("Perdido: grava status=CANCELADO, pipelineStage=PERDIDO e lostReason", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...openRow,
      status: "CANCELADO",
      pipelineStage: "PERDIDO",
      lostReason: "preço",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/cancel",
      headers: { email: OWNER },
      payload: { pipelineStage: "PERDIDO", lostReason: "preço" },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).budget.updateMany).toHaveBeenCalledWith({
      where: { id: "b-1", userId: "user-owner", status: { not: "CONVERTIDO" } },
      data: {
        status: "CANCELADO",
        pipelineStage: "PERDIDO",
        lostReason: "preço",
      },
    });
    const body = JSON.parse(res.payload);
    expect(body.budget.pipelineStage).toBe("PERDIDO");
  });

  it("cancel SEM body segue idêntico (default pipelineStage=CANCELADO)", async () => {
    (prisma as any).budget.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).budget.findFirst.mockResolvedValue({
      ...openRow,
      status: "CANCELADO",
      pipelineStage: "CANCELADO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/cancel",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).budget.updateMany).toHaveBeenCalledWith({
      where: { id: "b-1", userId: "user-owner", status: { not: "CONVERTIDO" } },
      data: { status: "CANCELADO", pipelineStage: "CANCELADO" },
    });
  });

  it("rejeita pipelineStage inválido no cancel (GANHO → 400)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/budgets/b-1/cancel",
      headers: { email: OWNER },
      payload: { pipelineStage: "GANHO" },
    });
    expect(res.statusCode).toBe(400);
    expect((prisma as any).budget.updateMany).not.toHaveBeenCalled();
  });
});

// ── Derivação da coluna + matriz de transições (pura, sem mocks) ──────────
function b(partial: Partial<CrmBudget>): CrmBudget {
  return {
    id: "x",
    document: null,
    reason: null,
    totalAmount: 0,
    validUntil: null,
    status: "ABERTO",
    pipelineStage: null,
    customer: null,
    ...partial,
  };
}

describe("deriveColumn (read-time)", () => {
  it("CONVERTIDO → GANHO (Fechado), ignorando o pipelineStage", () => {
    expect(deriveColumn(b({ status: "CONVERTIDO", pipelineStage: null }))).toBe(
      "GANHO",
    );
    expect(
      deriveColumn(b({ status: "CONVERTIDO", pipelineStage: "GANHO" })),
    ).toBe("GANHO");
  });
  it("CANCELADO + PERDIDO → Perdido; demais CANCELADO → Cancelado", () => {
    expect(
      deriveColumn(b({ status: "CANCELADO", pipelineStage: "PERDIDO" })),
    ).toBe("PERDIDO");
    expect(deriveColumn(b({ status: "CANCELADO", pipelineStage: null }))).toBe(
      "CANCELADO",
    );
    // estágio aberto "estagnado" num cancelado ainda cai em Cancelado.
    expect(
      deriveColumn(b({ status: "CANCELADO", pipelineStage: "EM_NEGOCIACAO" })),
    ).toBe("CANCELADO");
  });
  it("ABERTO/EXPIRADO usa o pipelineStage; null → Novo", () => {
    expect(deriveColumn(b({ status: "ABERTO", pipelineStage: null }))).toBe(
      "NOVO",
    );
    expect(
      deriveColumn(b({ status: "ABERTO", pipelineStage: "PROPOSTA_ENVIADA" })),
    ).toBe("PROPOSTA_ENVIADA");
    expect(
      deriveColumn(b({ status: "EXPIRADO", pipelineStage: "EM_NEGOCIACAO" })),
    ).toBe("EM_NEGOCIACAO");
  });
});

describe("planTransition (matriz)", () => {
  it("aberto→aberto = stage", () => {
    expect(planTransition("NOVO", "EM_NEGOCIACAO")).toEqual({
      kind: "stage",
      stage: "EM_NEGOCIACAO",
    });
  });
  it("aberto→Fechado = convert; aberto→Perdido/Cancelado = cancel", () => {
    expect(planTransition("NOVO", "GANHO")).toEqual({ kind: "convert" });
    expect(planTransition("EM_NEGOCIACAO", "PERDIDO")).toEqual({
      kind: "cancel",
      pipelineStage: "PERDIDO",
    });
    expect(planTransition("PROPOSTA_ENVIADA", "CANCELADO")).toEqual({
      kind: "cancel",
      pipelineStage: "CANCELADO",
    });
  });
  it("sair de Fechado/Cancelado/Perdido = blocked; mesma coluna = noop", () => {
    expect(planTransition("GANHO", "NOVO").kind).toBe("blocked");
    expect(planTransition("CANCELADO", "NOVO").kind).toBe("blocked");
    expect(planTransition("PERDIDO", "EM_NEGOCIACAO").kind).toBe("blocked");
    expect(planTransition("NOVO", "NOVO").kind).toBe("noop");
  });
});

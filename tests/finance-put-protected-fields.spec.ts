// Fase 1.2 — o PUT não pode governar status nem baixa.
//
// `buildUpdateHandler` repassava o body CRU, e `updateSingle` faz `{...data}`
// direto no `updateMany` — na prática qualquer coluna escalar da tabela era
// gravável por HTTP. Dois casos causavam dano de integridade REAL:
//
//   PUT {status:"CANCELADA"} → cancelava a venda SEM devolver estoque, sem
//   StockLog e sem reconciliar a sucata. Pior: o `POST /reverse` legítimo
//   virava no-op depois, porque a guarda de idempotência vê CANCELADA.
//
//   PUT {status:"PAGA", paidAt} → contornava o `markPaid` inteiro (sem baixa
//   de estoque, sem promoção de peça avulsa, sem pauseOnZero) ⇒ oversell.
//
// O guard também vale para /payables — o handler é compartilhado.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

const updateSpy = vi.fn();

vi.mock("../app/usecases/finance.usecase", () => ({
  FinanceUseCase: class {
    update = updateSpy;
    list = vi.fn().mockResolvedValue({ items: [], total: 0, totalPages: 0 });
    findById = vi.fn();
    create = vi.fn();
    markPaid = vi.fn();
    reverse = vi.fn();
    delete = vi.fn();
    summary = vi.fn();
    lookupProducts = vi.fn();
  },
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import { financeRoutes } from "../app/routes/finance.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

async function put(path: string, payload: Record<string, unknown>) {
  const app = buildApp();
  const res = await app.inject({
    method: "PUT",
    url: path,
    headers: { email: OWNER },
    payload,
  });
  await app.close();
  return res;
}

describe("Fase 1.2 — PUT rejeita status e paidAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSpy.mockResolvedValue({ id: "r-1" });
  });

  it("PUT {status:'CANCELADA'} devolve 400 e NÃO chega ao usecase", async () => {
    const res = await put("/finance/receivables/r-1", {
      status: "CANCELADA",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("status");
    // O ponto: o dano é impedido ANTES da persistência.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("PUT {status:'PAGA', paidAt} devolve 400 (contornaria o markPaid)", async () => {
    const res = await put("/finance/receivables/r-1", {
      status: "PAGA",
      paidAt: new Date().toISOString(),
    });

    expect(res.statusCode).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("a mensagem aponta a rota correta em vez de só negar", async () => {
    const res = await put("/finance/receivables/r-1", { status: "PAGA" });
    const erro = res.json().error as string;
    expect(erro).toContain("/pay");
    expect(erro).toContain("/reverse");
  });

  it("o guard vale também para contas a pagar (handler compartilhado)", async () => {
    const res = await put("/finance/payables/p-1", { status: "PAGA" });
    expect(res.statusCode).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe("Fase 1.2 — PUT preserva a edição legítima", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSpy.mockResolvedValue({ id: "r-1" });
  });

  it("passa adiante todos os campos do contrato", async () => {
    const body = {
      customerId: "c-1",
      unidadeId: null,
      document: "DOC-1",
      reason: "Serviço",
      debtDetails: "detalhe",
      totalAmount: 500,
      fineAmount: 50,
      finePercent: 2,
      interestPercent: 1.5,
      toleranceDays: 5,
      installments: 1,
      periodDays: 15,
      dueDate: "2026-09-01T00:00:00.000Z",
      paymentMethod: "PIX",
      items: [{ productId: "p-1", quantity: 1, unitPrice: 500 }],
      payments: [{ method: "PIX", amount: 500 }],
    };

    const res = await put("/finance/receivables/r-1", body);

    expect(res.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][3]).toEqual(body);
  });

  it("descarta campo fora do contrato SEM quebrar a edição", async () => {
    // O formulário reenvia campos de tela (ex.: `id`). Rejeitar quebraria a
    // edição sem ganho; descartar deixa o update idêntico ao de hoje.
    const res = await put("/finance/receivables/r-1", {
      id: "r-1",
      totalAmount: 500,
      parentReceivableId: "outra-conta",
      budgetId: "b-1",
      userId: "outro-tenant",
    });

    expect(res.statusCode).toBe(200);
    expect(updateSpy.mock.calls[0][3]).toEqual({ totalAmount: 500 });
  });

  it("body vazio não explode", async () => {
    const res = await put("/finance/receivables/r-1", {});
    expect(res.statusCode).toBe(200);
    expect(updateSpy.mock.calls[0][3]).toEqual({});
  });
});

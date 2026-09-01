import { describe, it, expect, vi, beforeEach } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────────────────────
// Isolamento multi-tenant das devoluções (contrato §5 + §8.3).
//
// A pendência de devolução é uma peça de estoque exposta numa tela nova, com
// um botão que MEXE EM ESTOQUE. Um vazamento aqui não é leitura indevida: é o
// tenant A repondo estoque no produto do tenant B.
//
// Prova, no molde de tests/security/idor-isolation.spec.ts (captura o `where`
// que chega ao prisma, em vez de asseverar o retorno):
//  - a LISTAGEM escopa por `marketplaceAccount: { userId }`, nunca por id cru;
//  - a RESOLUÇÃO sonda a posse ANTES de agir, e nega com 404 quem não é dono;
//  - negado ⇒ o use case que mexe em estoque NUNCA é chamado;
//  - o escopo usa `dataOwnerId` (colaborador herda do admin), não `user.id`.
// ──────────────────────────────────────────────────────────────────────────

// Colaborador: `id` é dele, `dataOwnerId` é do admin pai. O escopo de dados
// TEM que sair do segundo — é a regra canônica do authMiddleware.
vi.mock("../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "colaborador-1", dataOwnerId: "admin-pai" };
  },
}));
vi.mock("@/app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "colaborador-1", dataOwnerId: "admin-pai" };
  },
}));

import prisma from "../../app/lib/prisma";
import { orderRoutes } from "../../app/routes/order.routes";
import { OrderUseCase } from "../../app/marketplaces/usecases/order.usercase";

const EMAIL = "colab@test.com";

const calls: Record<string, any[]> = {
  count: [],
  findMany: [],
  findFirst: [],
};

function buildApp() {
  const app = fastify();
  app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

let resolveSpy: any;

beforeEach(() => {
  calls.count.length = 0;
  calls.findMany.length = 0;
  calls.findFirst.length = 0;
  vi.restoreAllMocks();

  // O model é acessado via `(prisma as any).orderReturnPendency` (o client
  // gerado só existe depois da migration), então o delegate é injetado aqui.
  (prisma as any).orderReturnPendency = {
    count: vi.fn((args: any) => {
      calls.count.push(args);
      return Promise.resolve(0);
    }),
    findMany: vi.fn((args: any) => {
      calls.findMany.push(args);
      return Promise.resolve([]);
    }),
    findFirst: vi.fn((args: any) => {
      calls.findFirst.push(args);
      // Simula "não é dono": a sonda de posse não encontra nada.
      return Promise.resolve(null);
    }),
  };

  resolveSpy = vi
    .spyOn(OrderUseCase, "resolveReturnPendency")
    .mockResolvedValue({
      success: true,
      action: "resolved_restocked",
      restoredItems: 1,
    });
});

describe("GET /orders/return-pendencies — escopo de tenant", () => {
  it("filtra por marketplaceAccount.userId, e pelo dataOwnerId", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/return-pendencies",
      headers: { email: EMAIL },
    });

    expect(res.statusCode).toBe(200);
    expect(calls.findMany[0].where).toMatchObject({
      status: { in: ["OPEN", "NEEDS_ACTION"] },
      marketplaceAccount: { userId: "admin-pai" },
    });
    // O `id` do colaborador NUNCA pode aparecer no escopo de dados.
    expect(JSON.stringify(calls.findMany[0].where)).not.toContain(
      "colaborador-1",
    );
  });

  it("a CONTAGEM usa o mesmo filtro da listagem (nada de total global)", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/orders/return-pendencies",
      headers: { email: EMAIL },
    });
    expect(calls.count[0].where).toEqual(calls.findMany[0].where);
  });

  it("sem autenticação → 401 e nenhuma consulta", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders/return-pendencies",
    });
    expect(res.statusCode).toBe(401);
    expect(calls.findMany.length).toBe(0);
  });
});

describe("POST /orders/return-pendencies/:id/resolve — posse antes de agir", () => {
  it("⭐ pendência de OUTRO tenant → 404 e o estoque NUNCA é tocado", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/return-pendencies/pend-de-outro/resolve",
      headers: { email: EMAIL },
      payload: { outcome: "RECEBIDA" },
    });

    expect(res.statusCode).toBe(404);
    // A sonda de posse foi feita com o escopo do tenant...
    expect(calls.findFirst[0].where).toMatchObject({
      id: "pend-de-outro",
      marketplaceAccount: { userId: "admin-pai" },
    });
    // ...e o caminho que mexe em estoque não rodou.
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("desfecho inválido → 400 antes de qualquer consulta", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/return-pendencies/pend-1/resolve",
      headers: { email: EMAIL },
      payload: { outcome: "TALVEZ" },
    });

    expect(res.statusCode).toBe(400);
    expect(calls.findFirst.length).toBe(0);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("VENDA_MANTIDA não é decisão de operador — só o reconciliador fecha assim", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/return-pendencies/pend-1/resolve",
      headers: { email: EMAIL },
      payload: { outcome: "VENDA_MANTIDA" },
    });
    expect(res.statusCode).toBe(400);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("dono legítimo: o use case recebe o tenant, não o id do colaborador", async () => {
    (prisma as any).orderReturnPendency.findFirst = vi.fn(() =>
      Promise.resolve({
        id: "pend-1",
        marketplaceAccountId: "acc-1",
        externalOrderId: "999",
      }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/return-pendencies/pend-1/resolve",
      headers: { email: EMAIL },
      payload: { outcome: "RECEBIDA" },
    });

    expect(res.statusCode).toBe(200);
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplaceAccountId: "acc-1",
        externalOrderId: "999",
        outcome: "RECEBIDA",
        // escopo de DADOS = admin pai
        userId: "admin-pai",
        // autoria = quem clicou
        resolvedByUserId: "colaborador-1",
      }),
    );
  });

  it("sem autenticação → 401 e nada acontece", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/return-pendencies/pend-1/resolve",
      payload: { outcome: "RECEBIDA" },
    });
    expect(res.statusCode).toBe(401);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

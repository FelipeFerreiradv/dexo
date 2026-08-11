import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

let currentUser: any = null;
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = currentUser;
  },
}));

const findUniqueMock = vi.fn();
const acaoFindFirstMock = vi.fn();
const memoriaFindManyMock = vi.fn();
const memoriaDeleteManyMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    user: { findUnique: (...a: any[]) => findUniqueMock(...a) },
    aiAction: { findFirst: (...a: any[]) => acaoFindFirstMock(...a) },
    aiMemory: {
      findMany: (...a: any[]) => memoriaFindManyMock(...a),
      deleteMany: (...a: any[]) => memoriaDeleteManyMock(...a),
    },
    systemLog: { create: async () => ({}) },
  },
}));

const confirmarMock = vi.fn();
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    confirmarAcao: (...a: any[]) => confirmarMock(...a),
    cancelarAcao: async () => ({ ok: true, status: "cancelada" }),
  };
});

import { aiRoutes } from "../app/routes/ai.routes";
import { clearAiEntitlementCache } from "../app/ai/entitlement/ai-entitlement.service";

// ===========================================================================
// AS ROTAS DA MEMÓRIA (Fase 11).
//
// ⭐⭐ SÓ O ADMINISTRADOR, e a trava é SERVIDOR — esconder o botão nunca foi
// permissão. A lista é o conteúdo integral das regras da casa (markup, política
// de desconto); ela já influencia a RESPOSTA que o colaborador recebe, e abrir
// o texto cru para ele é outra coisa.
//
// ⭐ E o escopo é `dataOwnerId`, não `actorUserId`: memória é da LOJA. É o
// oposto das conversas, e trocar um pelo outro seria o vazamento mais caro
// deste módulo — a regra de negócio de uma loja entrando no prompt de outra.
// ===========================================================================

const admin = () => ({ id: "u1", dataOwnerId: "t1", role: "ADMIN" });

const colaborador = () => ({
  id: "u9",
  dataOwnerId: "t1",
  parentUserId: "t1",
  role: "USER",
  pagePermissions: null,
});

describe("GET e DELETE /ai/memorias", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = admin();
    findUniqueMock.mockReset().mockResolvedValue({
      aiEnabledAt: new Date(),
      aiDailyLimit: null,
    });
    memoriaFindManyMock.mockReset().mockResolvedValue([
      {
        id: "m1",
        topico: "preco",
        conteudo: "meu markup padrao e 2,2x",
        createdAt: new Date("2026-08-10T10:00:00Z"),
      },
    ]);
    memoriaDeleteManyMock.mockReset().mockResolvedValue({ count: 1 });
    clearAiEntitlementCache();

    app = fastify();
    await app.register(aiRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("o administrador vê a memória da loja, com o rótulo pronto", async () => {
    const res = await app.inject({ method: "GET", url: "/memorias" });
    expect(res.statusCode).toBe(200);
    const { memorias } = res.json();
    expect(memorias).toHaveLength(1);
    expect(memorias[0].conteudo).toBe("meu markup padrao e 2,2x");
    expect(memorias[0].topicoLabel).toBe("Preço e margem");
  });

  it("⭐ a leitura é escopada por LOJA, nunca por quem digitou", async () => {
    await app.inject({ method: "GET", url: "/memorias" });
    const where = memoriaFindManyMock.mock.calls[0][0].where;
    expect(where).toEqual({ dataOwnerId: "t1" });
    expect(JSON.stringify(where)).not.toContain("actorUserId");
  });

  it("⭐⭐ colaborador: 403 na listagem, mesmo com todas as permissões", async () => {
    currentUser = colaborador();
    const res = await app.inject({ method: "GET", url: "/memorias" });
    expect(res.statusCode).toBe(403);
    expect(memoriaFindManyMock).not.toHaveBeenCalled();
  });

  it("⭐⭐ colaborador: 403 ao apagar — e nada é apagado", async () => {
    currentUser = colaborador();
    const res = await app.inject({ method: "DELETE", url: "/memorias/m1" });
    expect(res.statusCode).toBe(403);
    expect(memoriaDeleteManyMock).not.toHaveBeenCalled();
  });

  it("sem sessão: 401 nas duas", async () => {
    currentUser = null;
    expect((await app.inject({ method: "GET", url: "/memorias" })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: "DELETE", url: "/memorias/m1" })).statusCode,
    ).toBe(401);
  });

  it("⭐ apagar usa deleteMany COM o tenant — id de outra loja não apaga nada", async () => {
    const res = await app.inject({ method: "DELETE", url: "/memorias/m1" });
    expect(res.statusCode).toBe(204);
    expect(memoriaDeleteManyMock).toHaveBeenCalledWith({
      where: { id: "m1", dataOwnerId: "t1" },
    });
  });

  it("id que não é desta loja: 404, e nada foi apagado", async () => {
    memoriaDeleteManyMock.mockResolvedValue({ count: 0 });
    const res = await app.inject({ method: "DELETE", url: "/memorias/de-outro" });
    expect(res.statusCode).toBe(404);
  });

  it("sem plano contratado: 403 como todas as rotas de /ai/*", async () => {
    findUniqueMock.mockResolvedValue({ aiEnabledAt: null, aiDailyLimit: null });
    clearAiEntitlementCache();
    const res = await app.inject({ method: "GET", url: "/memorias" });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe("POST /ai/acoes/:id/confirmar — a trava de admin da memória", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = admin();
    findUniqueMock.mockReset().mockResolvedValue({
      aiEnabledAt: new Date(),
      aiDailyLimit: null,
    });
    acaoFindFirstMock.mockReset().mockResolvedValue({ action: "memoria.criar" });
    confirmarMock.mockReset().mockResolvedValue({
      ok: true,
      status: "confirmada",
      resultId: "mem-1",
      jaEstava: false,
    });
    clearAiEntitlementCache();

    app = fastify();
    await app.register(aiRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("administrador confirma a memória normalmente", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/acoes/a1/confirmar",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("⭐⭐ colaborador NÃO confirma memória — mesmo com `canAction` liberado", async () => {
    // A permissão por ação nasce LIGADA para o colaborador (default da casa),
    // então `canAction("bitz.lembrar")` devolve true para ele. Sem a trava de
    // administrador, ele confirmaria a proposta e reescreveria a regra do dono.
    currentUser = colaborador();
    const res = await app.inject({
      method: "POST",
      url: "/acoes/a1/confirmar",
    });
    expect(res.statusCode).toBe(403);
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it("a trava é SÓ da memória: colaborador segue confirmando preço", async () => {
    // A prova de que a exigência de administrador não vazou para as demais
    // ações — regressão silenciosa que tiraria capacidade de quem já tinha.
    currentUser = colaborador();
    acaoFindFirstMock.mockResolvedValue({ action: "produto.preco" });
    const res = await app.inject({
      method: "POST",
      url: "/acoes/a1/confirmar",
    });
    expect(res.statusCode).toBe(200);
    expect(confirmarMock).toHaveBeenCalled();
  });
});

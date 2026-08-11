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
vi.mock("../app/lib/prisma", () => ({
  default: {
    user: { findUnique: (...a: any[]) => findUniqueMock(...a) },
    aiAction: { findFirst: (...a: any[]) => acaoFindFirstMock(...a) },
    systemLog: { create: async () => ({}) },
  },
}));

const confirmarMock = vi.fn();
const cancelarMock = vi.fn();
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    confirmarAcao: (...a: any[]) => confirmarMock(...a),
    cancelarAcao: (...a: any[]) => cancelarMock(...a),
  };
});

import { aiRoutes } from "../app/routes/ai.routes";
import { actionPermissionKey } from "../app/lib/action-access";
import { clearAiEntitlementCache } from "../app/ai/entitlement/ai-entitlement.service";

// ===========================================================================
// POST /ai/acoes/:id/confirmar — ⭐ O ÚNICO CAMINHO DE ESCRITA DO BITZ.
//
// O que este spec protege:
//   1. o gate de sempre (autenticado + plano);
//   2. ⭐⭐ A PERMISSÃO É CONFERIDA DE NOVO, AGORA. Entre propor e confirmar o
//      administrador pode ter tirado a chave do colaborador, e o que vale é o
//      estado atual — não o de quando a proposta nasceu;
//   3. id de outra pessoa devolve 404, nunca 403;
//   4. ⭐ NÃO HÁ CORPO. Nada do que o cliente mandar influencia o que executa.
// ===========================================================================

const admin = () => ({ id: "u1", dataOwnerId: "t1", role: "ADMIN" });

const colaborador = (perms: Record<string, boolean> | null) => ({
  id: "u9",
  dataOwnerId: "t1",
  parentUserId: "t1",
  role: "USER",
  pagePermissions: perms,
});

describe("POST /ai/acoes/:id/confirmar", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = admin();
    findUniqueMock.mockReset().mockResolvedValue({
      aiEnabledAt: new Date(),
      aiDailyLimit: null,
    });
    acaoFindFirstMock.mockReset().mockResolvedValue({ action: "produto.preco" });
    confirmarMock
      .mockReset()
      .mockResolvedValue({
        ok: true,
        status: "confirmada",
        resultId: "p1",
        jaEstava: false,
      });
    cancelarMock
      .mockReset()
      .mockResolvedValue({ ok: true, status: "cancelada", resultId: null });
    clearAiEntitlementCache();
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");

    app = fastify();
    await app.register(aiRoutes, { prefix: "/ai" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  const confirmar = (id = "a1", payload?: any) =>
    app.inject({
      method: "POST",
      url: `/ai/acoes/${id}/confirmar`,
      ...(payload ? { payload } : {}),
    });

  it("⭐ sem plano: 403, e nada é confirmado", async () => {
    findUniqueMock.mockResolvedValue({ aiEnabledAt: null, aiDailyLimit: null });
    clearAiEntitlementCache();

    const res = await confirmar();

    expect(res.statusCode).toBe(403);
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it("o caminho feliz executa e devolve o resultado", async () => {
    const res = await confirmar();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      status: "confirmada",
      resultId: "p1",
      jaEstava: false,
    });
    expect(confirmarMock).toHaveBeenCalledTimes(1);
  });

  it("⭐⭐ COLABORADOR SEM A CHAVE DA AÇÃO: 403, e nada executa", async () => {
    // A proposta pode ter nascido quando ele TINHA a permissão. O que vale é o
    // agora — senão bastaria propor antes de o admin cortar o acesso.
    currentUser = colaborador({
      [actionPermissionKey("bitz.atualizar-preco")]: false,
    });

    const res = await confirmar();

    expect(res.statusCode).toBe(403);
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it("⭐ a permissão conferida é a DA AÇÃO GRAVADA, não uma genérica", async () => {
    // A linha diz `cliente.criar`; a chave desligada é a de PREÇO. Se a rota
    // conferisse uma permissão fixa, este caso passaria errado.
    acaoFindFirstMock.mockResolvedValue({ action: "cliente.criar" });
    currentUser = colaborador({
      [actionPermissionKey("bitz.atualizar-preco")]: false,
    });

    const res = await confirmar();

    expect(res.statusCode).toBe(200);
    expect(confirmarMock).toHaveBeenCalledTimes(1);
  });

  it("REGRESSÃO: colaborador SEM chave nenhuma continua podendo (default liga)", async () => {
    // Semântica da casa, e decisão do dono: no dia do deploy ninguém perde
    // capacidade. O administrador desliga explicitamente para quem não deve.
    currentUser = colaborador(null);

    const res = await confirmar();

    expect(res.statusCode).toBe(200);
    expect(confirmarMock).toHaveBeenCalledTimes(1);
  });

  it("⭐ id que não é meu: 404, e NUNCA 403", async () => {
    // 403 confirmaria que aquele id existe em algum lugar.
    acaoFindFirstMock.mockResolvedValue(null);

    const res = await confirmar("de-outra-pessoa");

    expect(res.statusCode).toBe(404);
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it("⭐ a busca da proposta é ESCOPADA por tenant e ator", async () => {
    await confirmar("a1");

    const where = acaoFindFirstMock.mock.calls[0][0].where;
    expect(where).toEqual({
      id: "a1",
      dataOwnerId: "t1",
      actorUserId: "u1",
    });
  });

  it("⭐⭐ o CORPO da requisição não influencia nada", async () => {
    // Se o payload viajasse pelo cliente, esta rota seria uma escrita genérica
    // com nome de confirmação.
    await confirmar("a1", { produtoId: "OUTRO", preco: 1, status: "confirmada" });

    const entrada = confirmarMock.mock.calls[0][0];
    expect(Object.keys(entrada).sort()).toEqual(["id", "scope"]);
    expect(entrada.id).toBe("a1");
  });

  it("ação desconhecida por este deploy: 403, e não executa", async () => {
    // Rollback de versão pode deixar no banco uma `action` que este código não
    // conhece. Confirmar "no escuro" seria executar algo sem gate.
    acaoFindFirstMock.mockResolvedValue({ action: "produto.explodir" });

    const res = await confirmar();

    expect(res.statusCode).toBe(403);
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it("proposta vencida: 200 com ok:false e mensagem legível", async () => {
    confirmarMock.mockResolvedValue({
      ok: false,
      motivo: "expirada",
      mensagem: "Essa proposta passou da validade.",
    });

    const res = await confirmar();

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toMatch(/validade/i);
  });

  it("⭐ nenhuma resposta vaza provedor, chave ou detalhe interno", async () => {
    confirmarMock.mockResolvedValue({
      ok: false,
      motivo: "erro_execucao",
      mensagem: "Não consegui concluir a ação. Nada foi alterado.",
    });

    const res = await confirmar();
    expect(res.body).not.toMatch(/gemini|deepseek|prisma|sql|api[_-]?key/i);
  });
});

describe("POST /ai/acoes/:id/cancelar", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = colaborador({
      // Sem a chave da ação — e mesmo assim tem de conseguir desistir.
      [actionPermissionKey("bitz.atualizar-preco")]: false,
    });
    findUniqueMock.mockReset().mockResolvedValue({
      aiEnabledAt: new Date(),
      aiDailyLimit: null,
    });
    cancelarMock
      .mockReset()
      .mockResolvedValue({ ok: true, status: "cancelada", resultId: null });
    clearAiEntitlementCache();
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");

    app = fastify();
    await app.register(aiRoutes, { prefix: "/ai" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("⭐ desistir NÃO exige a permissão da ação", async () => {
    // Recusar um cancelamento por falta de permissão deixaria uma proposta
    // pendente que ninguém consegue fechar.
    const res = await app.inject({
      method: "POST",
      url: "/ai/acoes/a1/cancelar",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: "cancelada" });
  });

  it("mas continua atrás do gate do módulo", async () => {
    findUniqueMock.mockResolvedValue({ aiEnabledAt: null, aiDailyLimit: null });
    clearAiEntitlementCache();

    const res = await app.inject({
      method: "POST",
      url: "/ai/acoes/a1/cancelar",
    });

    expect(res.statusCode).toBe(403);
    expect(cancelarMock).not.toHaveBeenCalled();
  });
});

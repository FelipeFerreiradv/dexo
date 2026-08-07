import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

// authMiddleware mockado (identidade controlada pelo teste); TODO o resto do
// caminho — gate, quota, orquestrador, provedor — é o REAL. Mesmo padrão de
// tests/internal.routes.spec.ts:4-12.
let currentUser: { id: string; dataOwnerId: string } | null = null;
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = currentUser;
  },
}));

// Banco em memória: só o suficiente para o gate, a conversa e a quota.
const conversations: any[] = [];
const messages: any[] = [];
let aiEnabledAt: Date | null = new Date();
let quotaCount = 0;
let quotaCap = 1000;

vi.mock("../app/lib/prisma", () => {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({ aiEnabledAt })),
    },
    aiConversation: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `conv-${conversations.length + 1}`,
          summary: null,
          ...data,
        };
        conversations.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          conversations.find(
            (c) =>
              c.id === where.id &&
              c.actorUserId === where.actorUserId &&
              c.dataOwnerId === where.dataOwnerId,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        conversations.filter(
          (c) =>
            c.actorUserId === where.actorUserId &&
            c.dataOwnerId === where.dataOwnerId,
        ),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = conversations.length;
        for (let i = conversations.length - 1; i >= 0; i--) {
          const c = conversations[i];
          if (
            c.id === where.id &&
            c.actorUserId === where.actorUserId &&
            c.dataOwnerId === where.dataOwnerId
          ) {
            conversations.splice(i, 1);
          }
        }
        return { count: before - conversations.length };
      }),
    },
    aiMessage: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `msg-${messages.length + 1}`,
          createdAt: new Date(Date.now() + messages.length),
          ...data,
        };
        messages.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        const rows = messages.filter(
          (m) => m.conversationId === where.conversationId,
        );
        return orderBy?.createdAt === "desc" ? [...rows].reverse() : rows;
      }),
    },
    // Quota: teto simples em memória, com a mesma semântica do increment
    // condicional (só atualiza quando count < max).
    providerDailyUsage: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (data.count?.decrement) {
          quotaCount = Math.max(0, quotaCount - 1);
          return { count: 1 };
        }
        if (quotaCount < (where.count?.lt ?? quotaCap)) {
          quotaCount += 1;
          return { count: 1 };
        }
        return { count: 0 };
      }),
      create: vi.fn(async () => {
        quotaCount += 1;
        return {};
      }),
    },
  };
  return { default: db };
});

// SystemLog é fire-and-forget e não deve influenciar o resultado do turno.
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn(async () => undefined),
    logWarning: vi.fn(async () => undefined),
    logError: vi.fn(async () => undefined),
  },
}));

import { aiRoutes } from "../app/routes/ai.routes";
import { clearAiEntitlementCache } from "../app/ai/entitlement/ai-entitlement.service";
import {
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";

const post = (app: FastifyInstance, payload: any) =>
  app.inject({ method: "POST", url: "/ai/chat", payload });

describe("POST /ai/chat — turno ponta a ponta (MockAiProvider, zero rede)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    conversations.length = 0;
    messages.length = 0;
    aiEnabledAt = new Date();
    quotaCount = 0;
    quotaCap = 1000;
    currentUser = { id: "u1", dataOwnerId: "t1" };
    clearAiEntitlementCache();
    __resetMockProvider();

    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.stubEnv("AI_PROVIDER", "mock");

    app = fastify();
    await app.register(aiRoutes, { prefix: "/ai" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("turno simples: responde, cria conversa e persiste as DUAS mensagens", async () => {
    __pushMockCompletion({ content: "Em julho você faturou R$ 84.320,00." });

    const res = await post(app, { message: "quanto vendi em julho?" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message.content).toBe("Em julho você faturou R$ 84.320,00.");
    expect(body.degraded).toBe(false);
    expect(body.conversationId).toBeTruthy();

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].content).toBe("quanto vendi em julho?");
  });

  it("grava tokens, provedor, modelo e latência (é como se mede custo por cliente)", async () => {
    __pushMockCompletion({
      content: "ok",
      usage: { inputTokens: 1234, outputTokens: 56 },
    });

    await post(app, { message: "oi" });

    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant.inputTokens).toBe(1234);
    expect(assistant.outputTokens).toBe(56);
    expect(assistant.provider).toBe("mock");
    expect(assistant.model).toBe("mock-1");
    expect(assistant.latencyMs).toBeTypeOf("number");
  });

  it("segundo turno reaproveita a conversa em vez de criar outra", async () => {
    __pushMockCompletion({ content: "primeira" });
    const a = await post(app, { message: "oi" });
    const id = a.json().conversationId;

    __pushMockCompletion({ content: "segunda" });
    const b = await post(app, { message: "e depois?", conversationId: id });

    expect(b.json().conversationId).toBe(id);
    expect(conversations).toHaveLength(1);
    expect(messages).toHaveLength(4);
  });

  it("conversationId de OUTRO usuário não é reaproveitado — abre conversa nova", async () => {
    __pushMockCompletion({ content: "do outro" });
    await post(app, { message: "oi" });
    const alheia = conversations[0].id;

    currentUser = { id: "u2", dataOwnerId: "t2" };
    __pushMockCompletion({ content: "minha" });
    const res = await post(app, { message: "oi", conversationId: alheia });

    expect(res.json().conversationId).not.toBe(alheia);
    expect(conversations).toHaveLength(2);
  });

  it("provedor fora do ar: 200 degradado, NUNCA 5xx", async () => {
    __pushMockCompletion({ ok: false, reason: "timeout" });

    const res = await post(app, { message: "oi" });

    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(true);
    expect(res.json().message.content).toMatch(/demorei|tenta/i);
  });

  it("falha do provedor DEVOLVE a cota (o turno não virou chamada útil)", async () => {
    __pushMockCompletion({ ok: false, reason: "erro_provedor" });

    await post(app, { message: "oi" });

    expect(quotaCount).toBe(0);
  });

  it("a pergunta é persistida MESMO quando o provedor falha", async () => {
    __pushMockCompletion({ ok: false, reason: "timeout" });

    await post(app, { message: "não quero perder isto" });

    expect(messages[0]).toMatchObject({
      role: "user",
      content: "não quero perder isto",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      errorCode: "timeout",
    });
  });

  it("teto diário batido: 200 com aviso, nada quebra", async () => {
    quotaCap = 0;
    quotaCount = 0;
    // Faz o increment condicional falhar e o create também.
    const prisma = (await import("../app/lib/prisma")).default as any;
    prisma.providerDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    prisma.providerDailyUsage.create.mockRejectedValue(new Error("unique"));

    const res = await post(app, { message: "oi" });

    expect(res.statusCode).toBe(200);
    expect(res.json().degraded).toBe(true);
    expect(res.json().message.content).toMatch(/limite|demanda/i);
  });

  it("sem o gate Premium: 403 AI_DISABLED", async () => {
    aiEnabledAt = null;
    clearAiEntitlementCache();

    const res = await post(app, { message: "oi" });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("AI_DISABLED");
  });

  it("flag global desligada: 403 mesmo com o plano ativo", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "");
    clearAiEntitlementCache();

    const res = await post(app, { message: "oi" });

    expect(res.statusCode).toBe(403);
  });

  it("mensagem vazia: 400", async () => {
    const res = await post(app, { message: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("mensagem gigante: 400 (teto antes de gastar token)", async () => {
    const res = await post(app, { message: "x".repeat(5000) });
    expect(res.statusCode).toBe(400);
  });
});

describe("histórico de conversas", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    conversations.length = 0;
    messages.length = 0;
    aiEnabledAt = new Date();
    quotaCount = 0;
    currentUser = { id: "u1", dataOwnerId: "t1" };
    clearAiEntitlementCache();
    __resetMockProvider();
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.stubEnv("AI_PROVIDER", "mock");

    const prisma = (await import("../app/lib/prisma")).default as any;
    prisma.providerDailyUsage.updateMany.mockImplementation(async () => ({
      count: 1,
    }));

    app = fastify();
    await app.register(aiRoutes, { prefix: "/ai" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("lista só as conversas do ATOR", async () => {
    __pushMockCompletion({ content: "a" });
    await post(app, { message: "minha" });

    currentUser = { id: "u2", dataOwnerId: "t1" }; // mesmo tenant, outro ator
    __pushMockCompletion({ content: "b" });
    await post(app, { message: "do colega" });

    const res = await app.inject({ method: "GET", url: "/ai/conversations" });

    expect(res.json().conversations).toHaveLength(1);
  });

  it("DELETE de conversa alheia: 404, e a conversa continua lá", async () => {
    __pushMockCompletion({ content: "a" });
    await post(app, { message: "minha" });
    const id = conversations[0].id;

    currentUser = { id: "u2", dataOwnerId: "t1" };
    const res = await app.inject({
      method: "DELETE",
      url: `/ai/conversations/${id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(conversations).toHaveLength(1);
  });

  it("DELETE da própria conversa: 204", async () => {
    __pushMockCompletion({ content: "a" });
    await post(app, { message: "minha" });
    const id = conversations[0].id;

    const res = await app.inject({
      method: "DELETE",
      url: `/ai/conversations/${id}`,
    });

    expect(res.statusCode).toBe(204);
    expect(conversations).toHaveLength(0);
  });
});

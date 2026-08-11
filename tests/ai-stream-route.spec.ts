import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

// Mesmo molde de tests/ai-chat-route.spec.ts: authMiddleware dublado, TODO o
// resto do caminho real — gate, quota, orquestrador, provedor, rota.
let currentUser: { id: string; dataOwnerId: string } | null = null;
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = currentUser;
  },
}));

const conversations: any[] = [];
const messages: any[] = [];
let aiEnabledAt: Date | null = new Date();

vi.mock("../app/lib/prisma", () => {
  const db = {
    user: { findUnique: vi.fn(async () => ({ aiEnabledAt })) },
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
          conversations.find((c) => c.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
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
    providerDailyUsage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({})),
    },
  };
  return { default: db };
});

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
import { NDJSON_CONTENT_TYPE } from "../app/ai/stream/ndjson";

// ===========================================================================
// POST /ai/chat em NDJSON — a rota, ponta a ponta.
//
// Streaming é negociado por `Accept`, e não por rota separada. Duas rotas
// dariam dois baldes de rate limit (o @fastify/rate-limit cria um store por
// rota) e o teto por minuto viraria o dobro para quem alternasse. Os testes
// abaixo cobrem os dois lados dessa decisão: o caminho novo funciona, e o
// caminho JSON continua exatamente como estava.
//
// ⭐ O TESTE QUE MAIS IMPORTA AQUI é o dos cabeçalhos preservados. A resposta
// é escrita à mão em `reply.raw`, e o CORS do Fastify vive em cabeçalhos que só
// chegam ao socket quando `reply.send()` roda. Um `writeHead` que os ignorasse
// mandaria a resposta sem `access-control-allow-origin` — e o chat quebraria só
// no navegador do cliente, num erro que nenhum teste de rota costuma ver.
// ===========================================================================

/** As linhas de um corpo NDJSON, já parseadas. */
const quadros = (payload: string): any[] =>
  payload
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const stream = (app: FastifyInstance, payload: any) =>
  app.inject({
    method: "POST",
    url: "/ai/chat",
    payload,
    headers: { accept: NDJSON_CONTENT_TYPE },
  });

const json = (app: FastifyInstance, payload: any) =>
  app.inject({ method: "POST", url: "/ai/chat", payload });

describe("POST /ai/chat com Accept: application/x-ndjson", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    conversations.length = 0;
    messages.length = 0;
    aiEnabledAt = new Date();
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

  it("responde em NDJSON, começando por `inicio` e terminando em `fim`", async () => {
    __pushMockCompletion({ content: "Em julho você faturou R$ 84.320,00." });

    const res = await stream(app, { message: "quanto vendi em julho?" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(NDJSON_CONTENT_TYPE);

    const linhas = quadros(res.payload);
    expect(linhas[0]).toEqual({ type: "inicio" });
    expect(linhas[linhas.length - 1].type).toBe("fim");
  });

  it("⭐ o quadro `fim` carrega EXATAMENTE a carga do caminho JSON", async () => {
    __pushMockCompletion({ content: "Você tem 3 faróis." });
    const emStream = quadros(
      (await stream(app, { message: "tem farol?" })).payload,
    );
    const fim = emStream[emStream.length - 1];

    __resetMockProvider();
    conversations.length = 0;
    messages.length = 0;
    __pushMockCompletion({ content: "Você tem 3 faróis." });
    const emJson = (await json(app, { message: "tem farol?" })).json();

    // Os dois formatos não podem divergir: mesmo conteúdo, mesmas fontes,
    // mesmo `degraded`, mesmo `usage`.
    expect(fim.message).toEqual(emJson.message);
    expect(fim.degraded).toEqual(emJson.degraded);
    expect(fim.usage).toEqual(emJson.usage);
  });

  it("transmite o texto em pedaços antes do `fim`", async () => {
    __pushMockCompletion({ content: "Você tem 3 faróis de Palio." });

    const linhas = quadros(
      (await stream(app, { message: "tem farol?" })).payload,
    );
    const deltas = linhas.filter((q) => q.type === "texto");

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.delta).join("")).toBe(
      "Você tem 3 faróis de Palio.",
    );
  });

  it("o id da conversa vem num quadro próprio, antes do texto", async () => {
    __pushMockCompletion({ content: "oi" });

    const linhas = quadros((await stream(app, { message: "bom dia" })).payload);
    const iConversa = linhas.findIndex((q) => q.type === "conversa");
    const iTexto = linhas.findIndex((q) => q.type === "texto");

    expect(iConversa).toBeGreaterThan(-1);
    expect(linhas[iConversa].conversationId).toBeTruthy();
    expect(iConversa).toBeLessThan(iTexto);
  });

  it("provedor fora do ar vira `fim` degradado — nunca 5xx", async () => {
    __pushMockCompletion({ ok: false, reason: "erro_provedor" });

    const res = await stream(app, { message: "tem farol?" });
    const linhas = quadros(res.payload);
    const fim = linhas[linhas.length - 1];

    expect(res.statusCode).toBe(200);
    expect(fim.type).toBe("fim");
    expect(fim.degraded).toBe(true);
    expect(fim.message.content).toBeTruthy();
  });

  it("⭐ cabeçalhos já montados pelo Fastify (CORS!) sobrevivem ao writeHead", async () => {
    const comCors = fastify();
    // Imita o que o @fastify/cors faz: põe o cabeçalho no reply num hook, muito
    // antes de a resposta ser escrita.
    comCors.addHook("onRequest", async (_req, reply) => {
      reply.header("access-control-allow-origin", "https://app.exemplo.com");
      reply.header("access-control-allow-credentials", "true");
    });
    await comCors.register(aiRoutes, { prefix: "/ai" });

    try {
      __pushMockCompletion({ content: "ok" });
      const res = await stream(comCors, { message: "tem farol?" });

      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://app.exemplo.com",
      );
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
      // E o nosso content-type venceu o que estivesse lá.
      expect(res.headers["content-type"]).toContain(NDJSON_CONTENT_TYPE);
    } finally {
      await comCors.close();
    }
  });

  it("manda os cabeçalhos que impedem proxy de bufferizar", async () => {
    __pushMockCompletion({ content: "ok" });
    const res = await stream(app, { message: "tem farol?" });

    expect(String(res.headers["cache-control"])).toContain("no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    // `content-length` num corpo transmitido mataria o stream na primeira linha.
    expect(res.headers["content-length"]).toBeUndefined();
  });

  it("⭐ o Accept NÃO fura o gate: sem entitlement continua 403", async () => {
    aiEnabledAt = null;
    clearAiEntitlementCache();

    const res = await stream(app, { message: "tem farol?" });

    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("o Accept não pula a validação de entrada", async () => {
    const vazio = await stream(app, { message: "   " });
    expect(vazio.statusCode).toBe(400);

    const gigante = await stream(app, { message: "x".repeat(5000) });
    expect(gigante.statusCode).toBe(400);
  });

  it("grava a conversa igual ao caminho JSON", async () => {
    __pushMockCompletion({ content: "Você tem 3 faróis." });
    await stream(app, { message: "tem farol?" });

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe("Você tem 3 faróis.");
  });
});

describe("sem o Accept, nada muda", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    conversations.length = 0;
    messages.length = 0;
    aiEnabledAt = new Date();
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

  it("responde JSON, com o mesmo shape de sempre", async () => {
    __pushMockCompletion({ content: "resposta" });
    const res = await json(app, { message: "tem farol?" });

    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({
      conversationId: expect.any(String),
      message: { content: "resposta", sources: [] },
      degraded: false,
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
    });
  });

  it("Accept de outro tipo cai no JSON", async () => {
    __pushMockCompletion({ content: "resposta" });
    const res = await app.inject({
      method: "POST",
      url: "/ai/chat",
      payload: { message: "tem farol?" },
      headers: { accept: "application/json" },
    });
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

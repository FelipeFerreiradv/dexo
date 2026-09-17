import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";

/**
 * POST /marketplace/ml/callback com o rate limit global da API.
 *
 * Produção (set/2026): o limite global de 300/min por IP recusava as rajadas
 * de notificação do ML (346.361 respostas 429 no mês). Aqui o limite global
 * vai para 3/min para reproduzir o mesmo efeito com poucas requisições:
 *  - flag desligada → 429 como hoje (controle);
 *  - ML_WEBHOOK_QUEUE_ENABLED=1 → a rota tem limite próprio e processa em fila;
 *  - fila cheia → 503 (o ML reenvia), nunca 200 com descarte.
 */

vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));

import { WebhookUseCase } from "../app/marketplaces/usecases/webhook.usercase";
import {
  marketplaceRoutes,
  __mlWebhookQueueTesting,
} from "../app/routes/marketplace.routes";

const ENV = [
  "ML_WEBHOOK_QUEUE_ENABLED",
  "ML_WEBHOOK_QUEUE_CONCURRENCY",
  "ML_WEBHOOK_QUEUE_MAX",
  "ML_WEBHOOK_RATE_LIMIT_PER_MINUTE",
];

function item(n: number) {
  return { resource: `/items/MLB${1000 + n}`, topic: "items", user_id: 42, application_id: 1, sent: `t${n}`, received: `t${n}`, attempts: 1 };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = fastify();
  await app.register(fastifyRateLimit, { max: 3, timeWindow: "1 minute" });
  await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  await app.ready();
  return app;
}

const tick = () => new Promise((r) => setImmediate(r));

describe("POST /marketplace/ml/callback — rate limit e fila", () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    __mlWebhookQueueTesting.reset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of ENV) delete process.env[k];
    __mlWebhookQueueTesting.reset();
    await app?.close();
    app = null;
  });

  it("controle (flag desligada): a partir da 4ª notificação no minuto, 429 — o defeito de produção", async () => {
    const processItem = vi.spyOn(WebhookUseCase, "processItemWebhook").mockResolvedValue({ success: true, action: "x" } as any);
    app = await buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: item(i) })).statusCode);
    }
    await tick();
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(processItem).toHaveBeenCalledTimes(3);
    expect(__mlWebhookQueueTesting.get()).toBeNull();
  });

  it("flag ligada: a rota tem limite próprio e todas as notificações são processadas", async () => {
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "1";
    const processItem = vi.spyOn(WebhookUseCase, "processItemWebhook").mockResolvedValue({ success: true, action: "x" } as any);
    app = await buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push((await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: item(i) })).statusCode);
    }
    for (let i = 0; i < 5; i++) await tick();
    expect(codes.every((c) => c === 200)).toBe(true);
    expect(processItem).toHaveBeenCalledTimes(8);
    expect(__mlWebhookQueueTesting.get()!.stats()).toMatchObject({ processed: 8, queued: 0, running: 0 });
  });

  it("flag ligada: o limite global continua valendo para as OUTRAS rotas", async () => {
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "1";
    app = await buildApp();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await app.inject({ method: "GET", url: "/marketplace/ml/categories/%20/attributes" })).statusCode);
    }
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it("fila cheia responde 503 (o ML reenvia) e não processa a recusada", async () => {
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "1";
    process.env.ML_WEBHOOK_QUEUE_CONCURRENCY = "1";
    process.env.ML_WEBHOOK_QUEUE_MAX = "1";
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    const vistos: string[] = [];
    vi.spyOn(WebhookUseCase, "processItemWebhook").mockImplementation(async (b: any) => {
      vistos.push(b.resource);
      await segura;
      return { success: true, action: "x" } as any;
    });
    app = await buildApp();
    const r1 = await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: item(1) });
    await tick();
    const r2 = await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: item(2) });
    const r3 = await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: item(3) });
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 503]);
    liberar();
    for (let i = 0; i < 5; i++) await tick();
    expect(vistos).toEqual(["/items/MLB1001", "/items/MLB1002"]);
  });

  it("notificação repetida ainda na fila é processada uma vez só (coalescência)", async () => {
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "1";
    process.env.ML_WEBHOOK_QUEUE_CONCURRENCY = "1";
    let liberar!: () => void;
    const segura = new Promise<void>((r) => (liberar = r));
    const vistos: string[] = [];
    vi.spyOn(WebhookUseCase, "processItemWebhook").mockImplementation(async (b: any) => {
      vistos.push(`${b.resource}#${b.attempts}`);
      if (b.resource === "/items/MLB1000") await segura;
      return { success: true, action: "x" } as any;
    });
    app = await buildApp();
    await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: item(0) });
    await tick();
    await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: { ...item(5), attempts: 1 } });
    await app.inject({ method: "POST", url: "/marketplace/ml/callback", payload: { ...item(5), attempts: 2 } });
    liberar();
    for (let i = 0; i < 5; i++) await tick();
    expect(vistos).toEqual(["/items/MLB1000#1", "/items/MLB1005#2"]);
    expect(__mlWebhookQueueTesting.get()!.stats().coalesced).toBe(1);
  });

  it("tópico sem processador (items_prices) responde 200 sem entrar na fila", async () => {
    process.env.ML_WEBHOOK_QUEUE_ENABLED = "1";
    const processItem = vi.spyOn(WebhookUseCase, "processItemWebhook");
    const processOrder = vi.spyOn(WebhookUseCase, "processOrderWebhook");
    app = await buildApp();
    const r = await app.inject({
      method: "POST",
      url: "/marketplace/ml/callback",
      payload: { resource: "/items/MLB1/prices", topic: "items_prices", user_id: 42, application_id: 1, sent: "x", attempts: 1 },
    });
    await tick();
    expect(r.statusCode).toBe(200);
    expect(processItem).not.toHaveBeenCalled();
    expect(processOrder).not.toHaveBeenCalled();
    expect(__mlWebhookQueueTesting.get()).toBeNull();
  });
});

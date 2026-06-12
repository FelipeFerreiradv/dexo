import { describe, it, expect } from "vitest";
import fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

/**
 * PR-A4 — valida que os plugins de segurança do Fastify funcionam com as
 * versões instaladas (helmet 13 / rate-limit 10, compatíveis com Fastify 5),
 * com a MESMA configuração usada em app/api/api.ts.
 */

describe("PR-A4: helmet security headers", () => {
  it("define X-Content-Type-Options e X-Frame-Options; permite CORP cross-origin", async () => {
    const app = fastify();
    await app.register(helmet, {
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginEmbedderPolicy: false,
    });
    app.get("/x", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    await app.close();
  });
});

describe("PR-A4: rate limit", () => {
  it("retorna 429 ao exceder o max e isenta /health", async () => {
    const app = fastify();
    await app.register(rateLimit, {
      max: 2,
      timeWindow: "1 minute",
      allowList: (req) => req.url === "/health",
    });
    app.get("/x", async () => ({ ok: true }));
    app.get("/health", async () => ({ status: "ok" }));

    expect((await app.inject({ url: "/x" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/x" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/x" })).statusCode).toBe(429);

    // /health isento: várias chamadas seguem 200.
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    }
    await app.close();
  });
});

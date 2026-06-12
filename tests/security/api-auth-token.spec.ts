import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

/**
 * PR-A2 — auth por token verificado (dual-mode).
 * Verifica sign/verify do token e o comportamento legacy/strict do middleware.
 */

const userA = {
  id: "user-a",
  email: "a@test.com",
  password: "x",
  role: "ADMIN",
  parentUserId: null as string | null,
  name: "A",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
};

vi.mock("@/app/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(({ where }: { where: any }) =>
        Promise.resolve(
          where.id === userA.id || where.email === userA.email ? userA : null,
        ),
      ),
    },
  },
}));

import { signApiToken, verifyApiToken } from "../../app/lib/api-token";
import { authMiddleware } from "../../app/middlewares/auth.middleware";

const SECRET = "test-secret-com-mais-de-16-chars";

async function makeApp() {
  const app = fastify();
  app.get("/protected", { preHandler: [authMiddleware] }, async (req) => ({
    id: (req as any).user?.id,
    dataOwnerId: (req as any).user?.dataOwnerId,
  }));
  await app.ready();
  return app;
}

describe("PR-A2: api-token sign/verify", () => {
  beforeEach(() => {
    process.env.API_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.API_JWT_SECRET;
  });

  it("roundtrip sign→verify devolve o payload", () => {
    const tok = signApiToken({ sub: "user-a", email: "a@test.com" });
    expect(tok).toBeTruthy();
    const payload = verifyApiToken(tok!);
    expect(payload?.sub).toBe("user-a");
    expect(payload?.email).toBe("a@test.com");
  });

  it("token assinado com OUTRO segredo é rejeitado", () => {
    process.env.API_JWT_SECRET = "outro-segredo-com-16-chars-aqui";
    const tok = signApiToken({ sub: "user-a" });
    process.env.API_JWT_SECRET = SECRET;
    expect(verifyApiToken(tok!)).toBeNull();
  });
});

describe("PR-A2: authMiddleware legacy (default)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.API_JWT_SECRET = SECRET;
    delete process.env.API_AUTH_MODE; // legacy
    app = await makeApp();
  });
  afterEach(async () => {
    delete process.env.API_JWT_SECRET;
    await app.close();
  });

  it("aceita header email (comportamento legado)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { email: "a@test.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).id).toBe("user-a");
  });

  it("aceita Bearer token válido (resolve por id)", async () => {
    const tok = signApiToken({ sub: "user-a", email: "a@test.com" });
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).id).toBe("user-a");
  });

  it("Bearer inválido → 401 (não cai pro email)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: "Bearer token.invalido.xxx",
        email: "a@test.com",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("sem token e sem email → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PR-A2: authMiddleware strict", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.API_JWT_SECRET = SECRET;
    process.env.API_AUTH_MODE = "strict";
    app = await makeApp();
  });
  afterEach(async () => {
    delete process.env.API_JWT_SECRET;
    delete process.env.API_AUTH_MODE;
    await app.close();
  });

  it("email-only → 401 (bypass fechado)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { email: "a@test.com" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("token válido → 200", async () => {
    const tok = signApiToken({ sub: "user-a", email: "a@test.com" });
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

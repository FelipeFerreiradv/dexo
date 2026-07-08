import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

/**
 * Prova que POST /v1/images/process está protegido pelo authMiddleware REAL
 * (não mockado), tanto no modo legacy quanto strict. Espelha
 * tests/security/api-auth-token.spec.ts.
 */

const userA = {
  id: "user-a",
  email: "a@test.com",
  password: "x",
  role: "ADMIN",
  parentUserId: null as string | null,
  effectiveActive: true,
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

import { signApiToken } from "../app/lib/api-token";
import { imageRoutes } from "../app/routes/image.routes";

const SECRET = "test-secret-com-mais-de-16-chars";

async function makeApp() {
  const app = fastify();
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  // imageRoutes já registra o authMiddleware real no preHandler.
  await app.register(imageRoutes, { prefix: "/v1/images" });
  await app.ready();
  return app;
}

describe("POST /v1/images/process — auth (strict)", () => {
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

  it("sem credencial → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
    });
    expect(res.statusCode).toBe(401);
  });

  it("email-only → 401 (bypass fechado no strict)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers: { email: "a@test.com" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/images/process — auth (legacy default)", () => {
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

  it("sem credencial → 401 (rota exige auth mesmo no legacy)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
    });
    expect(res.statusCode).toBe(401);
  });

  it("Bearer válido passa a auth (guard de multipart responde 400, não 401)", async () => {
    const tok = signApiToken({ sub: "user-a", email: "a@test.com" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers: {
        authorization: `Bearer ${tok}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ foo: "bar" }),
    });
    // Auth OK → chega no guard de multipart (não-multipart) → 400.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toMatch(/multipart/i);
  });
});

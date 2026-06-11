import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";

/**
 * PR-A0 — Fecha disclosure de senha e rotas sem auth.
 *
 * Cobre:
 *  - toPublicUser nunca devolve `password`.
 *  - GET /users/:id exige auth (401 sem identidade) e não vaza `password`.
 *  - GET /users/:id é escopado: usuário A não acessa usuário B (403).
 *  - POST /users é admin-only (colaborador → 403).
 *  - GET /system-logs exige auth (401 sem identidade).
 */

// Usuários de teste resolvidos pelo prisma mockado.
const userA = {
  id: "user-a",
  email: "a@test.com",
  password: "plaintextA",
  role: "ADMIN",
  parentUserId: null as string | null,
  name: "Admin A",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
};
const userB = {
  id: "user-b",
  email: "b@test.com",
  password: "plaintextB",
  role: "ADMIN",
  parentUserId: null as string | null,
  name: "Admin B",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
};
const childOfA = {
  id: "child-a",
  email: "child@test.com",
  password: "plaintextC",
  role: "USER",
  parentUserId: "user-a",
  name: "Collab",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
};
const ALL = [userA, userB, childOfA];

vi.mock("@/app/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(({ where }: { where: any }) => {
        if (where.email)
          return Promise.resolve(
            ALL.find((u) => u.email === where.email) ?? null,
          );
        if (where.id)
          return Promise.resolve(ALL.find((u) => u.id === where.id) ?? null);
        return Promise.resolve(null);
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      create: vi.fn(),
    },
    systemLog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

import { toPublicUser } from "../../app/lib/user-serializer";
import { userRoutes } from "../../app/routes/user.routes";
import { systemLogRoutes } from "../../app/routes/system-log.routes";

describe("PR-A0: toPublicUser", () => {
  it("remove o campo password e mantém os demais", () => {
    const safe = toPublicUser({
      id: "1",
      email: "x@y.z",
      password: "secret",
      name: "N",
    });
    expect((safe as any).password).toBeUndefined();
    expect(safe.id).toBe("1");
    expect(safe.name).toBe("N");
  });
});

describe("PR-A0: user.routes auth + escopo", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    await app.register(userRoutes, { prefix: "/users" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /users/:id sem identidade → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/users/user-a" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /users/:id do próprio usuário → 200 e SEM password", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/user-a",
      headers: { email: "a@test.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe("user-a");
    expect(body.password).toBeUndefined();
  });

  it("GET /users/:id de outro tenant → 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/user-b",
      headers: { email: "a@test.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin acessa o próprio colaborador → 200 e SEM password", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/child-a",
      headers: { email: "a@test.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).password).toBeUndefined();
  });

  it("POST /users como colaborador → 403 (admin-only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/users",
      headers: { email: "child@test.com", "content-type": "application/json" },
      payload: JSON.stringify({
        email: "new@test.com",
        password: "x",
        name: "New",
      }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PR-A0: system-log.routes exige auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    await app.register(systemLogRoutes, { prefix: "/system-logs" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /system-logs sem identidade → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/system-logs" });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /system-logs/cleanup sem identidade → 401", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/system-logs/cleanup",
    });
    expect(res.statusCode).toBe(401);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Mocks que precisam preceder o import das rotas
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  const prisma = {
    unidade: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return { default: prisma };
});

vi.mock("@/app/lib/prisma", () => {
  const prisma = {
    unidade: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return { default: prisma };
});

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    const userId = email === "owner@test.com" ? "user-owner" : "user-other";
    request.user = { id: userId, dataOwnerId: userId };
  },
}));

import prisma from "../app/lib/prisma";
import { unidadeRoutes } from "../app/routes/unidade.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(unidadeRoutes, { prefix: "/unidades" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("unidade.routes", () => {
  it("POST / cria unidade (201) escopada no dataOwner", async () => {
    (prisma as any).unidade.findFirst.mockResolvedValue(null); // code livre
    (prisma as any).unidade.create.mockResolvedValue({
      id: "u1",
      userId: "user-owner",
      name: "Loja Centro",
      code: "CENTRO",
      notes: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/unidades",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { name: "Loja Centro", code: "CENTRO" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().unidade).toMatchObject({ id: "u1", name: "Loja Centro" });
    expect((prisma as any).unidade.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-owner",
          name: "Loja Centro",
          code: "CENTRO",
          active: true,
        }),
      }),
    );
  });

  it("POST / sem code não consulta duplicidade e cria", async () => {
    (prisma as any).unidade.create.mockResolvedValue({
      id: "u2",
      userId: "user-owner",
      name: "Filial A",
      code: null,
      notes: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/unidades",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { name: "Filial A" },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).unidade.findFirst).not.toHaveBeenCalled();
  });

  it("POST / 409 quando identificador (code) já existe", async () => {
    (prisma as any).unidade.findFirst.mockResolvedValue({
      id: "u9",
      userId: "user-owner",
      name: "Existente",
      code: "CENTRO",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/unidades",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { name: "Outra", code: "CENTRO" },
    });

    expect(res.statusCode).toBe(409);
    expect((prisma as any).unidade.create).not.toHaveBeenCalled();
  });

  it("POST / 400 quando nome ausente/curto", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/unidades",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { name: "A" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET / lista apenas ativas por padrão", async () => {
    (prisma as any).unidade.findMany.mockResolvedValue([]);
    (prisma as any).unidade.count.mockResolvedValue(0);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/unidades",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).unidade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", active: true },
        orderBy: { name: "asc" },
      }),
    );
  });

  it("GET /?all=1 inclui inativas (sem filtro active)", async () => {
    (prisma as any).unidade.findMany.mockResolvedValue([]);
    (prisma as any).unidade.count.mockResolvedValue(0);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/unidades?all=1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).unidade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("PATCH /:id inativa a unidade (active:false)", async () => {
    (prisma as any).unidade.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).unidade.findUnique.mockResolvedValue({
      id: "u1",
      userId: "user-owner",
      name: "Loja Centro",
      code: "CENTRO",
      notes: null,
      active: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/unidades/u1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { active: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().unidade.active).toBe(false);
    expect((prisma as any).unidade.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", userId: "user-owner" },
      data: { active: false },
    });
  });

  it("PUT /:id 404 quando não pertence ao user", async () => {
    (prisma as any).unidade.updateMany.mockResolvedValue({ count: 0 });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/unidades/u-alheia",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { name: "Hack" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("401 quando email ausente", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/unidades" });
    expect(res.statusCode).toBe(401);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

const mockPrisma = vi.hoisted(() => ({
  systemLog: {
    groupBy: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock("../app/lib/prisma", () => ({ default: mockPrisma }));
vi.mock("@/app/lib/prisma", () => ({ default: mockPrisma }));

const findChildrenMock = vi.hoisted(() => vi.fn());
const findByIdMock = vi.hoisted(() => vi.fn());
vi.mock("../app/repositories/user.repository", () => ({
  UserRepositoryPrisma: vi.fn().mockImplementation(() => ({
    findChildren: findChildrenMock,
    findById: findByIdMock,
    findByEmail: vi.fn(),
  })),
}));

// authMiddleware permissivo: anexa request.user a partir do header `x-test-user`.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (req: any) => {
    const raw = req.headers["x-test-user"];
    if (raw) req.user = JSON.parse(raw);
  },
}));

import { teamRoutes } from "../app/routes/team.routes";

function buildApp() {
  const app = fastify();
  app.register(teamRoutes, { prefix: "/me/team" });
  return app;
}

function asUser(user: any) {
  return { "x-test-user": JSON.stringify(user) };
}

describe("team routes", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
    findChildrenMock.mockReset();
    findByIdMock.mockReset();
    mockPrisma.systemLog.groupBy.mockReset();
    mockPrisma.systemLog.findMany.mockReset();
    mockPrisma.systemLog.count.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("GET /me/team", () => {
    it("admin recebe lista de filhos e parent=null", async () => {
      findChildrenMock.mockResolvedValue([
        { id: "c1", email: "c1@x.com", name: "C1", avatarUrl: null },
        { id: "c2", email: "c2@x.com", name: "C2", avatarUrl: null },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/me/team",
        headers: asUser({ id: "admin-1", parentUserId: null }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.parent).toBeNull();
      expect(body.children).toHaveLength(2);
      expect(body.children[0]).toMatchObject({ id: "c1", email: "c1@x.com" });
    });

    it("colaborador recebe parent populado e children vazio", async () => {
      findByIdMock.mockResolvedValue({
        id: "admin-1",
        email: "admin@x.com",
        name: "Admin",
        avatarUrl: null,
      });

      const res = await app.inject({
        method: "GET",
        url: "/me/team",
        headers: asUser({ id: "c1", parentUserId: "admin-1" }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.parent).toMatchObject({ id: "admin-1", email: "admin@x.com" });
      expect(body.children).toEqual([]);
      expect(findChildrenMock).not.toHaveBeenCalled();
    });
  });

  describe("GET /me/team/activity", () => {
    it("colaborador recebe 403 (admin-only)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/me/team/activity",
        headers: asUser({ id: "c1", parentUserId: "admin-1" }),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).code).toBe("ADMIN_ONLY");
    });

    it("admin sem colaboradores recebe lista vazia sem consultar SystemLog", async () => {
      findChildrenMock.mockResolvedValue([]);

      const res = await app.inject({
        method: "GET",
        url: "/me/team/activity",
        headers: asUser({ id: "admin-1", parentUserId: null }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.logs).toEqual([]);
      expect(body.total).toBe(0);
      expect(mockPrisma.systemLog.findMany).not.toHaveBeenCalled();
    });

    it("admin com colaboradores filtra por userId IN [...children.id] (escopo correto)", async () => {
      findChildrenMock.mockResolvedValue([
        { id: "c1", email: "c1@x.com", name: "C1", avatarUrl: null },
        { id: "c2", email: "c2@x.com", name: "C2", avatarUrl: null },
      ]);
      mockPrisma.systemLog.count.mockResolvedValue(2);
      mockPrisma.systemLog.findMany.mockResolvedValue([
        {
          id: "log-1",
          userId: "c1",
          action: "CREATE_PRODUCT",
          level: "INFO",
          message: "criou",
          createdAt: new Date(),
        },
        {
          id: "log-2",
          userId: "c2",
          action: "DELETE_PRODUCT",
          level: "WARNING",
          message: "removeu",
          createdAt: new Date(),
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/me/team/activity?page=1&limit=20",
        headers: asUser({ id: "admin-1", parentUserId: null }),
      });

      expect(res.statusCode).toBe(200);
      const callArgs = mockPrisma.systemLog.findMany.mock.calls[0][0];
      expect(callArgs.where.userId).toEqual({ in: ["c1", "c2"] });
      // Não inclui admin-1 no escopo (decisão: só ações dos colaboradores).
      expect(callArgs.where.userId.in).not.toContain("admin-1");

      const body = JSON.parse(res.payload);
      expect(body.collaborators).toHaveLength(2);
      expect(body.logs).toHaveLength(2);
    });

    it("collaboratorId fora dos filhos do admin é ignorado (anti-injection)", async () => {
      findChildrenMock.mockResolvedValue([
        { id: "c1", email: "c1@x.com", name: "C1", avatarUrl: null },
      ]);
      mockPrisma.systemLog.count.mockResolvedValue(0);
      mockPrisma.systemLog.findMany.mockResolvedValue([]);

      await app.inject({
        method: "GET",
        url: "/me/team/activity?collaboratorId=outsider-1",
        headers: asUser({ id: "admin-1", parentUserId: null }),
      });

      const callArgs = mockPrisma.systemLog.findMany.mock.calls[0][0];
      expect(callArgs.where.userId).toEqual({ in: ["c1"] });
    });
  });

  describe("GET /me/team/presence", () => {
    it("admin: retorna presence para os filhos", async () => {
      findChildrenMock.mockResolvedValue([
        { id: "c1", email: "c1@x.com", name: "C1", avatarUrl: null },
      ]);
      const recent = new Date();
      mockPrisma.systemLog.groupBy.mockResolvedValue([
        { userId: "c1", _max: { createdAt: recent } },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/me/team/presence",
        headers: asUser({ id: "admin-1", parentUserId: null }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.presence.c1.online).toBe(true);
    });

    it("usuário sem atividade recente: online=false", async () => {
      // userId distinto do teste anterior pra evitar colisão com cache de 30s.
      findChildrenMock.mockResolvedValue([
        { id: "c-offline", email: "off@x.com", name: "Off", avatarUrl: null },
      ]);
      mockPrisma.systemLog.groupBy.mockResolvedValue([]);

      const res = await app.inject({
        method: "GET",
        url: "/me/team/presence",
        headers: asUser({ id: "admin-1", parentUserId: null }),
      });

      const body = JSON.parse(res.payload);
      expect(body.presence["c-offline"].online).toBe(false);
      expect(body.presence["c-offline"].lastSeenAt).toBeNull();
    });
  });
});

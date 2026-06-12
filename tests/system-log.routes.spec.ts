import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// Usuário admin resolvido pelo authMiddleware (via prisma mockado).
const adminUser = {
  id: "admin-1",
  email: "admin@test.com",
  password: "x",
  role: "ADMIN",
  parentUserId: null as string | null,
  name: "Admin",
  createdAt: new Date("2020-01-01"),
  updatedAt: new Date("2020-01-01"),
};

vi.mock("@/app/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(({ where }: { where: any }) =>
        Promise.resolve(
          where.email === adminUser.email || where.id === adminUser.id
            ? adminUser
            : null,
        ),
      ),
      // getTenantUserIds → filhos do admin (nenhum nos testes)
      findMany: vi.fn().mockResolvedValue([]),
    },
    systemLog: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import { systemLogRoutes } from "../app/routes/system-log.routes";
import { SystemLogService } from "../app/services/system-log.service";

// Header de autenticação usado em todas as chamadas (legacy mode).
const AUTH = { email: "admin@test.com" };
// Escopo de tenant esperado (admin sem filhos → só ele mesmo).
const SCOPE = ["admin-1"];

describe("system-log routes (autenticadas + escopadas por tenant)", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(systemLogRoutes, { prefix: "/system-logs" });
  });

  afterEach(async () => {
    // clearAllMocks (não restoreAllMocks): zera o histórico de chamadas mas
    // PRESERVA as implementações do prisma mockado (findUnique/findMany) que o
    // authMiddleware e o getTenantUserIds usam. restoreAllMocks zeraria o
    // mockResolvedValue do prisma e quebraria a auth/escopo nos testes seguintes.
    vi.clearAllMocks();
    await app.close();
  });

  describe("auth", () => {
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

  describe("GET /system-logs", () => {
    it("chama getLogs com escopo do tenant e paginação padrão → 200", async () => {
      const payload = {
        logs: [
          {
            id: "log-1",
            action: "CREATE_PRODUCT",
            level: "INFO",
            message: "Produto criado",
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      };
      const spy = vi
        .spyOn(SystemLogService, "getLogs")
        .mockResolvedValue(payload as any);

      const res = await app.inject({
        method: "GET",
        url: "/system-logs",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(payload);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          limit: 50,
          filters: expect.objectContaining({
            userIds: SCOPE,
            action: undefined,
            resource: undefined,
            level: undefined,
            startDate: undefined,
            endDate: undefined,
            search: undefined,
          }),
        }),
      );
    });

    it("propaga action/resource/level/search mas IGNORA userId do cliente (escopo imposto pelo servidor)", async () => {
      const spy = vi.spyOn(SystemLogService, "getLogs").mockResolvedValue({
        logs: [],
        total: 0,
        page: 3,
        limit: 25,
        totalPages: 0,
      } as any);

      const res = await app.inject({
        method: "GET",
        url: "/system-logs?page=3&limit=25&userId=outro-tenant&action=SYNC_STOCK&resource=Product&level=ERROR&search=erro",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const args = spy.mock.calls[0][0];
      expect(args.page).toBe(3);
      expect(args.limit).toBe(25);
      expect(args.filters).toMatchObject({
        action: "SYNC_STOCK",
        resource: "Product",
        level: "ERROR",
        search: "erro",
        userIds: SCOPE,
      });
      // O userId do cliente NÃO é honrado (não há cross-tenant via query).
      expect((args.filters as any).userId).toBeUndefined();
    });

    it("converte startDate e endDate para Date", async () => {
      const spy = vi
        .spyOn(SystemLogService, "getLogs")
        .mockResolvedValue({
          logs: [],
          total: 0,
          page: 1,
          limit: 50,
          totalPages: 0,
        } as any);

      await app.inject({
        method: "GET",
        url: "/system-logs?startDate=2026-04-01T00:00:00.000Z&endDate=2026-04-12T00:00:00.000Z",
        headers: AUTH,
      });

      const filters = spy.mock.calls[0][0].filters!;
      expect(filters.startDate).toBeInstanceOf(Date);
      expect(filters.endDate).toBeInstanceOf(Date);
      expect(filters.startDate!.toISOString()).toBe("2026-04-01T00:00:00.000Z");
      expect(filters.endDate!.toISOString()).toBe("2026-04-12T00:00:00.000Z");
    });

    it("retorna 500 com mensagem genérica quando o service falha", async () => {
      vi.spyOn(SystemLogService, "getLogs").mockRejectedValue(
        new Error("db down"),
      );

      const res = await app.inject({
        method: "GET",
        url: "/system-logs",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Erro interno do servidor");
      expect(body.message).toMatch(/logs do sistema/i);
    });
  });

  describe("GET /system-logs/stats", () => {
    it("retorna estatísticas do service (escopado por tenant)", async () => {
      const stats = {
        totalLogs: 10,
        logsByLevel: { INFO: 8, ERROR: 2 },
        logsByAction: { CREATE_PRODUCT: 5 },
        logsByResource: { Product: 5 },
        recentActivity: [],
      };
      const spy = vi
        .spyOn(SystemLogService, "getStats")
        .mockResolvedValue(stats as any);

      const res = await app.inject({
        method: "GET",
        url: "/system-logs/stats",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(stats);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ userIds: SCOPE }),
      );
    });

    it("retorna 500 quando getStats falha", async () => {
      vi.spyOn(SystemLogService, "getStats").mockRejectedValue(
        new Error("boom"),
      );

      const res = await app.inject({
        method: "GET",
        url: "/system-logs/stats",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(500);
    });
  });

  describe("DELETE /system-logs/cleanup", () => {
    it("usa 90 dias como padrão e escopa ao tenant", async () => {
      const spy = vi
        .spyOn(SystemLogService, "cleanupOldLogs")
        .mockResolvedValue(42);

      const res = await app.inject({
        method: "DELETE",
        url: "/system-logs/cleanup",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith(90, SCOPE);
      const body = JSON.parse(res.payload);
      expect(body.deletedCount).toBe(42);
      expect(body.message).toMatch(/90/);
    });

    it("propaga daysOld da query para cleanupOldLogs (escopado)", async () => {
      const spy = vi
        .spyOn(SystemLogService, "cleanupOldLogs")
        .mockResolvedValue(7);

      const res = await app.inject({
        method: "DELETE",
        url: "/system-logs/cleanup?daysOld=30",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith(30, SCOPE);
      expect(JSON.parse(res.payload).deletedCount).toBe(7);
    });

    it("retorna 500 quando cleanup falha", async () => {
      vi.spyOn(SystemLogService, "cleanupOldLogs").mockRejectedValue(
        new Error("lock timeout"),
      );

      const res = await app.inject({
        method: "DELETE",
        url: "/system-logs/cleanup",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(500);
    });
  });
});

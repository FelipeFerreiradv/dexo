import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

import { systemLogRoutes } from "../app/routes/system-log.routes";
import { SystemLogService } from "../app/services/system-log.service";

describe("system-log routes", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(systemLogRoutes, { prefix: "/system-logs" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("GET /system-logs", () => {
    it("chama SystemLogService.getLogs com paginação padrão e devolve 200", async () => {
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

      const res = await app.inject({ method: "GET", url: "/system-logs" });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(payload);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          limit: 50,
          filters: expect.objectContaining({
            userId: undefined,
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

    it("propaga filtros userId, action, resource, level e search", async () => {
      const spy = vi
        .spyOn(SystemLogService, "getLogs")
        .mockResolvedValue({
          logs: [],
          total: 0,
          page: 3,
          limit: 25,
          totalPages: 0,
        } as any);

      const res = await app.inject({
        method: "GET",
        url: "/system-logs?page=3&limit=25&userId=user-1&action=SYNC_STOCK&resource=Product&level=ERROR&search=erro",
      });

      expect(res.statusCode).toBe(200);
      const args = spy.mock.calls[0][0];
      expect(args.page).toBe("3");
      expect(args.limit).toBe("25");
      expect(args.filters).toMatchObject({
        userId: "user-1",
        action: "SYNC_STOCK",
        resource: "Product",
        level: "ERROR",
        search: "erro",
      });
    });

    it("converte startDate e endDate para Date", async () => {
      const spy = vi
        .spyOn(SystemLogService, "getLogs")
        .mockResolvedValue({ logs: [], total: 0, page: 1, limit: 50, totalPages: 0 } as any);

      await app.inject({
        method: "GET",
        url: "/system-logs?startDate=2026-04-01T00:00:00.000Z&endDate=2026-04-12T00:00:00.000Z",
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

      const res = await app.inject({ method: "GET", url: "/system-logs" });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Erro interno do servidor");
      expect(body.message).toMatch(/logs do sistema/i);
    });
  });

  describe("GET /system-logs/stats", () => {
    it("retorna estatísticas do service", async () => {
      const stats = {
        totalLogs: 10,
        logsByLevel: { INFO: 8, ERROR: 2 },
        logsByAction: { CREATE_PRODUCT: 5 },
        logsByResource: { Product: 5 },
        last7Days: [],
      };
      vi.spyOn(SystemLogService, "getStats").mockResolvedValue(stats as any);

      const res = await app.inject({
        method: "GET",
        url: "/system-logs/stats",
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(stats);
    });

    it("retorna 500 quando getStats falha", async () => {
      vi.spyOn(SystemLogService, "getStats").mockRejectedValue(new Error("boom"));

      const res = await app.inject({
        method: "GET",
        url: "/system-logs/stats",
      });

      expect(res.statusCode).toBe(500);
    });
  });

  describe("DELETE /system-logs/cleanup", () => {
    it("usa 90 dias como padrão quando daysOld não é enviado", async () => {
      const spy = vi
        .spyOn(SystemLogService, "cleanupOldLogs")
        .mockResolvedValue(42);

      const res = await app.inject({
        method: "DELETE",
        url: "/system-logs/cleanup",
      });

      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith(90);
      const body = JSON.parse(res.payload);
      expect(body.deletedCount).toBe(42);
      expect(body.message).toMatch(/90/);
    });

    it("propaga daysOld da query para cleanupOldLogs", async () => {
      const spy = vi
        .spyOn(SystemLogService, "cleanupOldLogs")
        .mockResolvedValue(7);

      const res = await app.inject({
        method: "DELETE",
        url: "/system-logs/cleanup?daysOld=30",
      });

      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith("30");
      expect(JSON.parse(res.payload).deletedCount).toBe(7);
    });

    it("retorna 500 quando cleanup falha", async () => {
      vi.spyOn(SystemLogService, "cleanupOldLogs").mockRejectedValue(
        new Error("lock timeout"),
      );

      const res = await app.inject({
        method: "DELETE",
        url: "/system-logs/cleanup",
      });

      expect(res.statusCode).toBe(500);
    });
  });
});

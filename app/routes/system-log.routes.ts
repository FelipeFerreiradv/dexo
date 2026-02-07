import { FastifyInstance } from "fastify";
import { SystemLogService } from "../services/system-log.service";

/**
 * Rotas para gerenciamento de logs do sistema
 */
export const systemLogRoutes = async (fastify: FastifyInstance) => {
  // GET /system-logs - Listar logs com filtros e paginação
  fastify.get("/", async (request, reply) => {
    try {
      const {
        page = 1,
        limit = 50,
        userId,
        action,
        resource,
        level,
        startDate,
        endDate,
        search,
      } = request.query as any;

      const result = await SystemLogService.getLogs({
        page,
        limit,
        filters: {
          userId,
          action,
          resource,
          level,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
          search,
        },
      });

      reply.status(200).send(result);
    } catch (error) {
      reply.status(500).send({
        error: "Erro interno do servidor",
        message: "Falha ao buscar logs do sistema",
      });
    }
  });

  // GET /system-logs/stats - Estatísticas dos logs
  fastify.get("/stats", async (request, reply) => {
    try {
      const { startDate, endDate } = request.query as any;

      const stats = await SystemLogService.getStats({
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      reply.status(200).send(stats);
    } catch (error) {
      reply.status(500).send({
        error: "Erro interno do servidor",
        message: "Falha ao obter estatísticas dos logs",
      });
    }
  });

  // DELETE /system-logs/cleanup - Limpar logs antigos
  fastify.delete("/cleanup", async (request, reply) => {
    try {
      const { daysOld = 90 } = request.query as any;

      const deletedCount = await SystemLogService.cleanupOldLogs(daysOld);

      reply.status(200).send({
        message: `Logs com mais de ${daysOld} dias foram removidos`,
        deletedCount,
      });
    } catch (error) {
      reply.status(500).send({
        error: "Erro interno do servidor",
        message: "Falha ao limpar logs antigos",
      });
    }
  });
};

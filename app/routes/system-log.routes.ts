import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SystemLogService } from "../services/system-log.service";
import { authMiddleware } from "../middlewares/auth.middleware";
import { blockCollaborator } from "../middlewares/no-collaborator.middleware";

/**
 * Rotas para gerenciamento de logs do sistema.
 *
 * SEGURANÇA: antes estas rotas eram TOTALMENTE públicas (sem auth) e sem
 * escopo de tenant — qualquer um na rede lia/limpava logs de todos os
 * clientes (PII no `details`) e podia apagar o trilho de auditoria.
 * Agora exigem autenticação e são escopadas ao tenant do chamador.
 */
export const systemLogRoutes = async (fastify: FastifyInstance) => {
  // GET /system-logs - Listar logs com filtros e paginação (escopo do tenant)
  fastify.get(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as {
          id: string;
          parentUserId?: string | null;
        };
        const userIds = await SystemLogService.getTenantUserIds(me);

        const {
          page = 1,
          limit = 50,
          action,
          resource,
          level,
          startDate,
          endDate,
          search,
        } = request.query as any;

        const result = await SystemLogService.getLogs({
          page: Number(page) || 1,
          limit: Number(limit) || 50,
          filters: {
            userIds,
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
    },
  );

  // GET /system-logs/stats - Estatísticas dos logs (escopo do tenant)
  fastify.get(
    "/stats",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as {
          id: string;
          parentUserId?: string | null;
        };
        const userIds = await SystemLogService.getTenantUserIds(me);

        const { startDate, endDate } = request.query as any;

        const stats = await SystemLogService.getStats({
          userIds,
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
    },
  );

  // DELETE /system-logs/cleanup - Limpar logs antigos (admin, escopo do tenant)
  fastify.delete(
    "/cleanup",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as {
          id: string;
          parentUserId?: string | null;
        };
        const userIds = await SystemLogService.getTenantUserIds(me);

        const { daysOld = 90 } = request.query as any;

        const deletedCount = await SystemLogService.cleanupOldLogs(
          Number(daysOld) || 90,
          userIds,
        );

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
    },
  );
};

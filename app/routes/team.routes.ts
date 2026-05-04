import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { SystemLogService } from "../services/system-log.service";
import type { LogAction } from "../interfaces/system-log.interface";

const userRepository = new UserRepositoryPrisma();

// Cache curto de presença pra evitar pressão na tabela SystemLog.
// Os clientes (sidebar) revalidam a cada 60s; cache de 30s é suficiente.
type PresenceMap = Record<string, { online: boolean; lastSeenAt: Date | null }>;
const presenceCache = new Map<string, { data: PresenceMap; exp: number }>();
const PRESENCE_TTL_MS = 30_000;
const PRESENCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutos = "online"

function publicUser(u: {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  parentUserId?: string | null;
  createdAt?: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    avatarUrl: u.avatarUrl ?? null,
    parentUserId: u.parentUserId ?? null,
    createdAt: u.createdAt ?? null,
  };
}

async function loadPresence(userIds: string[]): Promise<PresenceMap> {
  if (userIds.length === 0) return {};

  const cacheKey = [...userIds].sort().join(",");
  const cached = presenceCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data;

  // Última atividade por user nas últimas 24h (filtra mais agressivo que a janela
  // de presença para reduzir custo da agregação; quem está fora das 24h é offline).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.systemLog.groupBy({
    by: ["userId"],
    where: {
      userId: { in: userIds },
      createdAt: { gte: since },
    },
    _max: { createdAt: true },
  });

  const now = Date.now();
  const result: PresenceMap = {};
  for (const id of userIds) {
    result[id] = { online: false, lastSeenAt: null };
  }
  for (const row of rows) {
    if (!row.userId) continue;
    const last = row._max.createdAt ?? null;
    result[row.userId] = {
      online: !!last && now - last.getTime() <= PRESENCE_WINDOW_MS,
      lastSeenAt: last,
    };
  }

  presenceCache.set(cacheKey, { data: result, exp: now + PRESENCE_TTL_MS });
  return result;
}

export const teamRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /me/team
   * Para admin: { parent: null, children: [...colaboradores] }
   * Para colaborador: { parent: <admin>, children: [] }
   */
  fastify.get(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as {
          id: string;
          parentUserId?: string | null;
        };

        if (me.parentUserId) {
          const parent = await userRepository.findById(me.parentUserId);
          return reply.send({
            parent: parent ? publicUser(parent) : null,
            children: [],
          });
        }

        const children = await userRepository.findChildren(me.id);
        return reply.send({
          parent: null,
          children: children.map((c) => publicUser(c)),
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao carregar equipe",
        });
      }
    },
  );

  /**
   * GET /me/team/presence
   * Status online/lastSeen para os membros da equipe.
   */
  fastify.get(
    "/presence",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as {
          id: string;
          parentUserId?: string | null;
        };

        const userIds: string[] = me.parentUserId
          ? [me.parentUserId]
          : (await userRepository.findChildren(me.id)).map((c) => c.id);

        const presence = await loadPresence(userIds);
        return reply.send({ presence });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao carregar presença",
        });
      }
    },
  );

  /**
   * GET /me/team/activity
   * Audit log das ações dos colaboradores do admin logado.
   * Apenas admins (sem parentUserId) podem chamar — colaboradores recebem 403.
   * Filtros suportados: collaboratorId, action, startDate, endDate, page, limit.
   */
  fastify.get(
    "/activity",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as {
          id: string;
          parentUserId?: string | null;
        };

        if (me.parentUserId) {
          return reply.status(403).send({
            message:
              "Apenas administradores podem visualizar a atividade da equipe.",
            code: "ADMIN_ONLY",
          });
        }

        const q = request.query as Record<string, string | undefined>;
        const page = q.page ? parseInt(q.page, 10) : 1;
        const limit = q.limit ? Math.min(parseInt(q.limit, 10), 200) : 50;
        const collaboratorId = q.collaboratorId || undefined;
        const action = (q.action as LogAction | undefined) || undefined;
        const startDate = q.startDate ? new Date(q.startDate) : undefined;
        const endDate = q.endDate ? new Date(q.endDate) : undefined;

        const children = await userRepository.findChildren(me.id);
        const childIds = children.map((c) => c.id);

        if (childIds.length === 0) {
          return reply.send({
            logs: [],
            collaborators: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
          });
        }

        // Restringir collaboratorId aos filhos do admin.
        const targetIds =
          collaboratorId && childIds.includes(collaboratorId)
            ? [collaboratorId]
            : childIds;

        const where: Record<string, any> = {
          userId: { in: targetIds },
        };
        if (action) where.action = action;
        if (startDate || endDate) {
          where.createdAt = {};
          if (startDate) where.createdAt.gte = startDate;
          if (endDate) where.createdAt.lte = endDate;
        }

        const [total, rows] = await Promise.all([
          prisma.systemLog.count({ where }),
          prisma.systemLog.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          }),
        ]);

        return reply.send({
          logs: rows,
          collaborators: children.map((c) => publicUser(c)),
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 0,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao carregar atividade da equipe",
        });
      }
    },
  );
};

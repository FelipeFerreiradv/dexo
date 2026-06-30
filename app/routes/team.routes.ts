import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { SystemLogService } from "../services/system-log.service";
import type { LogAction } from "../interfaces/system-log.interface";
import {
  aggregateBudgetsByVendedor,
  aggregateTeamProductivity,
  resolveProductivityRange,
} from "../lib/team-productivity";
import {
  fetchBudgetStatsByVendedor,
  fetchProductivityGroups,
} from "../lib/team-productivity.query";
import { renderTeamProductivityReport } from "../reports/team-productivity-report";

const userRepository = new UserRepositoryPrisma();

function fmtDateTimeBR(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

/**
 * Carrega a produtividade da equipe (compartilhado entre o endpoint JSON e o
 * relatório PDF): resolve o período, escopa por filhos (fail-closed se vazio),
 * lê SystemLog deduplicado na origem e agrega. Leitura PURA.
 */
async function loadTeamProductivity(
  adminId: string,
  q: Record<string, string | undefined>,
) {
  const range = resolveProductivityRange(q.startDate, q.endDate);
  const rangeOut = {
    startDate: range.startDate.toISOString(),
    endDate: range.endDate.toISOString(),
    label: range.label,
  };

  const [admin, children] = await Promise.all([
    userRepository.findById(adminId),
    userRepository.findChildren(adminId),
  ]);

  // Vendedores selecionáveis = admin + colaboradores (mesma lista do dropdown
  // de orçamento). O admin também pode ser o vendedor de uma venda própria.
  const vendedores = [
    ...(admin
      ? [{ id: admin.id, name: admin.name, email: admin.email, isOwner: true }]
      : []),
    ...children.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      isOwner: false,
    })),
  ];

  const childIds = children.map((c) => c.id);

  // EGRESS + velocidade: as 2 queries pesadas e INDEPENDENTES (orçamentos por
  // vendedor + grupos de produtividade do SystemLog) rodam em PARALELO — uma
  // única ida ao banco em vez de duas sequenciais. Ambas agregam no banco.
  const [budgetRows, groups] = await Promise.all([
    fetchBudgetStatsByVendedor(adminId, range.startDate, range.endDate),
    childIds.length > 0
      ? fetchProductivityGroups(childIds, range.startDate, range.endDate)
      : Promise.resolve([]),
  ]);

  const budgets = aggregateBudgetsByVendedor(budgetRows, vendedores);

  // Produtividade (colaboradores via SystemLog). Fail-closed sem colaboradores
  // — mas o bloco de orçamentos por vendedor (acima) continua valendo.
  const result =
    childIds.length > 0
      ? aggregateTeamProductivity(
          groups,
          children.map((c) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            avatarUrl: c.avatarUrl,
          })),
          range,
        )
      : {
          totals: {
            produtos: 0,
            anuncios: { total: 0, ml: 0, shopee: 0, magalu: 0, outro: 0 },
          },
          byCollaborator: [],
          timeseries: [],
        };

  return {
    rangeOut,
    admin,
    result: {
      ...result,
      budgetsByVendedor: budgets.byVendedor,
      budgetTotals: budgets.totals,
    },
  };
}

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

  /**
   * GET /me/team/productivity
   * Produtividade (produtos e anúncios criados) por colaborador no período.
   * Admin-only (403 p/ colaborador, igual /activity); escopo = filhos do admin
   * (childIds). Leitura PURA de SystemLog, deduplicada NA ORIGEM (só a linha do
   * serviço: `resourceId != null` + `level = INFO`, descartando a linha do
   * middleware de logging e tentativas falhas). Split de plataforma via
   * canonPlatform sobre `details.marketplace`.
   * Querystring: startDate, endDate (ISO ou "YYYY-MM-DD"). Default: 30 dias.
   */
  fastify.get(
    "/productivity",
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
              "Apenas administradores podem visualizar a produtividade da equipe.",
            code: "ADMIN_ONLY",
          });
        }

        const q = request.query as Record<string, string | undefined>;
        const { rangeOut, result } = await loadTeamProductivity(me.id, q);
        return reply.send({ range: rangeOut, ...result });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao carregar produtividade da equipe",
        });
      }
    },
  );

  /**
   * GET /me/team/productivity/report.pdf
   * Relatório PDF (A4) da produtividade da equipe no período. Mesma guarda
   * admin-only e escopo da rota JSON. Leitura PURA + render @react-pdf; streama
   * o arquivo como download. Período vazio ⇒ PDF de 1 página "sem atividade".
   */
  fastify.get(
    "/productivity/report.pdf",
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
              "Apenas administradores podem gerar o relatório da equipe.",
            code: "ADMIN_ONLY",
          });
        }

        const q = request.query as Record<string, string | undefined>;
        // loadTeamProductivity já busca o admin (p/ a lista de vendedores) —
        // reusamos p/ o nome da empresa, sem refazer a mesma query (egress).
        const { rangeOut, result, admin } = await loadTeamProductivity(
          me.id,
          q,
        );
        const company = admin?.name || admin?.email || "Sua empresa";

        const pdf = await renderTeamProductivityReport({
          company,
          generatedAtLabel: fmtDateTimeBR(new Date()),
          range: rangeOut,
          totals: result.totals,
          byCollaborator: result.byCollaborator,
          timeseries: result.timeseries,
          budgetsByVendedor: result.budgetsByVendedor ?? [],
          budgetTotals: result.budgetTotals ?? {
            orcamentos: { count: 0, valor: 0 },
            convertidos: { count: 0, valor: 0 },
          },
        });

        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            'attachment; filename="produtividade-equipe-dexo.pdf"',
          )
          .send(pdf);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao gerar o relatório da equipe",
        });
      }
    },
  );
};

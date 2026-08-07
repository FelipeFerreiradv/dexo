import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { blockCollaborator } from "../middlewares/no-collaborator.middleware";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { UserUseCase } from "../usecases/user.usercase";
import { toPublicUser } from "../lib/user-serializer";
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
const userUserCase = new UserUseCase();

// Validação de e-mail alinhada ao input type="email" do front (sem lowercase:
// o login faz match exato por findByEmail, então normalizar caixa aqui poderia
// impedir o colaborador de logar). Apenas trim antes de checar/gravar.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  isActive?: boolean;
  pagePermissions?: Record<string, boolean> | null;
  createdAt?: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    avatarUrl: u.avatarUrl ?? null,
    parentUserId: u.parentUserId ?? null,
    // Aditivo: usado pela gestão de colaboradores p/ mostrar ativo/inativo.
    // Consumidores atuais (GET /me/team, /activity) simplesmente ignoram.
    isActive: u.isActive ?? true,
    // Aditivo (Entrega C): permissões por página p/ prefill do modal de edição.
    pagePermissions: u.pagePermissions ?? null,
    createdAt: u.createdAt ?? null,
  };
}

// Entrega C: aceita só um mapa { [pageId]: boolean }. Qualquer outra coisa
// (ausente/tipo errado) → undefined ⇒ o repositório não altera o campo.
function sanitizePagePermissions(
  input: unknown,
): Record<string, boolean> | undefined {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
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

  /**
   * GET /me/team/collaborators
   * Lista os colaboradores (filhos) do admin logado, incluindo `isActive` para
   * a UI de gestão de equipe. Admin-only: blockCollaborator devolve 403 a quem
   * tem parentUserId (colaborador não gerencia sub-colaboradores).
   */
  fastify.get(
    "/collaborators",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const me = (request as any).user as { id: string };
        // Projeção enxuta (só as colunas exibidas) p/ egress mínimo na lista.
        const children = await userRepository.findChildrenPublic(me.id);
        return reply.send({
          collaborators: children.map((c) => publicUser(c)),
        });
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error
              ? error.message
              : "Erro ao carregar colaboradores",
        });
      }
    },
  );

  /**
   * POST /me/team/collaborators
   * Cria um colaborador vinculado ao admin logado. O vínculo (parentUserId) é
   * FORÇADO no servidor = me.id — jamais vem do body. Admin-only. Nunca devolve
   * a senha (toPublicUser). E-mail duplicado ⇒ 409.
   */
  fastify.post<{
    Body: {
      name?: string;
      email?: string;
      password?: string;
      pagePermissions?: Record<string, boolean> | null;
    };
  }>(
    "/collaborators",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request, reply) => {
      try {
        const me = (request as any).user as { id: string };
        const name = (request.body?.name ?? "").trim();
        const email = (request.body?.email ?? "").trim();
        const password = request.body?.password ?? "";
        const pagePermissions = sanitizePagePermissions(
          request.body?.pagePermissions,
        );

        if (!name) {
          return reply
            .status(400)
            .send({ message: "Informe o nome do colaborador." });
        }
        if (!EMAIL_RE.test(email)) {
          return reply
            .status(400)
            .send({ message: "Informe um e-mail válido." });
        }
        if (password.length < 8) {
          return reply
            .status(400)
            .send({ message: "A senha deve ter no mínimo 8 caracteres." });
        }

        try {
          const data = await userUserCase.create({
            name,
            email,
            password,
            parentUserId: me.id,
            // Aditivo (Entrega C): só vai quando enviado; ausente → não grava.
            ...(pagePermissions !== undefined && { pagePermissions }),
          });

          await SystemLogService.logUserActivity(
            data.id,
            `Colaborador criado: ${data.name} (${data.email})`,
            { resource: "User", resourceId: data.id },
          );

          return reply.status(201).send(toPublicUser(data));
        } catch (err) {
          if (err instanceof Error && err.message === "User already exists") {
            return reply
              .status(409)
              .send({ message: "Já existe um usuário com esse e-mail." });
          }
          throw err;
        }
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Erro ao criar colaborador",
        });
      }
    },
  );

  /**
   * PATCH /me/team/collaborators/:id
   * Edita nome e/ou senha de um colaborador DO PRÓPRIO admin (checagem de posse).
   * Reaproveita updateSettings (rehash de senha + ignora campos undefined). Nunca
   * toca parentUserId/role; nunca edita o próprio admin por aqui (isso é
   * /users/me/settings). Senha em branco ⇒ não altera.
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      password?: string;
      pagePermissions?: Record<string, boolean> | null;
    };
  }>(
    "/collaborators/:id",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request, reply) => {
      try {
        const me = (request as any).user as { id: string };
        const { id } = request.params;

        if (id === me.id) {
          return reply.status(403).send({
            message:
              "Use as configurações da sua conta para editar você mesmo.",
          });
        }

        const target = await userRepository.findById(id);
        if (!target) {
          return reply
            .status(404)
            .send({ message: "Colaborador não encontrado." });
        }
        if (target.parentUserId !== me.id) {
          return reply.status(403).send({ message: "Acesso negado" });
        }

        const patch: {
          name?: string;
          password?: string;
          pagePermissions?: Record<string, boolean> | null;
        } = {};
        if (typeof request.body?.name === "string") {
          const name = request.body.name.trim();
          if (!name) {
            return reply
              .status(400)
              .send({ message: "Informe o nome do colaborador." });
          }
          patch.name = name;
        }
        if (
          typeof request.body?.password === "string" &&
          request.body.password.length > 0
        ) {
          if (request.body.password.length < 8) {
            return reply
              .status(400)
              .send({ message: "A senha deve ter no mínimo 8 caracteres." });
          }
          patch.password = request.body.password;
        }
        // Aditivo (Entrega C): permissões por página (só altera quando enviado).
        //
        // ⚠️ Gravadas por `updateAccessControl`, e NÃO no patch largo: `update()`
        // recebe `UserUpdate`, que é o corpo cru das rotas de autoatendimento.
        // A posse já foi checada acima (o alvo é colaborador DESTE admin).
        const pp = sanitizePagePermissions(request.body?.pagePermissions);

        let data = await userUserCase.updateSettings(id, patch);
        if (pp !== undefined) {
          data = await userRepository.updateAccessControl(id, {
            pagePermissions: pp,
          });
        }

        await SystemLogService.logUserActivity(
          id,
          `Colaborador atualizado: ${data.name ?? data.email}`,
          { resource: "User", resourceId: id },
        );

        return reply.status(200).send(toPublicUser(data));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error
              ? error.message
              : "Erro ao atualizar colaborador",
        });
      }
    },
  );

  /**
   * PATCH /me/team/collaborators/:id/status
   * Ativa/desativa um colaborador do próprio admin (posse). Reaproveita o campo
   * isActive; o corte da sessão ativa em ≤60s já é feito pelo auth.middleware
   * (effectiveActive + cache). Bloqueia auto-desativação.
   */
  fastify.patch<{
    Params: { id: string };
    Body: { isActive?: boolean };
  }>(
    "/collaborators/:id/status",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request, reply) => {
      try {
        const me = (request as any).user as { id: string };
        const { id } = request.params;
        const isActive = request.body?.isActive;

        if (typeof isActive !== "boolean") {
          return reply
            .status(400)
            .send({ message: "Informe isActive (boolean)." });
        }
        if (id === me.id) {
          return reply
            .status(403)
            .send({ message: "Você não pode desativar a própria conta." });
        }

        const target = await userRepository.findById(id);
        if (!target) {
          return reply
            .status(404)
            .send({ message: "Colaborador não encontrado." });
        }
        if (target.parentUserId !== me.id) {
          return reply.status(403).send({ message: "Acesso negado" });
        }

        // Controle de acesso vai pelo método estreito. Posse já checada acima.
        const data = await userRepository.updateAccessControl(id, { isActive });

        await SystemLogService.logUserActivity(
          id,
          `Colaborador ${isActive ? "ativado" : "desativado"}: ${
            data.name ?? data.email
          }`,
          { resource: "User", resourceId: id },
        );

        return reply.status(200).send(toPublicUser(data));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error
              ? error.message
              : "Erro ao alterar status do colaborador",
        });
      }
    },
  );
};

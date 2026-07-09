import { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireSuperadmin } from "../middlewares/require-superadmin.middleware";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { UserUseCase } from "../usecases/user.usercase";
import { toPublicUser } from "../lib/user-serializer";
import { SystemLogService } from "../services/system-log.service";

const userRepository = new UserRepositoryPrisma();
const userUseCase = new UserUseCase();

// Mesma validação de e-mail do team.routes (sem lowercase: login faz match
// exato por findByEmail).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Aceita só um mapa { [pageId]: boolean }; qualquer outra coisa → undefined
// (o repositório não altera o campo). Igual ao de team.routes.
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

/**
 * Rotas exclusivas da equipe Dexo (Superadmin). Guardadas por
 * [authMiddleware, requireSuperadmin]. Permitem criar administradores e
 * usuários/colaboradores com os campos padrão e listar toda a hierarquia.
 *
 * NÃO reaproveita /me/team/* (aquilo é o admin comum gerenciando os próprios
 * colaboradores). Aditivo: não altera nenhuma rota existente.
 */
export const superadminRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /superadmin/users — lista todos os usuários (admins e colaboradores)
   * com hierarquia e defaults (projeção enxuta, sem senha).
   */
  fastify.get(
    "/users",
    { preHandler: [authMiddleware, requireSuperadmin] },
    async (_request, reply) => {
      try {
        const users = await userRepository.findAllForSuperadmin();
        return reply.status(200).send({ success: true, users });
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Erro ao listar usuários",
        });
      }
    },
  );

  /**
   * POST /superadmin/users — cria ADMIN ou USER com nome/e-mail/senha e os
   * defaults (defaultCostPrice/defaultStock). `parentUserId` opcional cria um
   * colaborador vinculado a um admin existente. Nunca cria SUPERADMIN por aqui.
   */
  fastify.post<{
    Body: {
      name?: string;
      email?: string;
      password?: string;
      role?: string;
      defaultCostPrice?: number | null;
      defaultStock?: number | null;
      parentUserId?: string | null;
    };
  }>(
    "/users",
    { preHandler: [authMiddleware, requireSuperadmin] },
    async (request, reply) => {
      try {
        const name = (request.body?.name ?? "").trim();
        const email = (request.body?.email ?? "").trim();
        const password = request.body?.password ?? "";
        const roleInput = (request.body?.role ?? "USER").toUpperCase();

        if (!name) {
          return reply.status(400).send({ message: "Informe o nome." });
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
        // Só ADMIN ou USER. SUPERADMIN é marcado manualmente no banco.
        if (roleInput !== "ADMIN" && roleInput !== "USER") {
          return reply.status(400).send({
            message: "Perfil inválido. Use 'ADMIN' ou 'USER'.",
          });
        }
        const role = roleInput as Role;

        // parentUserId (colaborador): valida que o pai existe e NÃO é ele mesmo
        // um colaborador (só admins/superadmin podem ser pais).
        let parentUserId: string | null | undefined =
          request.body?.parentUserId ?? undefined;
        if (parentUserId) {
          const parent = await userRepository.findById(parentUserId);
          if (!parent) {
            return reply
              .status(400)
              .send({ message: "Administrador pai não encontrado." });
          }
          if (parent.parentUserId) {
            return reply.status(400).send({
              message:
                "O pai selecionado é um colaborador; escolha um administrador.",
            });
          }
        } else {
          parentUserId = null;
        }

        const defaultCostPrice =
          typeof request.body?.defaultCostPrice === "number"
            ? request.body.defaultCostPrice
            : undefined;
        const defaultStock =
          typeof request.body?.defaultStock === "number"
            ? request.body.defaultStock
            : undefined;

        try {
          const data = await userUseCase.create({
            name,
            email,
            password,
            role,
            parentUserId,
            defaultCostPrice,
            defaultStock,
          });

          await SystemLogService.logUserActivity(
            data.id,
            `Usuário criado (superadmin): ${data.name} (${data.email}) [${role}]`,
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
            error instanceof Error ? error.message : "Erro ao criar usuário",
        });
      }
    },
  );

  /**
   * PATCH /superadmin/users/:id — edita nome / defaults / status (isActive) de
   * qualquer usuário. Não altera role nem parentUserId (para evitar mudanças de
   * hierarquia acidentais); reaproveita updateSettings (ignora undefined).
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      defaultCostPrice?: number | null;
      defaultStock?: number | null;
      isActive?: boolean;
      pagePermissions?: Record<string, boolean> | null;
    };
  }>(
    "/users/:id",
    { preHandler: [authMiddleware, requireSuperadmin] },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const target = await userRepository.findById(id);
        if (!target) {
          return reply.status(404).send({ message: "Usuário não encontrado." });
        }

        const patch: {
          name?: string;
          defaultCostPrice?: number | null;
          defaultStock?: number | null;
          isActive?: boolean;
          pagePermissions?: Record<string, boolean> | null;
        } = {};

        if (typeof request.body?.name === "string") {
          const name = request.body.name.trim();
          if (!name) {
            return reply.status(400).send({ message: "Informe o nome." });
          }
          patch.name = name;
        }
        if (request.body?.defaultCostPrice !== undefined) {
          patch.defaultCostPrice = request.body.defaultCostPrice;
        }
        if (request.body?.defaultStock !== undefined) {
          patch.defaultStock = request.body.defaultStock;
        }
        if (typeof request.body?.isActive === "boolean") {
          patch.isActive = request.body.isActive;
        }
        const pp = sanitizePagePermissions(request.body?.pagePermissions);
        if (pp !== undefined) {
          patch.pagePermissions = pp;
        }

        const data = await userUseCase.updateSettings(id, patch);

        await SystemLogService.logUserActivity(
          id,
          `Usuário atualizado (superadmin): ${data.name ?? data.email}`,
          { resource: "User", resourceId: id },
        );

        return reply.status(200).send(toPublicUser(data));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error
              ? error.message
              : "Erro ao atualizar usuário",
        });
      }
    },
  );
};

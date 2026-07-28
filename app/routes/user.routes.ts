import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserUseCase } from "../usecases/user.usercase";
import { UserCreate, UserUpdate } from "../interfaces/user.interface";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { SystemLogService } from "../services/system-log.service";
import { authMiddleware } from "../middlewares/auth.middleware";
import { blockCollaborator } from "../middlewares/no-collaborator.middleware";
import { toPublicUser } from "../lib/user-serializer";
import prisma from "../lib/prisma";

//Create User Routes, POST/GET
export const userRoutes = async (fastify: FastifyInstance) => {
  const userUserCase = new UserUseCase();
  const userRepository = new UserRepositoryPrisma();

  /**
   * POST /users — criação de usuário.
   * SEGURANÇA: não há auto-cadastro público no Dexo; criar usuário/colaborador
   * é operação administrativa. Exige admin autenticado (authMiddleware +
   * blockCollaborator). Nunca devolve a senha (toPublicUser).
   */
  fastify.post<{ Body: UserCreate }>(
    "/",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (
      request: FastifyRequest<{ Body: UserCreate }>,
      reply: FastifyReply,
    ) => {
      const { name, email, password, defaultProductDescription, avatarUrl } =
        request.body;
      try {
        const data = await userUserCase.create({
          name,
          email,
          password,
          defaultProductDescription,
          avatarUrl,
        });

        // Registrar log de criação de usuário
        await SystemLogService.logUserActivity(
          data.id,
          `Novo usuário criado: ${data.name} (${data.email})`,
          {
            resource: "User",
            resourceId: data.id,
          },
        );

        return reply.status(201).send(toPublicUser(data));
      } catch (error) {
        // Nunca devolver stack/erro cru ao cliente.
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );

  fastify.post<{ Body: { email: string; password: string } }>(
    "/login",
    async (
      request: FastifyRequest<{ Body: { email: string; password: string } }>,
      reply: FastifyReply,
    ) => {
      const { email, password } = request.body;
      try {
        const user = await userUserCase.login({ email, password });
        return reply.status(200).send({
          message: "Login successful",
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
          },
        });
      } catch (error) {
        reply.status(401).send({
          message: error instanceof Error ? error.message : "Login failed",
        });
      }
    },
  );

  /**
   * PUT /users/:id/settings — atualiza configurações de um usuário por id.
   * SEGURANÇA: exige auth; só o próprio usuário ou o admin-pai do alvo pode
   * alterar (antes: sem auth e sem checagem de posse = IDOR de escrita).
   */
  fastify.put<{ Body: UserUpdate; Params: { id: string } }>(
    "/:id/settings",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Body: UserUpdate; Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const me = (request as any).user as {
        id: string;
        parentUserId?: string | null;
      };
      const updateData = request.body;
      try {
        const target = await userRepository.findById(id);
        if (!target) {
          return reply.status(404).send({ message: "User not found" });
        }
        if (target.id !== me.id && target.parentUserId !== me.id) {
          return reply.status(403).send({ message: "Acesso negado" });
        }

        const data = await userUserCase.updateSettings(id, updateData);

        // Registrar log de atualização de configurações
        await SystemLogService.logUserActivity(
          id,
          `Configurações atualizadas`,
          {
            resource: "User",
            resourceId: id,
          },
        );

        return reply.status(200).send(toPublicUser(data));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );

  /**
   * GET /users/:id — busca um usuário por id.
   * SEGURANÇA: exige auth; só self ou admin-pai. Nunca devolve a senha.
   * (Antes: sem auth e devolvia o objeto cru com `password` em texto plano.)
   */
  fastify.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const me = (request as any).user as {
        id: string;
        parentUserId?: string | null;
      };
      try {
        const user = await userRepository.findById(id);
        if (!user) {
          return reply.status(404).send({ message: "User not found" });
        }
        if (user.id !== me.id && user.parentUserId !== me.id) {
          return reply.status(403).send({ message: "Acesso negado" });
        }
        return reply.status(200).send(toPublicUser(user));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );

  /**
   * GET /users/me
   * Retorna o usuário autenticado. Identidade resolvida pelo authMiddleware
   * (não mais pelo header `email` cru). Nunca devolve a senha.
   */
  fastify.get(
    "/me",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const me = (request as any).user as { id: string };
      try {
        const user = await userRepository.findById(me.id);
        if (!user) return reply.status(404).send({ message: "User not found" });
        return reply.status(200).send(toPublicUser(user));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );

  /**
   * GET /users/me/page-access
   * Só as permissões de página do usuário autenticado.
   *
   * ADITIVO — não altera `GET /users/me`. Existe por EGRESS: a sidebar sonda
   * este dado periodicamente para o menu do colaborador refletir um bloqueio
   * sem exigir relogin, e usar `/users/me` para isso trafegaria o usuário
   * inteiro (~28 colunas, incluindo `defaultProductDescription`, que é texto
   * livre) a cada sondagem. Aqui a leitura é de 2 colunas.
   *
   * Não é um gate de segurança: quem decide acesso é `assertPageAccess`
   * (server component, leitura fresca) e o preHandler `requirePageAccess` nas
   * rotas. Este endpoint só alimenta a exibição do menu.
   */
  fastify.get(
    "/me/page-access",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const me = (request as any).user as { id: string };
      try {
        const row = await prisma.user.findUnique({
          where: { id: me.id },
          select: { parentUserId: true, pagePermissions: true },
        });
        if (!row) return reply.status(404).send({ message: "User not found" });
        return reply.status(200).send({
          parentUserId: row.parentUserId ?? null,
          pagePermissions: row.pagePermissions ?? null,
        });
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );

  /**
   * PUT /users/me/settings
   * Atualiza as configurações do usuário autenticado (identidade da sessão,
   * não mais do header `email` cru). Nunca devolve a senha.
   */
  fastify.put<{ Body: UserUpdate }>(
    "/me/settings",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Body: UserUpdate }>,
      reply: FastifyReply,
    ) => {
      const me = (request as any).user as { id: string };
      try {
        const updated = await userUserCase.updateSettings(me.id, request.body);

        // Registrar log de atualização de configurações
        await SystemLogService.logUserActivity(
          me.id,
          `Configurações atualizadas`,
          {
            resource: "User",
            resourceId: me.id,
          },
        );

        return reply.status(200).send(toPublicUser(updated));
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );
};

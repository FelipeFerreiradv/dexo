import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserUseCase } from "../usecases/user.usercase";
import { UserCreate, UserUpdate } from "../interfaces/user.interface";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { SystemLogService } from "../services/system-log.service";

//Create User Routes, POST/GET
export const userRoutes = async (fastify: FastifyInstance) => {
  const userUserCase = new UserUseCase();
  fastify.post<{ Body: UserCreate }>(
    "/",
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

        return reply.status(201).send(data);
      } catch (error) {
        reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
          stack: error instanceof Error ? error.stack : undefined,
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

  fastify.put<{ Body: UserUpdate; Params: { id: string } }>(
    "/:id/settings",
    async (
      request: FastifyRequest<{ Body: UserUpdate; Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const updateData = request.body;
      try {
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

        return reply.status(200).send(data);
      } catch (error) {
        reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      try {
        const userRepository = new UserRepositoryPrisma();
        const user = await userRepository.findById(id);
        if (!user) {
          return reply.status(404).send({ message: "User not found" });
        }
        return reply.status(200).send(user);
      } catch (error) {
        reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );

  /**
   * GET /users/me
   * Retorna o usuário identificado pelo header `email` (fallback para clientes que não têm o internal id)
   */
  fastify.get("/me", async (request: FastifyRequest, reply: FastifyReply) => {
    const email = (request.headers as any).email as string | undefined;
    if (!email) {
      return reply.status(401).send({ message: "Email header é obrigatório" });
    }

    try {
      const userRepository = new UserRepositoryPrisma();
      const user = await userRepository.findByEmail(email);
      if (!user) return reply.status(404).send({ message: "User not found" });
      return reply.status(200).send(user);
    } catch (error) {
      return reply.status(500).send({
        message:
          error instanceof Error ? error.message : "Internal server error",
      });
    }
  });

  /**
   * PUT /users/me/settings
   * Atualiza as configurações do usuário identificado pelo header `email` (mesmo contrato de /:id/settings)
   */
  fastify.put<{ Body: UserUpdate }>(
    "/me/settings",
    async (
      request: FastifyRequest<{ Body: UserUpdate }>,
      reply: FastifyReply,
    ) => {
      const email = (request.headers as any).email as string | undefined;
      if (!email)
        return reply
          .status(401)
          .send({ message: "Email header é obrigatório" });

      try {
        const userRepository = new UserRepositoryPrisma();
        const user = await userRepository.findByEmail(email);
        if (!user) return reply.status(404).send({ message: "User not found" });

        const userUserCase = new UserUseCase();
        const updated = await userUserCase.updateSettings(
          user.id,
          request.body,
        );

        // Registrar log de atualização de configurações
        await SystemLogService.logUserActivity(
          user.id,
          `Configurações atualizadas`,
          {
            resource: "User",
            resourceId: user.id,
          },
        );

        return reply.status(200).send(updated);
      } catch (error) {
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );
};

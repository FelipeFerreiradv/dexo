import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UnidadeUseCase } from "../usecases/unidade.usecase";
import { authMiddleware } from "../middlewares/auth.middleware";

export const unidadeRoutes = async (fastify: FastifyInstance) => {
  const useCase = new UnidadeUseCase();

  fastify.get(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { all } = request.query as { all?: string };
        const includeInactive = all === "1" || all === "true";
        const data = await useCase.list(userId, includeInactive);
        return reply
          .status(200)
          .send({ unidades: data.unidades, total: data.total });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar unidades",
        });
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const unidade = await useCase.findById(id, userId);
        return reply.status(200).send({ unidade });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar unidade";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.post(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;
        const unidade = await useCase.create({ ...body, userId });
        return reply.status(201).send({ unidade });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar unidade";
        const status = message.includes("Já existe")
          ? 409
          : message.includes("obrigatório")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  const updateHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const body = request.body as any;
      const unidade = await useCase.update(id, userId, body);
      return reply.status(200).send({ unidade });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao atualizar unidade";
      const status = message.includes("não encontrada")
        ? 404
        : message.includes("Já existe")
          ? 409
          : message.includes("obrigatório")
            ? 400
            : 500;
      return reply.status(status).send({ error: message });
    }
  };

  // PUT (edição completa) e PATCH (edição parcial / inativar via { active: false }).
  fastify.put("/:id", { preHandler: [authMiddleware] }, updateHandler);
  fastify.patch("/:id", { preHandler: [authMiddleware] }, updateHandler);
};

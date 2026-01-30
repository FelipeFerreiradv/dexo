import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserUseCase } from "../usecases/user.usercase";
import { UserCreate } from "../interfaces/user.interface";

//Create User Routes, POST/GET
export const userRoutes = async (fastify: FastifyInstance) => {
  const userUserCase = new UserUseCase();
  fastify.post<{ Body: UserCreate }>(
    "/",
    async (
      request: FastifyRequest<{ Body: UserCreate }>,
      reply: FastifyReply,
    ) => {
      const { name, email, password } = request.body;
      try {
        const data = await userUserCase.create({
          name,
          email,
          password,
        });
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

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.send({ hello: "hello world" });
  });
};

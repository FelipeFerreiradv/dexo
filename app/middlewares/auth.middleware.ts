import { FastifyReply, FastifyRequest } from "fastify";
import { UserRepositoryPrisma } from "../repositories/user.repository";

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const apiEmail = request.headers["email"];
  if (!apiEmail) {
    return reply.status(401).send({ message: "Email is required" });
  }

  const userRepository = new UserRepositoryPrisma();
  const user = await userRepository.findByEmail(apiEmail as string);

  if (!user) {
    return reply.status(401).send({ message: "User not found in database" });
  }

  // Anexar usuário ao request para usar em outras rotas
  request.user = user;
};

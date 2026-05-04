import { FastifyReply, FastifyRequest } from "fastify";

/**
 * Bloqueia colaboradores (usuários com parentUserId) em rotas restritas.
 * Aplicado nas rotas de connect/disconnect de marketplace — colaboradores
 * só podem operar contas já conectadas pelo admin pai, nunca criar/remover.
 *
 * Pré-requisito: authMiddleware deve rodar antes (popula request.user).
 * Para admins puros (parentUserId === null/undefined), passa direto.
 */
export const blockCollaborator = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = (request as any).user;
  if (user?.parentUserId) {
    return reply.status(403).send({
      message:
        "Colaboradores não podem realizar esta ação. Solicite ao administrador da conta.",
      code: "COLLABORATOR_FORBIDDEN",
    });
  }
};

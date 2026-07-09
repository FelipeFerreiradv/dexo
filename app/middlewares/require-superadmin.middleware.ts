import { FastifyReply, FastifyRequest } from "fastify";

/**
 * Restringe a rota à equipe Dexo (Superadmin). Espelha o estilo de
 * `blockCollaborator`, mas gateia por ROLE (não por parentUserId): só passa
 * quem tem `role === 'SUPERADMIN'`. Qualquer outro (ADMIN/USER) recebe 403.
 *
 * Pré-requisito: authMiddleware deve rodar antes (popula request.user com role
 * a partir do token/DB, em ambos os modos de auth Bearer e legacy-email).
 */
export const requireSuperadmin = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = (request as any).user;
  if (user?.role !== "SUPERADMIN") {
    return reply.status(403).send({
      message: "Acesso restrito à equipe Dexo (Superadmin).",
      code: "SUPERADMIN_ONLY",
    });
  }
};

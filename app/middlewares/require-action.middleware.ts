import { FastifyReply, FastifyRequest } from "fastify";
import { hasActionAccess, type ActionId } from "../lib/action-access";

/**
 * Bloqueia na API o colaborador sem permissão para uma AÇÃO.
 *
 * Espelha `requirePageAccess` (mesmo formato de 403 com `code`), porque
 * esconder botão não é permissão: sem isto, um `curl` direto em
 * `POST /finance/receivables/:id/reverse` devolveria o estoque e cancelaria a
 * venda de qualquer jeito.
 *
 * Pré-requisito: `authMiddleware` roda antes e popula `request.user` — que já
 * inclui `pagePermissions`, então o caminho padrão não custa query nenhuma.
 *
 * ZERO REGRESSÃO: o default é permitir. Admin/superadmin e colaborador sem a
 * chave `action:<id>` gravada passam direto — exatamente como hoje, quando não
 * existe verificação alguma. Só quem o administrador desligar explicitamente
 * recebe 403.
 */
export const requireAction =
  (actionId: ActionId) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    // Sem usuário o authMiddleware já respondeu 401; não é papel deste hook.
    if (!user) return;
    // Admin/superadmin: nada a verificar, sem I/O.
    if (!user.parentUserId) return;

    if (hasActionAccess(user, actionId)) return;

    return reply.status(403).send({
      message:
        "Você não tem permissão para esta ação. Solicite ao administrador da conta.",
      code: "ACTION_FORBIDDEN",
      actionId,
    });
  };

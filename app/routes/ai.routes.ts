import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authMiddleware } from "../middlewares/auth.middleware";
import { isAiEnabledFor } from "../ai/entitlement/ai-entitlement.service";

/**
 * Rotas do módulo Bitz (agente de IA).
 *
 * Módulo 100% aditivo atrás de DOIS gates: flag global
 * NEXT_PUBLIC_AI_MODULE_ENABLED (kill-switch de deploy) + entitlement por
 * tenant (User.aiEnabledAt — plano pago superior). Sem os dois, TODAS as rotas
 * autenticadas respondem 403 e não tocam em nada — exceto GET /ai/entitlement,
 * que é a sonda de visibilidade da UI (ver comentário abaixo).
 *
 * Isolamento: este plugin NÃO importa nada de produto/pedido/financeiro/
 * marketplace. A seta de dependência aponta sempre do Bitz para o sistema,
 * nunca o contrário.
 */
export const aiRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /ai/entitlement
   *
   * Sonda de visibilidade da UI (decide se o mascote é montado). NÃO retorna
   * 403 — "não contratado" é um estado legítimo ({ enabled: false }), mesma
   * decisão de GET /whatsapp/status (whatsapp.routes.ts:43-57).
   *
   * Contrato mínimo de propósito: só cresce, nunca encolhe. Nada de config do
   * provedor aqui — o cliente não precisa saber qual modelo roda por trás.
   */
  fastify.get(
    "/entitlement",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const dataOwnerId = request.user?.dataOwnerId;
      if (!dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const enabled = await isAiEnabledFor(dataOwnerId);
      return reply.send({ enabled });
    },
  );
};

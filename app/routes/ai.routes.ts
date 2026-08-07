import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authMiddleware } from "../middlewares/auth.middleware";
import { isAiEnabledFor } from "../ai/entitlement/ai-entitlement.service";
import { requireAiEnabled } from "../ai/entitlement/require-ai-enabled";
import { MAX_USER_MESSAGE_CHARS, runTurn } from "../ai/agent/orchestrator";
import { scopeFromRequest } from "../ai/core/scope";
import prisma from "../lib/prisma";

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
 *
 * ESCOPO: `dataOwnerId` e `actorUserId` saem SEMPRE de `request.user`, que o
 * authMiddleware montou a partir da sessão. Nunca do corpo, nunca da query,
 * nunca de algo que o modelo possa produzir.
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

  /**
   * POST /ai/chat
   *
   * Um turno de conversa. NUNCA responde 5xx por causa de IA: provedor fora do
   * ar, timeout ou teto de cota viram 200 com `degraded: true` e uma mensagem
   * legível — o front mostra no chat e o resto do ERP não sente nada.
   *
   * bodyLimit explícito: o Fastify default é 1 MB e não há override global
   * neste projeto. 64 KB é folgado para uma pergunta de chat.
   *
   * Rate limit PRÓPRIO, com store filho: `config.rateLimit` faz o
   * @fastify/rate-limit criar um bucket separado para esta rota
   * (node_modules/@fastify/rate-limit/index.js:141-157), então o teto global de
   * 300/min das outras rotas continua byte-idêntico. `hook: "preHandler"` é
   * obrigatório — o default `onRequest` roda ANTES do authMiddleware, quando
   * `request.user` ainda não existe e o keyGenerator cairia sempre no IP.
   */
  fastify.post(
    "/chat",
    {
      bodyLimit: 64 * 1024,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (req: any) => req.user?.id ?? req.ip,
        },
      },
      preHandler: [authMiddleware, requireAiEnabled],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }

      const body = (request.body ?? {}) as {
        message?: unknown;
        conversationId?: unknown;
      };

      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return reply
          .status(400)
          .send({ error: "Campo 'message' é obrigatório" });
      }
      if (message.length > MAX_USER_MESSAGE_CHARS) {
        return reply.status(400).send({
          error: `Mensagem muito longa (máximo ${MAX_USER_MESSAGE_CHARS} caracteres)`,
        });
      }

      const conversationId =
        typeof body.conversationId === "string" && body.conversationId
          ? body.conversationId
          : undefined;

      try {
        const result = await runTurn({
          dataOwnerId: user.dataOwnerId,
          actorUserId: user.id,
          message,
          conversationId,
          // ⭐ O escopo das consultas sai DAQUI e de nenhum outro lugar: tenant
          // e permissões vêm da sessão já autenticada. `scopeFromRequest` é a
          // única fábrica que existe (ai/core/scope.ts), e sem ela o turno roda
          // sem tool nenhuma em vez de rodar com um tenant adivinhado.
          scope: scopeFromRequest(request) ?? undefined,
        });

        return reply.send({
          conversationId: result.conversationId,
          message: { content: result.content, sources: result.sources },
          degraded: result.degraded,
          usage: result.usage,
        });
      } catch (error) {
        // runTurn não deveria lançar. Se lançar, o erro morre AQUI: o chat
        // reporta indisponibilidade e nenhum alerta de infra é disparado.
        request.log.warn(
          { err: error },
          "[bitz] turno falhou de forma inesperada",
        );
        return reply.send({
          conversationId: conversationId ?? null,
          message: {
            content:
              "Não consegui responder agora. Tenta de novo em instantes.",
            sources: [],
          },
          degraded: true,
          usage: { inputTokens: null, outputTokens: null },
        });
      }
    },
  );

  /**
   * GET /ai/conversations
   * Histórico do ATOR (não do tenant): a conversa de um colaborador não
   * aparece para o outro, nem para o admin.
   */
  fastify.get(
    "/conversations",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }

      const conversations = await prisma.aiConversation.findMany({
        where: { actorUserId: user.id, dataOwnerId: user.dataOwnerId },
        orderBy: { updatedAt: "desc" },
        take: 30,
        select: { id: true, title: true, updatedAt: true },
      });

      return reply.send({ conversations });
    },
  );

  /**
   * GET /ai/conversations/:id
   * 404 quando a conversa não é do ator — nunca 403, para não confirmar a
   * existência de um id que pertence a outra pessoa.
   */
  fastify.get(
    "/conversations/:id",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };

      const conversation = await prisma.aiConversation.findFirst({
        where: {
          id,
          actorUserId: user.id,
          dataOwnerId: user.dataOwnerId,
        },
        select: { id: true, title: true, createdAt: true, updatedAt: true },
      });
      if (!conversation) {
        return reply.status(404).send({ error: "Conversa não encontrada" });
      }

      const messages = await prisma.aiMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
        take: 200,
        // Projeção enxuta: tokens/latência/provedor são telemetria interna e
        // não têm por que trafegar para o browser.
        select: {
          id: true,
          role: true,
          content: true,
          sources: true,
          errorCode: true,
          createdAt: true,
        },
      });

      return reply.send({ conversation, messages });
    },
  );

  /** DELETE /ai/conversations/:id — as mensagens caem por cascade. */
  fastify.delete(
    "/conversations/:id",
    { preHandler: [authMiddleware, requireAiEnabled] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.dataOwnerId) {
        return reply.status(401).send({ error: "Não autenticado" });
      }
      const { id } = request.params as { id: string };

      // deleteMany COM o escopo (e não delete por id) para o id de outra
      // pessoa não apagar nada — mesmo padrão de idor-isolation.spec.ts.
      const { count } = await prisma.aiConversation.deleteMany({
        where: { id, actorUserId: user.id, dataOwnerId: user.dataOwnerId },
      });
      if (count === 0) {
        return reply.status(404).send({ error: "Conversa não encontrada" });
      }

      return reply.status(204).send();
    },
  );
};

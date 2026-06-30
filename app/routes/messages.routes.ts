import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Platform } from "@prisma/client";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { MarketplaceRepository } from "../marketplaces/repositories/marketplace.repository";
import { QuestionRepository } from "../marketplaces/repositories/question.repository";
import { MessagesUseCase } from "../marketplaces/usecases/messages.usecase";

// Plataformas válidas para o filtro de conversas (string da query → enum).
const PLATFORM_BY_KEY: Record<string, Platform> = {
  MERCADO_LIVRE: Platform.MERCADO_LIVRE,
  SHOPEE: Platform.SHOPEE,
  MAGALU: Platform.MAGALU,
};

/**
 * Rotas de Mensagens (perguntas pré-venda do Mercado Livre).
 * Todas autenticadas via header `email` (padrão atual do projeto).
 *
 * Isolamento: este plugin NÃO importa nada de listing/order. Apenas:
 *   - MarketplaceRepository (leitura de contas)
 *   - QuestionRepository (CRUD local de mensagens)
 *   - MessagesUseCase (orquestração + chamadas ML API)
 */
export const messagesRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /messages/accounts
   * Lista contas do usuário com perguntas/conversas (para o seletor da UI).
   * Mercado Livre + Shopee (Q&A) + Magalu (chat). `platform` permite à UI
   * badgear e despachar o envio (resposta de pergunta vs mensagem de conversa).
   */
  fastify.get(
    "/accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const [mlAccounts, shopeeAccounts, magaluAccounts] = await Promise.all([
        MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        ),
        MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        ),
        MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.MAGALU,
        ),
      ]);

      return reply.send({
        accounts: [...mlAccounts, ...shopeeAccounts, ...magaluAccounts].map(
          (a) => ({
            id: a.id,
            accountName: a.accountName,
            status: a.status,
            platform: a.platform,
          }),
        ),
      });
    },
  );

  /**
   * GET /messages/conversations?accountId&status&search&limit&offset
   */
  fastify.get(
    "/conversations",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const q = (request.query || {}) as Record<string, string | undefined>;
      const accountId = q.accountId;
      // accountId ausente ou "all" => todas as contas do usuário.
      // Sentinela explícito "all" além de ausência por robustez.
      const isAllAccounts = !accountId || accountId === "all";

      // Conta específica: valida ownership como antes (comportamento legado
      // idêntico). Modo "todas": o isolamento é garantido na query via
      // marketplaceAccount.userId, não há accountId para validar.
      if (!isAllAccounts) {
        const account = await MarketplaceRepository.findByIdAndUser(
          accountId as string,
          userId,
        );
        if (!account) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
      }

      const status = (q.status as any) ?? "all";
      const allowedStatus = ["all", "unanswered", "answered", "unread"];
      if (!allowedStatus.includes(status)) {
        return reply.status(400).send({ error: "status inválido" });
      }

      // Filtro de plataforma (opcional). "all"/ausente = todas. Inválido = 400.
      const platformParam = q.platform;
      if (
        platformParam &&
        platformParam !== "all" &&
        !PLATFORM_BY_KEY[platformParam]
      ) {
        return reply.status(400).send({ error: "platform inválido" });
      }
      const platform =
        platformParam && platformParam !== "all"
          ? PLATFORM_BY_KEY[platformParam]
          : undefined;

      const limit = Number(q.limit) || 30;
      const offset = Number(q.offset) || 0;

      const result = await QuestionRepository.listConversations({
        userId,
        marketplaceAccountId: isAllAccounts ? undefined : accountId,
        platform,
        status,
        search: q.search ?? "",
        limit,
        offset,
      });

      return reply.send(result);
    },
  );

  /**
   * GET /messages/conversations/:itemId?accountId
   */
  fastify.get<{ Params: { itemId: string } }>(
    "/conversations/:itemId",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const { itemId } = request.params;
      const accountId = (request.query as any)?.accountId as string | undefined;
      if (!accountId) {
        return reply.status(400).send({ error: "accountId é obrigatório" });
      }

      const account = await MarketplaceRepository.findByIdAndUser(accountId, userId);
      if (!account) {
        return reply.status(404).send({ error: "Conta não encontrada" });
      }

      const data = await QuestionRepository.listMessages(accountId, itemId);
      return reply.send(data);
    },
  );

  /**
   * POST /messages/conversations/:itemId/read?accountId
   */
  fastify.post<{ Params: { itemId: string } }>(
    "/conversations/:itemId/read",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const { itemId } = request.params;
      const accountId = (request.query as any)?.accountId as string | undefined;
      if (!accountId) {
        return reply.status(400).send({ error: "accountId é obrigatório" });
      }
      const account = await MarketplaceRepository.findByIdAndUser(accountId, userId);
      if (!account) {
        return reply.status(404).send({ error: "Conta não encontrada" });
      }

      const updated = await QuestionRepository.markConversationRead(accountId, itemId);
      return reply.send({ updated });
    },
  );

  /**
   * POST /messages/conversations/:itemId/sync?accountId
   * Pull on-demand: ressincroniza todas as perguntas do anúncio.
   */
  fastify.post<{ Params: { itemId: string } }>(
    "/conversations/:itemId/sync",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const { itemId } = request.params;
      const accountId = (request.query as any)?.accountId as string | undefined;
      if (!accountId) {
        return reply.status(400).send({ error: "accountId é obrigatório" });
      }

      try {
        const result = await MessagesUseCase.pullConversation(
          userId,
          accountId,
          itemId,
        );
        return reply.send(result);
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        return reply.status(status).send({
          error: err?.message ?? "Erro ao sincronizar conversa",
        });
      }
    },
  );

  /**
   * POST /messages/answers
   * body: { accountId, text, questionId?, itemId? }
   *
   * Despacha por plataforma da conta:
   *   - Mercado Livre (Q&A): responde a pergunta `questionId`.
   *   - Magalu (chat): envia uma mensagem na conversa `itemId`.
   */
  fastify.post(
    "/answers",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const body = (request.body || {}) as {
        accountId?: string;
        questionId?: string;
        itemId?: string;
        text?: string;
      };

      if (!body.accountId || !body.text) {
        return reply
          .status(400)
          .send({ error: "accountId e text são obrigatórios" });
      }

      const account = await MarketplaceRepository.findByIdAndUser(
        body.accountId,
        userId,
      );
      if (!account) {
        return reply.status(404).send({ error: "Conta não encontrada" });
      }

      try {
        if (account.platform === Platform.MAGALU) {
          if (!body.itemId) {
            return reply
              .status(400)
              .send({ error: "itemId é obrigatório para conversas Magalu" });
          }
          const result = await MessagesUseCase.sendMagaluMessage(
            userId,
            body.accountId,
            body.itemId,
            body.text,
          );
          return reply.send(result);
        }

        if (!body.questionId) {
          return reply
            .status(400)
            .send({ error: "questionId é obrigatório" });
        }
        const updated = await MessagesUseCase.answerQuestion(
          userId,
          body.accountId,
          body.questionId,
          body.text,
        );
        return reply.send({ question: updated });
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        return reply.status(status).send({
          error: err?.message ?? "Erro ao enviar resposta",
        });
      }
    },
  );

  /**
   * GET /messages/unread-count
   * Total de perguntas não lidas em todas as contas do usuário.
   */
  fastify.get(
    "/unread-count",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });

      const count = await QuestionRepository.countUnreadForUser(userId);
      return reply.send({ count });
    },
  );

  // healthcheck simples (não exige auth) — usado pelo /ready agregado
  fastify.get("/_ping", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });
};

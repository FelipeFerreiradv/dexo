import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Platform } from "@prisma/client";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { MarketplaceRepository } from "../marketplaces/repositories/marketplace.repository";
import { QuestionRepository } from "../marketplaces/repositories/question.repository";
import { MessagesUseCase } from "../marketplaces/usecases/messages.usecase";
// Canal WhatsApp (aditivo, atrás de flag global + gate por usuário/plano).
// Os branches "wa:"/WHATSAPP abaixo curto-circuitam ANTES da lógica de
// marketplace e NUNCA rodam com o módulo desabilitado (app idêntico ao legado).
import { WhatsAppRepository } from "../marketplaces/repositories/whatsapp.repository";
import { WhatsAppApiService } from "../marketplaces/services/whatsapp-api.service";
import {
  WhatsAppInboxRepository,
  fromPrefixedAccountId,
  toPrefixedAccountId,
} from "../marketplaces/repositories/whatsapp-inbox.repository";
import { WhatsAppMessagesUseCase } from "../marketplaces/usecases/whatsapp-messages.usecase";
import { isWhatsappEnabledFor } from "../marketplaces/whatsapp/whatsapp-entitlement.service";
import { isWhatsappModuleEnabled } from "../marketplaces/whatsapp/whatsapp-constants";

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

      const accounts: {
        id: string;
        accountName: string;
        status: string;
        platform: string;
      }[] = [...mlAccounts, ...shopeeAccounts, ...magaluAccounts].map((a) => ({
        id: a.id,
        accountName: a.accountName,
        status: a.status as string,
        platform: a.platform as string,
      }));

      // Canal WhatsApp (aditivo): números conectados entram no MESMO seletor
      // com id prefixado "wa:" (o prefixo roteia read/answers de volta para os
      // branches WhatsApp). O campo `whatsappEnabled` (só com a flag global
      // ligada — resposta byte-idêntica com flag off) informa a UI se o tenant
      // tem o módulo no plano.
      if (isWhatsappModuleEnabled()) {
        const waEnabled = await isWhatsappEnabledFor(userId);
        if (waEnabled) {
          const waAccounts = await WhatsAppRepository.findActiveByUserId(userId);
          accounts.push(
            ...waAccounts.map((a) => ({
              id: toPrefixedAccountId(a.id),
              accountName: a.displayPhoneNumber,
              status: a.status as string,
              platform: "WHATSAPP",
            })),
          );
        }
        return reply.send({ accounts, whatsappEnabled: waEnabled });
      }

      return reply.send({ accounts });
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

      // ---- Canal WhatsApp (aditivo): accountId "wa:*", ou platform=WHATSAPP
      // com "todas as contas", roteiam para as tabelas do canal. O branch só é
      // ENTRADO quando o tenant tem o módulo habilitado — caso contrário o
      // request CAI no fluxo legado abaixo, que por construção produz a resposta
      // byte-idêntica de sempre ("wa:x" nunca é conta de marketplace ⇒ 404;
      // platform=WHATSAPP ⇒ 400 "platform inválido" na ordem legada, após
      // ownership/status). platform=WHATSAPP só entra em modo "todas as contas"
      // — com uma conta de marketplace selecionada, cai no legado e recebe 400
      // (em vez de ignorar o filtro de conta silenciosamente).
      const waAccountId = fromPrefixedAccountId(accountId);
      const wantsWhatsapp =
        Boolean(waAccountId) || (q.platform === "WHATSAPP" && isAllAccounts);
      if (wantsWhatsapp && (await isWhatsappEnabledFor(userId))) {
        const waStatus = (q.status as any) ?? "all";
        if (!["all", "unanswered", "answered", "unread"].includes(waStatus)) {
          return reply.status(400).send({ error: "status inválido" });
        }
        if (waAccountId) {
          const account = await WhatsAppRepository.findByIdAndUser(
            waAccountId,
            userId,
          );
          if (!account) {
            return reply.status(404).send({ error: "Conta não encontrada" });
          }
        }
        const result = await WhatsAppInboxRepository.listConversations({
          userId,
          whatsAppAccountId: waAccountId ?? undefined,
          status: waStatus,
          search: q.search ?? "",
          limit: Number(q.limit) || 30,
          offset: Number(q.offset) || 0,
        });
        return reply.send(result);
      }
      // ---- fim do branch WhatsApp; daqui p/ baixo, fluxo legado intocado.

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

      // ---- Merge aditivo WhatsApp em "Todas as plataformas": com o módulo
      // habilitado p/ o tenant, a lista unificada intercala marketplace +
      // WhatsApp por recência. Cada fonte busca o topo (offset 0) e o slice
      // aplica offset/limit no conjunto ordenado — correto para o uso real da
      // UI (limit 50, offset 0). Sem flag/plano, este bloco NUNCA roda.
      if (
        isAllAccounts &&
        !platform &&
        (await isWhatsappEnabledFor(userId))
      ) {
        const fetchCount = Math.min(limit + offset, 100);
        const [mkt, wa] = await Promise.all([
          QuestionRepository.listConversations({
            userId,
            marketplaceAccountId: undefined,
            platform: undefined,
            status,
            search: q.search ?? "",
            limit: fetchCount,
            offset: 0,
          }),
          WhatsAppInboxRepository.listConversations({
            userId,
            status,
            search: q.search ?? "",
            limit: fetchCount,
            offset: 0,
          }),
        ]);
        const items = [...mkt.items, ...wa.items]
          .sort(
            (a, b) =>
              new Date(b.lastQuestionAt).getTime() -
              new Date(a.lastQuestionAt).getTime(),
          )
          .slice(offset, offset + limit);
        return reply.send({ items, total: mkt.total + wa.total });
      }
      // ---- fim do merge; fluxo legado intocado.

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

      // Canal WhatsApp (aditivo): conta prefixada "wa:" ⇒ thread do canal, com
      // o MESMO shape de resposta (+ campo opcional `whatsapp` com a janela).
      const waAccountId = fromPrefixedAccountId(accountId);
      if (waAccountId) {
        if (!(await isWhatsappEnabledFor(userId))) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        const account = await WhatsAppRepository.findByIdAndUser(
          waAccountId,
          userId,
        );
        if (!account) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        const data = await WhatsAppInboxRepository.listMessages(
          waAccountId,
          itemId,
        );
        if (!data.conversation) {
          return reply.status(404).send({ error: "Conversa não encontrada" });
        }
        return reply.send({
          questions: data.messages,
          listing: null,
          whatsapp: {
            contactWaId: data.conversation.contactWaId,
            contactName: data.conversation.contactName,
            windowExpiresAt: data.conversation.serviceWindowExpiresAt,
          },
        });
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

      // Canal WhatsApp (aditivo): zera o contador local e propaga o "lida"
      // para o WhatsApp do cliente (best-effort — falha remota não afeta a UI).
      const waAccountId = fromPrefixedAccountId(accountId);
      if (waAccountId) {
        if (!(await isWhatsappEnabledFor(userId))) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        const account = await WhatsAppRepository.findWithSecretsByIdAndUser(
          waAccountId,
          userId,
        );
        if (!account) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        const { updated, lastInboundWaMessageId } =
          await WhatsAppInboxRepository.markConversationRead(
            waAccountId,
            itemId,
          );
        if (updated > 0 && lastInboundWaMessageId) {
          setImmediate(() => {
            WhatsAppApiService.markRead(
              account.accessToken,
              account.phoneNumberId,
              lastInboundWaMessageId,
            ).catch((err: unknown) => {
              console.warn(
                "[whatsapp] mark-read remoto falhou (ignorado):",
                err instanceof Error ? err.message : err,
              );
            });
          });
        }
        return reply.send({ updated });
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

      // WhatsApp não tem pull (histórico é 100% webhook): no-op de sucesso —
      // MAS só após validar entitlement E posse da conta, senão o request cai
      // no fluxo legado abaixo (que dá 404 "Conta não encontrada" para o id
      // "wa:*", byte-idêntico ao comportamento sem o módulo). A UI nem mostra o
      // botão de sync para o canal; isto é robustez + preservação de contrato.
      const waSyncAccountId = fromPrefixedAccountId(accountId);
      if (waSyncAccountId && (await isWhatsappEnabledFor(userId))) {
        const account = await WhatsAppRepository.findByIdAndUser(
          waSyncAccountId,
          userId,
        );
        if (account) {
          return reply.send({ synced: 0, total: 0 });
        }
        return reply.status(404).send({ error: "Conta não encontrada" });
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

      // Canal WhatsApp (aditivo): conta prefixada "wa:" ⇒ texto livre na
      // conversa, respeitando a janela de 24h (409 fechada). Curto-circuito
      // ANTES da validação de conta de marketplace (que não conhece "wa:").
      const waAccountId = fromPrefixedAccountId(body.accountId);
      if (waAccountId) {
        if (!(await isWhatsappEnabledFor(userId))) {
          return reply.status(404).send({ error: "Conta não encontrada" });
        }
        if (!body.itemId) {
          return reply
            .status(400)
            .send({ error: "itemId é obrigatório para conversas WhatsApp" });
        }
        try {
          const result = await WhatsAppMessagesUseCase.sendText(
            userId,
            waAccountId,
            body.itemId,
            body.text,
          );
          return reply.send(result);
        } catch (err: any) {
          const status = err?.statusCode ?? 500;
          return reply.status(status).send({
            error: err?.message ?? "Erro ao enviar mensagem",
          });
        }
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

      let count = await QuestionRepository.countUnreadForUser(userId);
      // Canal WhatsApp (aditivo): soma as não-lidas do canal no MESMO shape
      // {count}. Sem flag/plano, o bloco não roda (badge idêntico ao legado).
      if (await isWhatsappEnabledFor(userId)) {
        count += await WhatsAppInboxRepository.countUnreadForUser(userId);
      }
      return reply.send({ count });
    },
  );

  // healthcheck simples (não exige auth) — usado pelo /ready agregado
  fastify.get("/_ping", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });
};

import prisma from "@/app/lib/prisma";
import type { Prisma, Platform } from "@prisma/client";
import { MLQuestion } from "../types/ml-questions.types";

export interface ConversationSummary {
  externalItemId: string;
  // Conta de origem desta conversa. Necessário para que read/sync/answer
  // funcionem quando o filtro está em "Todas as contas" (a conversa pode
  // pertencer a qualquer conta do usuário, não à selecionada no filtro).
  marketplaceAccountId: string;
  accountName: string | null;
  accountPlatform: string | null;
  productListingId: string | null;
  listingTitle: string | null;
  listingThumbnail: string | null;
  listingPermalink: string | null;
  productSku: string | null;
  buyerNickname: string | null;
  lastQuestionText: string;
  lastQuestionAt: Date;
  lastAnswerText: string | null;
  lastAnswerAt: Date | null;
  unreadCount: number;
  hasUnanswered: boolean;
}

export interface ConversationListParams {
  // userId sempre presente: escopo de autorização quando
  // marketplaceAccountId é ausente (modo "Todas as contas").
  userId: string;
  // Ausente/undefined = todas as contas do userId. Presente = conta
  // específica (comportamento idêntico ao legado).
  marketplaceAccountId?: string;
  // Filtro por plataforma (MERCADO_LIVRE | SHOPEE | MAGALU). Ausente = todas.
  // Combina (AND) com o escopo de conta/usuário.
  platform?: Platform;
  search?: string;
  status?: "all" | "unanswered" | "answered" | "unread";
  limit?: number;
  offset?: number;
}

/**
 * Estados de pergunta (ML/Shopee) sem ação pendente do vendedor e IRREVERSÍVEIS.
 *
 * `UNDER_REVIEW` fica de fora de propósito: o ML pode devolvê-la para
 * `UNANSWERED`, e como o ramo `update` dos upserts nunca reabre `readAt`,
 * marcá-la como lida no nascimento engoliria a pergunta em silêncio.
 */
const ESTADOS_SEM_ACAO_PENDENTE = new Set([
  "ANSWERED",
  "CLOSED_UNANSWERED",
  "BANNED",
  "DELETED",
]);

/**
 * Estados terminais: a pergunta NUNCA poderá ser respondida. Ficam fora das
 * contagens de não lidas — em produção eram 121 linhas impossíveis de zerar
 * pela via normal (o filtro "Sem resposta" usa `status = UNANSWERED` e nem as
 * mostrava; só sumiam abrindo conversa por conversa).
 */
const STATUS_TERMINAIS = ["CLOSED_UNANSWERED", "BANNED", "DELETED"];

/**
 * Kill-switch da mudança de ESCOPO do contador.
 *
 * Ligado (`MESSAGES_UNREAD_SCOPE_LEGACY=1`) devolve a semântica anterior: conta
 * todas as contas do usuário — inclusive as em ERROR/INACTIVE, que ele não
 * consegue abrir — e inclui os estados terminais. Reverter é `.env` + restart
 * da API, sem deploy.
 *
 * Lido por chamada de propósito: assim o teste alterna o modo sem reimportar o
 * módulo.
 */
function escopoLegado(): boolean {
  return process.env.MESSAGES_UNREAD_SCOPE_LEGACY === "1";
}

/**
 * `readAt` inicial de uma pergunta no instante em que o Dexo a conhece pela
 * PRIMEIRA vez. Usado só no ramo `create` dos upserts — re-sync nunca chama
 * isto, preservando o que o usuário já leu.
 *
 * Por que existe: antes disto TODA pergunta nascia com `readAt` NULL, inclusive
 * as que chegavam já respondidas (histórico puxado pelo botão "atualizar",
 * comentário respondido pelo app da Shopee, webhook do ML de pergunta já
 * respondida). Em produção isso somava 4.173 de 7.551 não lidas (55%) com
 * resposta anexada — e fazia o contador voltar a subir em conversas que o
 * vendedor sabia ter respondido.
 *
 * Espelha a decisão já tomada e documentada para o chat da Magalu, onde a
 * mensagem do SELLER nasce lida (ver `upsertMagaluMessage`).
 */
export function initialReadAt(input: {
  status: string;
  dateCreated: Date;
  answeredAt?: Date | null;
}): Date | null {
  // A resposta é a prova de que foi tratada, qualquer que seja o status.
  // Data inválida cai no ramo seguinte em vez de gravar Invalid Date.
  if (input.answeredAt && !Number.isNaN(input.answeredAt.getTime())) {
    return input.answeredAt;
  }
  if (ESTADOS_SEM_ACAO_PENDENTE.has(input.status)) return input.dateCreated;
  return null;
}

/**
 * Camada de acesso a perguntas/respostas dos marketplaces.
 *
 * Princípios:
 *   - Todas as queries filtram por marketplaceAccountId — multi-tenant safe.
 *   - Resolução de productListingId é best-effort (FK opcional). Se a listing
 *     local não existir, a conversa ainda aparece na UI com fallback.
 */
export class QuestionRepository {
  /**
   * Resolve o productListing local correspondente ao item_id do ML.
   * Pública para permitir que callers que processam várias perguntas do mesmo
   * item (ex: pullConversation) resolvam UMA vez e reaproveitem.
   */
  static async resolveListingId(
    marketplaceAccountId: string,
    externalItemId: string,
  ): Promise<string | null> {
    const listing = await prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId: externalItemId,
        },
      },
      select: { id: true },
    });
    return listing?.id ?? null;
  }

  /**
   * Upsert idempotente de pergunta + (opcional) resposta vinda do ML.
   *
   * Otimizações:
   *   - `productListingId` opcional: se o caller já resolveu, evita 1 SELECT.
   *   - findUnique (isNew) + resolveListingId rodam em PARALELO quando precisa.
   */
  static async upsertFromMl(
    marketplaceAccountId: string,
    mlQuestion: MLQuestion,
    options: { productListingId?: string | null } = {},
  ): Promise<{ id: string; isNew: boolean }> {
    const externalQuestionId = String(mlQuestion.id);
    const needsListingLookup = options.productListingId === undefined;

    const [existing, resolvedListingId] = await Promise.all([
      prisma.marketplaceQuestion.findUnique({
        where: {
          marketplaceAccountId_externalQuestionId: {
            marketplaceAccountId,
            externalQuestionId,
          },
        },
        select: { id: true },
      }),
      needsListingLookup
        ? this.resolveListingId(marketplaceAccountId, mlQuestion.item_id)
        : Promise.resolve(options.productListingId ?? null),
    ]);

    const baseData = {
      marketplaceAccountId,
      externalQuestionId,
      externalItemId: mlQuestion.item_id,
      externalBuyerId: String(mlQuestion.from?.id ?? "0"),
      buyerNickname: mlQuestion.from?.nickname ?? null,
      text: mlQuestion.text,
      status: mlQuestion.status,
      dateCreated: new Date(mlQuestion.date_created),
      productListingId: resolvedListingId,
    };

    // Pergunta que chega ao Dexo JÁ respondida (ou em estado terminal) não pode
    // inflar o contador de não lidas — nasce lida. Só no `create`.
    const mlAnsweredAt =
      mlQuestion.answer && mlQuestion.answer.text
        ? new Date(mlQuestion.answer.date_created)
        : null;

    const upserted = await prisma.marketplaceQuestion.upsert({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      create: {
        ...baseData,
        lastSyncedAt: new Date(),
        readAt: initialReadAt({
          status: baseData.status,
          dateCreated: baseData.dateCreated,
          answeredAt: mlAnsweredAt,
        }),
      },
      update: {
        status: baseData.status,
        text: baseData.text,
        productListingId: baseData.productListingId,
        buyerNickname: baseData.buyerNickname,
        lastSyncedAt: new Date(),
      },
      select: { id: true },
    });

    if (mlQuestion.answer && mlQuestion.answer.text) {
      await this.attachAnswer(upserted.id, mlQuestion.answer);
    }

    return { id: upserted.id, isNew: !existing };
  }

  static async attachAnswer(
    questionId: string,
    answer: { text: string; status: string; date_created: string },
  ): Promise<void> {
    const data = {
      text: answer.text,
      status: answer.status,
      dateCreated: new Date(answer.date_created),
    };
    await prisma.$transaction([
      prisma.marketplaceAnswer.upsert({
        where: { questionId },
        create: { questionId, ...data },
        update: data,
      }),
      prisma.marketplaceQuestion.update({
        where: { id: questionId },
        data: { status: "ANSWERED" },
      }),
    ]);
  }

  /**
   * Upsert idempotente de um comentário/pergunta da Shopee (modelo Q&A 1:1,
   * igual ao ML — authorType fica NULL). Anexa a resposta quando há CommentReply.
   */
  static async upsertFromShopeeComment(
    marketplaceAccountId: string,
    comment: {
      comment_id: number | string;
      comment: string;
      buyer_username?: string;
      item_id: number | string;
      create_time: number;
      // Resposta do seller (snake_case da Shopee, normalizado em getComments).
      comment_reply?: { reply?: string; create_time?: number } | null;
    },
    options: { productListingId?: string | null } = {},
  ): Promise<{ id: string; isNew: boolean }> {
    const externalQuestionId = String(comment.comment_id);
    const externalItemId = String(comment.item_id);
    const needsListingLookup = options.productListingId === undefined;

    const [existing, resolvedListingId] = await Promise.all([
      prisma.marketplaceQuestion.findUnique({
        where: {
          marketplaceAccountId_externalQuestionId: {
            marketplaceAccountId,
            externalQuestionId,
          },
        },
        select: { id: true },
      }),
      needsListingLookup
        ? this.resolveListingId(marketplaceAccountId, externalItemId)
        : Promise.resolve(options.productListingId ?? null),
    ]);

    const hasReply = !!(comment.comment_reply && comment.comment_reply.reply);
    const baseData = {
      marketplaceAccountId,
      externalQuestionId,
      externalItemId,
      externalBuyerId: comment.buyer_username ?? "0",
      buyerNickname: comment.buyer_username ?? null,
      text: comment.comment,
      status: hasReply ? "ANSWERED" : "UNANSWERED",
      dateCreated: new Date(comment.create_time * 1000),
      productListingId: resolvedListingId,
    };

    // Comentário que já chega com a resposta do seller nasce lido — mesma regra
    // do ML e do Magalu. `create_time` da resposta pode faltar: cai no do
    // comentário (é o que o attachAnswer abaixo já fazia).
    const shopeeAnsweredAt = hasReply
      ? new Date(
          (comment.comment_reply!.create_time ?? comment.create_time) * 1000,
        )
      : null;

    const upserted = await prisma.marketplaceQuestion.upsert({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      create: {
        ...baseData,
        lastSyncedAt: new Date(),
        readAt: initialReadAt({
          status: baseData.status,
          dateCreated: baseData.dateCreated,
          answeredAt: shopeeAnsweredAt,
        }),
      },
      update: {
        status: baseData.status,
        text: baseData.text,
        productListingId: baseData.productListingId,
        buyerNickname: baseData.buyerNickname,
        lastSyncedAt: new Date(),
      },
      select: { id: true },
    });

    if (hasReply) {
      await this.attachAnswer(upserted.id, {
        text: comment.comment_reply!.reply!,
        status: "ACTIVE",
        date_created: shopeeAnsweredAt!.toISOString(),
      });
    }

    return { id: upserted.id, isNew: !existing };
  }

  // ===========================================================================
  // Magalu — Chat com Cliente (conversas com N mensagens).
  //
  // Modelo de dados: cada MENSAGEM do chat vira UMA linha de MarketplaceQuestion
  // (sem MarketplaceAnswer), com `authorType` (CUSTOMER | SELLER). O agrupamento
  // por conversa usa `externalItemId = conversation.id` (a mesma chave do Q&A do
  // ML/Shopee), então listConversations/listMessages funcionam SEM alteração.
  //
  // Estado "precisa de resposta" é por CONVERSA (não por mensagem): vale quando a
  // última mensagem foi do CUSTOMER. Para que os filtros (Sem resposta/Respondidas)
  // e o badge "Pendente" — todos baseados em `status` — continuem valendo sem
  // tratar Magalu como caso especial na leitura, mantemos um INVARIANTE: após
  // sincronizar uma conversa, TODAS as suas linhas recebem o mesmo `status`
  // (UNANSWERED quando pendente, ANSWERED quando respondida). Assim o status é
  // "nível-conversa" para o chat, enquanto continua "nível-pergunta" no Q&A.
  // ===========================================================================

  /**
   * Upsert idempotente de UMA mensagem de chat Magalu (sem answer). O `status`
   * inicial deriva do autor (CUSTOMER→UNANSWERED, SELLER→ANSWERED) e é depois
   * normalizado ao nível-conversa por `syncMagaluConversation`. Mensagens do
   * SELLER nascem já LIDAS (readAt) — não devem inflar o contador de não-lidas.
   */
  static async upsertMagaluMessage(
    marketplaceAccountId: string,
    msg: {
      conversationId: string;
      messageId: string;
      text: string;
      authorType: "CUSTOMER" | "SELLER";
      dateCreated: Date;
      customerExternalId: string | null;
      customerName: string | null;
    },
  ): Promise<{ id: string; isNew: boolean }> {
    const externalQuestionId = String(msg.messageId);
    const isSeller = msg.authorType === "SELLER";

    const existing = await prisma.marketplaceQuestion.findUnique({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      select: { id: true },
    });

    const baseData = {
      marketplaceAccountId,
      externalQuestionId,
      externalItemId: msg.conversationId,
      externalBuyerId: msg.customerExternalId ?? "0",
      buyerNickname: msg.customerName,
      text: msg.text,
      status: isSeller ? "ANSWERED" : "UNANSWERED",
      authorType: msg.authorType,
      dateCreated: msg.dateCreated,
      // Chat não tem listing local (externalItemId é o id da conversa, não MLB).
      productListingId: null,
    };

    const upserted = await prisma.marketplaceQuestion.upsert({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      create: {
        ...baseData,
        lastSyncedAt: new Date(),
        // SELLER já lido; CUSTOMER fica não-lido até o seller abrir a conversa.
        readAt: isSeller ? msg.dateCreated : null,
      },
      // re-sync NÃO mexe em readAt (preserva o que o usuário já leu) nem no
      // status individual (o status final é definido pelo rewrite da conversa).
      update: {
        text: baseData.text,
        buyerNickname: baseData.buyerNickname,
        authorType: baseData.authorType,
        lastSyncedAt: new Date(),
      },
      select: { id: true },
    });

    return { id: upserted.id, isNew: !existing };
  }

  /**
   * Sincroniza uma conversa Magalu inteira: upsert de cada mensagem + reescrita
   * do `status` de TODAS as linhas da conversa para o estado nível-conversa
   * (`pending` ⇒ UNANSWERED, senão ANSWERED). Mantém o invariante descrito acima.
   *
   * `pending` é decidido pelo caller (última mensagem = CUSTOMER). `messages`
   * pode ser a conversa inteira (pull on-demand) ou só a última (polling do cron).
   */
  static async syncMagaluConversation(
    marketplaceAccountId: string,
    conversation: {
      conversationId: string;
      customerExternalId: string | null;
      customerName: string | null;
      pending: boolean;
      messages: {
        messageId: string;
        text: string;
        authorType: "CUSTOMER" | "SELLER";
        dateCreated: Date;
      }[];
    },
  ): Promise<{ synced: number; created: number }> {
    // Upserts em paralelo por chunk (cada mensagem é uma linha independente,
    // sem lookup compartilhado) — acelera a hidratação do histórico sem saturar
    // o pool. Espelha a concorrência do pull do ML.
    const UPSERT_CONCURRENCY = 8;
    let created = 0;
    for (let i = 0; i < conversation.messages.length; i += UPSERT_CONCURRENCY) {
      const chunk = conversation.messages.slice(i, i + UPSERT_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((m) =>
          this.upsertMagaluMessage(marketplaceAccountId, {
            conversationId: conversation.conversationId,
            messageId: m.messageId,
            text: m.text,
            authorType: m.authorType,
            dateCreated: m.dateCreated,
            customerExternalId: conversation.customerExternalId,
            customerName: conversation.customerName,
          }),
        ),
      );
      created += results.filter((r) => r.isNew).length;
    }

    // Invariante nível-conversa: alinha o status de todas as linhas ao estado
    // atual (uma query), DEPOIS de todos os upserts. Não toca readAt nem authorType.
    await prisma.marketplaceQuestion.updateMany({
      where: {
        marketplaceAccountId,
        externalItemId: conversation.conversationId,
      },
      data: { status: conversation.pending ? "UNANSWERED" : "ANSWERED" },
    });

    return { synced: conversation.messages.length, created };
  }

  /**
   * Cliente (destinatário) de uma conversa de chat — usado para montar o `owner`
   * ao responder na Magalu. Lê da linha mais recente já sincronizada.
   */
  static async getConversationCustomer(
    marketplaceAccountId: string,
    externalItemId: string,
  ): Promise<{ externalBuyerId: string; buyerNickname: string | null } | null> {
    const row = await prisma.marketplaceQuestion.findFirst({
      where: { marketplaceAccountId, externalItemId },
      orderBy: { dateCreated: "desc" },
      select: { externalBuyerId: true, buyerNickname: true },
    });
    return row
      ? { externalBuyerId: row.externalBuyerId, buyerNickname: row.buyerNickname }
      : null;
  }

  /**
   * Lista conversas (uma por anúncio). Implementação: pega a pergunta mais
   * recente por externalItemId via DISTINCT ON (PostgreSQL), depois faz join
   * para enriquecer com dados do anúncio/produto.
   *
   * Paginação simples por cursor (lastQuestionAt + externalItemId).
   */
  static async listConversations(
    params: ConversationListParams,
  ): Promise<{ items: ConversationSummary[]; total: number }> {
    const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);
    const search = (params.search ?? "").trim();
    const status = params.status ?? "all";

    // Escopo de conta: específica (legado) OU todas as contas do usuário.
    // Quando marketplaceAccountId é ausente, filtra pela relação
    // marketplaceAccount.userId — isolamento multi-tenant garantido no banco
    // (mesmo padrão de countUnreadForUser). Reusado em ambas as fases da query.
    // O filtro de plataforma (opcional) entra na relação e combina (AND) com
    // o escopo — em "todas as contas" mantém o isolamento por userId.
    const legado = escopoLegado();
    const accountRelation: Prisma.MarketplaceAccountWhereInput = {};
    if (!params.marketplaceAccountId) accountRelation.userId = params.userId;
    if (params.platform) accountRelation.platform = params.platform;
    // Em "todas as contas", o agregado mostra só o que o usuário consegue
    // abrir — mesmo escopo do badge da sidebar. Com uma conta escolhida a dedo
    // o comportamento legado fica intacto, inclusive para contas em ERROR, que
    // precisam continuar diagnosticáveis.
    if (!params.marketplaceAccountId && !legado) {
      accountRelation.status = "ACTIVE";
    }
    const accountScope: Prisma.MarketplaceQuestionWhereInput = {
      ...(params.marketplaceAccountId
        ? { marketplaceAccountId: params.marketplaceAccountId }
        : {}),
      ...(Object.keys(accountRelation).length > 0
        ? { marketplaceAccount: accountRelation }
        : {}),
    };

    const where: Prisma.MarketplaceQuestionWhereInput = { ...accountScope };

    if (status === "unanswered") where.status = "UNANSWERED";
    if (status === "answered") where.status = "ANSWERED";
    if (status === "unread") {
      where.readAt = null;
      // Terminal não pede ação e não entra no badge: se aparecesse aqui, o
      // filtro "Não lidas" mostraria conversas que o contador não conta.
      if (!legado) where.status = { notIn: STATUS_TERMINAIS };
    }

    if (search) {
      where.OR = [
        { text: { contains: search, mode: "insensitive" } },
        { externalItemId: { contains: search, mode: "insensitive" } },
        { buyerNickname: { contains: search, mode: "insensitive" } },
      ];
    }

    // Fase 1 (paralelo): paginação por externalItemId + total de grupos.
    // Total via groupBy sem agregação — devolve só a chave de agrupamento.
    const [grouped, allGroups] = await Promise.all([
      prisma.marketplaceQuestion.groupBy({
        by: ["externalItemId"],
        where,
        _max: { dateCreated: true },
        orderBy: { _max: { dateCreated: "desc" } },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceQuestion.groupBy({
        by: ["externalItemId"],
        where,
      }),
    ]);

    const totalGroups = allGroups.length;
    const itemIds = grouped.map((g) => g.externalItemId);
    if (itemIds.length === 0) {
      return { items: [], total: totalGroups };
    }

    // Fase 2 (paralelo, 3 queries leves):
    //   a) latestPerItem: 1 row por item (a pergunta mais recente) com listing/produto
    //   b) unreadByItem:  groupBy filtrado por readAt IS NULL (counts)
    //   c) unansweredByItem: groupBy filtrado por status='UNANSWERED' (presença)
    //
    // Usa `distinct: ["externalItemId"]` + orderBy desc para pegar a primeira
    // (latest) por item — evita carregar TODAS as perguntas dos itens só para
    // calcular preview/counts (era O(N_questions); agora O(N_items)).
    const inSelected: Prisma.MarketplaceQuestionWhereInput = {
      ...accountScope,
      externalItemId: { in: itemIds },
    };

    const [latestPerItem, unreadCounts, unansweredCounts] = await Promise.all([
      prisma.marketplaceQuestion.findMany({
        where: inSelected,
        orderBy: { dateCreated: "desc" },
        distinct: ["externalItemId"],
        include: {
          answer: true,
          marketplaceAccount: {
            select: { id: true, accountName: true, platform: true },
          },
          productListing: {
            select: {
              id: true,
              permalink: true,
              titleOverride: true,
              product: { select: { name: true, sku: true, imageUrl: true } },
            },
          },
        },
      }),
      prisma.marketplaceQuestion.groupBy({
        by: ["externalItemId"],
        // Mesmo recorte do badge da sidebar: o número da LINHA e o da SIDEBAR
        // precisam contar o mesmo conjunto, senão um zera e o outro não.
        where: {
          ...inSelected,
          readAt: null,
          ...(legado ? {} : { status: { notIn: STATUS_TERMINAIS } }),
        },
        _count: { _all: true },
      }),
      prisma.marketplaceQuestion.groupBy({
        by: ["externalItemId"],
        where: { ...inSelected, status: "UNANSWERED" },
        _count: { _all: true },
      }),
    ]);

    const latestByItem = new Map(
      latestPerItem.map((q) => [q.externalItemId, q]),
    );
    const unreadByItem = new Map(
      unreadCounts.map((c) => [c.externalItemId, c._count._all]),
    );
    const unansweredByItem = new Set(
      unansweredCounts.map((c) => c.externalItemId),
    );

    const items: ConversationSummary[] = itemIds.map((itemId) => {
      const latest = latestByItem.get(itemId);
      const listing = latest?.productListing;
      return {
        externalItemId: itemId,
        marketplaceAccountId: latest?.marketplaceAccountId ?? "",
        accountName: latest?.marketplaceAccount?.accountName ?? null,
        accountPlatform: latest?.marketplaceAccount?.platform ?? null,
        productListingId: listing?.id ?? null,
        listingTitle: listing?.titleOverride ?? listing?.product?.name ?? null,
        listingThumbnail: listing?.product?.imageUrl ?? null,
        listingPermalink: listing?.permalink ?? null,
        productSku: listing?.product?.sku ?? null,
        buyerNickname: latest?.buyerNickname ?? null,
        lastQuestionText: latest?.text ?? "",
        lastQuestionAt: latest?.dateCreated ?? new Date(0),
        lastAnswerText: latest?.answer?.text ?? null,
        lastAnswerAt: latest?.answer?.dateCreated ?? null,
        unreadCount: unreadByItem.get(itemId) ?? 0,
        hasUnanswered: unansweredByItem.has(itemId),
      };
    });

    return { items, total: totalGroups };
  }

  /**
   * Mensagens (perguntas + respostas) de uma conversa, ordem cronológica.
   */
  static async listMessages(
    marketplaceAccountId: string,
    externalItemId: string,
  ) {
    const questions = await prisma.marketplaceQuestion.findMany({
      where: { marketplaceAccountId, externalItemId },
      orderBy: { dateCreated: "asc" },
      include: { answer: true },
    });

    const listing = await prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId: externalItemId,
        },
      },
      include: {
        product: { select: { name: true, sku: true, imageUrl: true } },
      },
    });

    return { questions, listing };
  }

  /**
   * Marca como lidas as perguntas ainda não lidas de uma conversa.
   *
   * `userId` (aditivo, opcional) alinha o escopo da MARCAÇÃO ao da AGREGAÇÃO:
   * `listConversations` agrupa por `externalItemId` dentro do usuário e soma o
   * `unreadCount` de TODAS as contas dele, enquanto a marcação cobria só uma.
   * Com o mesmo `externalItemId` em duas contas do usuário (8 pares em
   * produção), o clique zerava uma e a outra reaparecia no poll seguinte.
   *
   * O isolamento entre tenants segue garantido pelo filtro
   * `marketplaceAccount: { userId }` — existe 1 `externalItemId` compartilhado
   * entre usuários DIFERENTES, e ele nunca pode ser marcado junto.
   *
   * Sem `userId`, o comportamento é byte-idêntico ao legado.
   */
  static async markConversationRead(
    marketplaceAccountId: string,
    externalItemId: string,
    userId?: string,
  ): Promise<number> {
    const where: Prisma.MarketplaceQuestionWhereInput = userId
      ? { externalItemId, readAt: null, marketplaceAccount: { userId } }
      : { marketplaceAccountId, externalItemId, readAt: null };
    const result = await prisma.marketplaceQuestion.updateMany({
      where,
      data: { readAt: new Date() },
    });
    return result.count;
  }

  static async findById(id: string) {
    return prisma.marketplaceQuestion.findUnique({
      where: { id },
      include: { answer: true, marketplaceAccount: true },
    });
  }

  static async findByExternalId(
    marketplaceAccountId: string,
    externalQuestionId: string,
  ) {
    return prisma.marketplaceQuestion.findUnique({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      include: { answer: true },
    });
  }

  /**
   * Total de perguntas não-lidas (badge da sidebar).
   *
   * Conta só o que o usuário CONSEGUE zerar clicando: contas ativas e perguntas
   * que ainda admitem resposta. Antes, o badge somava contas em ERROR/INACTIVE
   * (792 linhas em produção) e estados terminais (121) — números que nenhuma
   * sequência de cliques derrubava, e que a cliente lia como "volta sozinho".
   *
   * Mesmo escopo do filtro "Não lidas" em modo "todas as contas", para que lista
   * e badge contem exatamente o mesmo conjunto.
   */
  static async countUnreadForUser(userId: string): Promise<number> {
    if (escopoLegado()) {
      return prisma.marketplaceQuestion.count({
        where: {
          readAt: null,
          marketplaceAccount: { userId },
        },
      });
    }
    return prisma.marketplaceQuestion.count({
      where: {
        readAt: null,
        status: { notIn: STATUS_TERMINAIS },
        marketplaceAccount: { userId, status: "ACTIVE" },
      },
    });
  }
}

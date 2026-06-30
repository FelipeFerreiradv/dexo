import prisma from "@/app/lib/prisma";
import type { Prisma } from "@prisma/client";
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
  search?: string;
  status?: "all" | "unanswered" | "answered" | "unread";
  limit?: number;
  offset?: number;
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

    const upserted = await prisma.marketplaceQuestion.upsert({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      create: { ...baseData, lastSyncedAt: new Date() },
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

    const upserted = await prisma.marketplaceQuestion.upsert({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      create: { ...baseData, lastSyncedAt: new Date() },
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
      const replyAt = comment.comment_reply!.create_time ?? comment.create_time;
      await this.attachAnswer(upserted.id, {
        text: comment.comment_reply!.reply!,
        status: "ACTIVE",
        date_created: new Date(replyAt * 1000).toISOString(),
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
    let created = 0;
    for (const m of conversation.messages) {
      const r = await this.upsertMagaluMessage(marketplaceAccountId, {
        conversationId: conversation.conversationId,
        messageId: m.messageId,
        text: m.text,
        authorType: m.authorType,
        dateCreated: m.dateCreated,
        customerExternalId: conversation.customerExternalId,
        customerName: conversation.customerName,
      });
      if (r.isNew) created += 1;
    }

    // Invariante nível-conversa: alinha o status de todas as linhas ao estado
    // atual (uma query). Não toca readAt nem authorType.
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
    const accountScope: Prisma.MarketplaceQuestionWhereInput =
      params.marketplaceAccountId
        ? { marketplaceAccountId: params.marketplaceAccountId }
        : { marketplaceAccount: { userId: params.userId } };

    const where: Prisma.MarketplaceQuestionWhereInput = { ...accountScope };

    if (status === "unanswered") where.status = "UNANSWERED";
    if (status === "answered") where.status = "ANSWERED";
    if (status === "unread") where.readAt = null;

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
        where: { ...inSelected, readAt: null },
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

  static async markConversationRead(
    marketplaceAccountId: string,
    externalItemId: string,
  ): Promise<number> {
    const result = await prisma.marketplaceQuestion.updateMany({
      where: { marketplaceAccountId, externalItemId, readAt: null },
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
   * Total de perguntas não-lidas (para o badge da sidebar).
   * Considera todas as contas do usuário.
   */
  static async countUnreadForUser(userId: string): Promise<number> {
    return prisma.marketplaceQuestion.count({
      where: {
        readAt: null,
        marketplaceAccount: { userId },
      },
    });
  }
}

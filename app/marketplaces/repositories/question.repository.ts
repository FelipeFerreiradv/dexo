import prisma from "@/app/lib/prisma";
import type { Prisma } from "@prisma/client";
import { MLQuestion } from "../types/ml-questions.types";

export interface ConversationSummary {
  externalItemId: string;
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
  marketplaceAccountId: string;
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

    const where: Prisma.MarketplaceQuestionWhereInput = {
      marketplaceAccountId: params.marketplaceAccountId,
    };

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
      marketplaceAccountId: params.marketplaceAccountId,
      externalItemId: { in: itemIds },
    };

    const [latestPerItem, unreadCounts, unansweredCounts] = await Promise.all([
      prisma.marketplaceQuestion.findMany({
        where: inSelected,
        orderBy: { dateCreated: "desc" },
        distinct: ["externalItemId"],
        include: {
          answer: true,
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

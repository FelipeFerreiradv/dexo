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
   * Upsert idempotente de pergunta + (opcional) resposta vinda do ML.
   * Resolve a productListingId pelo par (accountId, externalItemId).
   */
  static async upsertFromMl(
    marketplaceAccountId: string,
    mlQuestion: MLQuestion,
  ): Promise<{ id: string; isNew: boolean }> {
    const listing = await prisma.productListing.findUnique({
      where: {
        marketplaceAccountId_externalListingId: {
          marketplaceAccountId,
          externalListingId: mlQuestion.item_id,
        },
      },
      select: { id: true },
    });

    const externalQuestionId = String(mlQuestion.id);
    const dateCreated = new Date(mlQuestion.date_created);

    const baseData = {
      marketplaceAccountId,
      externalQuestionId,
      externalItemId: mlQuestion.item_id,
      externalBuyerId: String(mlQuestion.from?.id ?? "0"),
      buyerNickname: mlQuestion.from?.nickname ?? null,
      text: mlQuestion.text,
      status: mlQuestion.status,
      dateCreated,
      productListingId: listing?.id ?? null,
    };

    const existing = await prisma.marketplaceQuestion.findUnique({
      where: {
        marketplaceAccountId_externalQuestionId: {
          marketplaceAccountId,
          externalQuestionId,
        },
      },
      select: { id: true },
    });

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

    // Agrega por externalItemId pegando a data mais recente. Total = quantidade de
    // grupos (rodada separada para o counter — Prisma não devolve total no groupBy).
    const [grouped, totalGroups] = await Promise.all([
      prisma.marketplaceQuestion.groupBy({
        by: ["externalItemId"],
        where,
        _max: { dateCreated: true },
        orderBy: { _max: { dateCreated: "desc" } },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceQuestion
        .findMany({
          where,
          select: { externalItemId: true },
          distinct: ["externalItemId"],
        })
        .then((rows) => rows.length),
    ]);

    const itemIds = grouped.map((g) => g.externalItemId);
    if (itemIds.length === 0) {
      return { items: [], total: totalGroups };
    }

    // Pega TODAS as perguntas dos items selecionados para calcular last/unread.
    const allForItems = await prisma.marketplaceQuestion.findMany({
      where: {
        marketplaceAccountId: params.marketplaceAccountId,
        externalItemId: { in: itemIds },
      },
      orderBy: { dateCreated: "desc" },
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
    });

    const byItem = new Map<string, (typeof allForItems)[number][]>();
    for (const q of allForItems) {
      const arr = byItem.get(q.externalItemId) ?? [];
      arr.push(q);
      byItem.set(q.externalItemId, arr);
    }

    const items: ConversationSummary[] = itemIds.map((itemId) => {
      const all = byItem.get(itemId) ?? [];
      const latest = all[0];
      const unread = all.filter((q) => q.readAt === null).length;
      const hasUnanswered = all.some((q) => q.status === "UNANSWERED");
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
        unreadCount: unread,
        hasUnanswered,
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

import prisma from "@/app/lib/prisma";
import type { Prisma } from "@prisma/client";
import { WHATSAPP_CONSTANTS } from "../whatsapp/whatsapp-constants";
import type { ConversationSummary } from "./question.repository";

/**
 * Camada de acesso ao INBOX WhatsApp (conversas + mensagens).
 *
 * Leituras devolvem shapes compatíveis com a aba de Mensagens existente
 * (ConversationSummary / QuestionDto-like com authorType), para o canal
 * entrar na UI sem tocar nos branches de marketplace:
 *   - externalItemId        = WhatsAppConversation.id (cuid — identidade única
 *                             global, exigida pela lista/seleção da aba)
 *   - marketplaceAccountId  = "wa:" + WhatsAppAccount.id (o prefixo faz o
 *                             front despachar read/answers de volta para os
 *                             branches WhatsApp automaticamente)
 *   - accountPlatform       = "WHATSAPP" (canal só em DTO/UI; enum intocado)
 *
 * Escritas (webhook/envio) mantêm os derivados da conversa: lastMessage*,
 * unreadCount e a janela de 24h (serviceWindowExpiresAt).
 */

export const WHATSAPP_ACCOUNT_PREFIX = "wa:";

/** Prefixa o id da conta para os DTOs da aba de Mensagens. */
export function toPrefixedAccountId(accountId: string): string {
  return `${WHATSAPP_ACCOUNT_PREFIX}${accountId}`;
}

/** Remove o prefixo "wa:"; null se o valor não for um id prefixado. */
export function fromPrefixedAccountId(value: string | undefined | null): string | null {
  if (!value || !value.startsWith(WHATSAPP_ACCOUNT_PREFIX)) return null;
  const raw = value.slice(WHATSAPP_ACCOUNT_PREFIX.length);
  return raw.length > 0 ? raw : null;
}

/** Linha de mensagem no shape que o ChatPane já renderiza (authorType). */
export interface WhatsAppMessageDto {
  id: string;
  externalQuestionId: string; // wamid (compat com o QuestionDto do front)
  text: string;
  status: string; // inerte no modo chat (a UI não usa p/ chat)
  dateCreated: Date;
  buyerNickname: string | null;
  readAt: null;
  authorType: "CUSTOMER" | "SELLER";
  answer: null;
  // Campos ADITIVOS do canal WhatsApp (opcionais p/ os outros canais):
  deliveryStatus: string | null; // sent | delivered | read | failed | played
  errorCode: string | null;
  mediaType: string | null; // image | document | audio | video | sticker...
  mediaMimeType: string | null;
  mediaUrl: string | null; // rota autenticada relativa (/whatsapp/media/:id)
}

export interface WhatsAppConversationListParams {
  userId: string;
  whatsAppAccountId?: string; // ausente = todas as contas do tenant
  search?: string;
  status?: "all" | "unanswered" | "answered" | "unread";
  limit?: number;
  offset?: number;
}

const MESSAGE_TEXT_FALLBACK: Record<string, string> = {
  image: "📷 Imagem",
  video: "🎬 Vídeo",
  audio: "🎙️ Áudio",
  document: "📄 Documento",
  sticker: "🩵 Figurinha",
  unsupported: "[Mensagem não suportada]",
};

function previewFor(type: string, text: string | null): string {
  if (text && text.trim().length > 0) return text;
  return MESSAGE_TEXT_FALLBACK[type] ?? `[${type}]`;
}

// Ordem dos status de entrega — nunca rebaixar (webhooks chegam fora de ordem).
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
};

export class WhatsAppInboxRepository {
  // ---------------------------------------------------------------------------
  // ESCRITA (webhook + envio)
  // ---------------------------------------------------------------------------

  /**
   * Grava uma mensagem INBOUND (webhook) com upsert da conversa.
   * Idempotente pelo waMessageId (@unique): duplicata ⇒ {duplicated:true}.
   * INBOUND: unreadCount++, renova a janela de 24h e marca "pendente".
   */
  static async recordInboundMessage(params: {
    whatsAppAccountId: string;
    contactWaId: string;
    contactName?: string | null;
    waMessageId: string;
    type: string;
    text?: string | null;
    mediaId?: string | null;
    mediaMimeType?: string | null;
    timestamp: Date;
    raw?: unknown;
  }): Promise<{
    conversationId: string;
    messageId: string | null;
    duplicated: boolean;
  }> {
    const conversation = await prisma.whatsAppConversation.upsert({
      where: {
        whatsAppAccountId_contactWaId: {
          whatsAppAccountId: params.whatsAppAccountId,
          contactWaId: params.contactWaId,
        },
      },
      create: {
        whatsAppAccountId: params.whatsAppAccountId,
        contactWaId: params.contactWaId,
        contactName: params.contactName ?? null,
        lastMessageAt: params.timestamp,
        lastMessagePreview: previewFor(params.type, params.text ?? null),
        lastMessageDirection: "INBOUND",
        unreadCount: 0, // o incremento é feito junto com a mensagem (abaixo)
        serviceWindowExpiresAt: new Date(
          params.timestamp.getTime() + WHATSAPP_CONSTANTS.SERVICE_WINDOW_MS,
        ),
      },
      update: {},
    });

    let messageId: string | null = null;
    try {
      const message = await prisma.whatsAppMessage.create({
        data: {
          conversationId: conversation.id,
          waMessageId: params.waMessageId,
          direction: "INBOUND",
          type: params.type,
          text: params.text ?? null,
          mediaId: params.mediaId ?? null,
          mediaMimeType: params.mediaMimeType ?? null,
          timestamp: params.timestamp,
          raw: (params.raw as Prisma.InputJsonValue) ?? undefined,
        },
        select: { id: true },
      });
      messageId = message.id;
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Retry de webhook — mensagem já gravada; não mexe nos derivados.
        return { conversationId: conversation.id, messageId: null, duplicated: true };
      }
      throw err;
    }

    // Derivados da conversa. lastMessage*/janela só avançam no tempo (retries
    // fora de ordem não regridem); unreadCount conta TODA inbound nova.
    const isNewer = params.timestamp >= conversation.lastMessageAt;
    await prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        ...(params.contactName ? { contactName: params.contactName } : {}),
        ...(isNewer
          ? {
              lastMessageAt: params.timestamp,
              lastMessagePreview: previewFor(params.type, params.text ?? null),
              lastMessageDirection: "INBOUND",
              serviceWindowExpiresAt: new Date(
                params.timestamp.getTime() +
                  WHATSAPP_CONSTANTS.SERVICE_WINDOW_MS,
              ),
            }
          : {}),
      },
    });

    return { conversationId: conversation.id, messageId, duplicated: false };
  }

  /**
   * Grava uma mensagem OUTBOUND (resposta enviada pela UI). Não mexe em
   * unreadCount nem na janela (a janela é do CLIENTE → só inbound renova).
   */
  static async recordOutboundMessage(params: {
    conversationId: string;
    waMessageId: string;
    text: string;
    timestamp: Date;
  }): Promise<string> {
    const message = await prisma.whatsAppMessage.create({
      data: {
        conversationId: params.conversationId,
        waMessageId: params.waMessageId,
        direction: "OUTBOUND",
        type: "text",
        text: params.text,
        status: "sent",
        timestamp: params.timestamp,
      },
      select: { id: true },
    });
    await prisma.whatsAppConversation.update({
      where: { id: params.conversationId },
      data: {
        lastMessageAt: params.timestamp,
        lastMessagePreview: params.text,
        lastMessageDirection: "OUTBOUND",
      },
    });
    return message.id;
  }

  /**
   * Atualiza o status de entrega (webhook `statuses[]`). Nunca rebaixa
   * (sent→delivered→read chegam fora de ordem em retries); `failed` sempre
   * aplica e carrega o errorCode. Retorna false se o wamid é desconhecido.
   */
  static async updateMessageStatus(
    waMessageId: string,
    status: string,
    errorCode?: string | null,
  ): Promise<boolean> {
    const message = await prisma.whatsAppMessage.findUnique({
      where: { waMessageId },
      select: { id: true, status: true },
    });
    if (!message) return false;

    if (status !== "failed") {
      const current = STATUS_RANK[message.status ?? ""] ?? 0;
      const next = STATUS_RANK[status] ?? 0;
      if (next <= current) return true; // já está à frente — no-op
    }

    await prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        status,
        ...(status === "failed" && errorCode ? { errorCode } : {}),
      },
    });
    return true;
  }

  /** Persiste o caminho local da mídia baixada. */
  static async setMessageMediaPath(
    messageId: string,
    mediaPath: string,
  ): Promise<void> {
    await prisma.whatsAppMessage.update({
      where: { id: messageId },
      data: { mediaPath },
    });
  }

  // ---------------------------------------------------------------------------
  // LEITURA (aba de Mensagens)
  // ---------------------------------------------------------------------------

  /**
   * Conversas do tenant no shape ConversationSummary da aba de Mensagens.
   * Multi-tenant: sempre escopado por account.userId.
   */
  static async listConversations(
    params: WhatsAppConversationListParams,
  ): Promise<{ items: ConversationSummary[]; total: number }> {
    const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);

    const where: Prisma.WhatsAppConversationWhereInput = {
      account: {
        userId: params.userId,
        ...(params.whatsAppAccountId ? { id: params.whatsAppAccountId } : {}),
      },
    };
    if (params.status === "unread") {
      where.unreadCount = { gt: 0 };
    } else if (params.status === "unanswered") {
      where.lastMessageDirection = "INBOUND";
    } else if (params.status === "answered") {
      where.lastMessageDirection = "OUTBOUND";
    }
    const search = params.search?.trim();
    if (search) {
      where.OR = [
        { contactName: { contains: search, mode: "insensitive" } },
        { contactWaId: { contains: search, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.whatsAppConversation.findMany({
        where,
        include: {
          account: {
            select: {
              id: true,
              displayPhoneNumber: true,
              verifiedName: true,
            },
          },
        },
        orderBy: { lastMessageAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.whatsAppConversation.count({ where }),
    ]);

    const items: ConversationSummary[] = rows.map((c) => ({
      externalItemId: c.id,
      marketplaceAccountId: toPrefixedAccountId(c.account.id),
      accountName: c.account.displayPhoneNumber,
      accountPlatform: "WHATSAPP",
      productListingId: null,
      listingTitle: null,
      listingThumbnail: null,
      listingPermalink: null,
      productSku: null,
      buyerNickname: c.contactName ?? c.contactWaId,
      lastQuestionText: c.lastMessagePreview ?? "",
      lastQuestionAt: c.lastMessageAt,
      lastAnswerText: null,
      lastAnswerAt: null,
      unreadCount: c.unreadCount,
      hasUnanswered: c.lastMessageDirection === "INBOUND",
    }));

    return { items, total };
  }

  /**
   * Mensagens de uma conversa (ordem cronológica) no shape QuestionDto-like
   * que o ChatPane renderiza por authorType. Valida a posse da conversa pela
   * conta (o caller já validou a posse da conta pelo tenant).
   */
  static async listMessages(
    whatsAppAccountId: string,
    conversationId: string,
  ): Promise<{
    conversation: {
      id: string;
      contactWaId: string;
      contactName: string | null;
      serviceWindowExpiresAt: Date | null;
      unreadCount: number;
    } | null;
    messages: WhatsAppMessageDto[];
  }> {
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: { id: conversationId, whatsAppAccountId },
      select: {
        id: true,
        contactWaId: true,
        contactName: true,
        serviceWindowExpiresAt: true,
        unreadCount: true,
      },
    });
    if (!conversation) return { conversation: null, messages: [] };

    const rows = await prisma.whatsAppMessage.findMany({
      where: { conversationId },
      orderBy: { timestamp: "asc" },
    });

    const contactLabel =
      conversation.contactName ?? conversation.contactWaId;
    const messages: WhatsAppMessageDto[] = rows.map((m) => ({
      id: m.id,
      externalQuestionId: m.waMessageId,
      text: previewFor(m.type, m.text),
      status: "ANSWERED",
      dateCreated: m.timestamp,
      buyerNickname: contactLabel,
      readAt: null,
      authorType: m.direction === "OUTBOUND" ? "SELLER" : "CUSTOMER",
      answer: null,
      deliveryStatus: m.status,
      errorCode: m.errorCode,
      mediaType: m.type !== "text" && m.mediaId ? m.type : null,
      mediaMimeType: m.mediaMimeType,
      mediaUrl: m.mediaPath ? `/whatsapp/media/${m.id}` : null,
    }));

    return { conversation, messages };
  }

  /**
   * Zera o contador local de não-lidas. Retorna também o wamid da última
   * INBOUND para o mark-as-read remoto (best-effort, na camada acima).
   */
  static async markConversationRead(
    whatsAppAccountId: string,
    conversationId: string,
  ): Promise<{ updated: number; lastInboundWaMessageId: string | null }> {
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: { id: conversationId, whatsAppAccountId },
      select: { id: true, unreadCount: true },
    });
    if (!conversation) return { updated: 0, lastInboundWaMessageId: null };

    const lastInbound = await prisma.whatsAppMessage.findFirst({
      where: { conversationId, direction: "INBOUND" },
      orderBy: { timestamp: "desc" },
      select: { waMessageId: true },
    });

    const updated = conversation.unreadCount;
    if (updated > 0) {
      await prisma.whatsAppConversation.update({
        where: { id: conversation.id },
        data: { unreadCount: 0 },
      });
    }
    return {
      updated,
      lastInboundWaMessageId: lastInbound?.waMessageId ?? null,
    };
  }

  /** Soma de não-lidas do tenant (badge da sidebar / unread-count). */
  static async countUnreadForUser(userId: string): Promise<number> {
    const agg = await prisma.whatsAppConversation.aggregate({
      where: { account: { userId } },
      _sum: { unreadCount: true },
    });
    return agg._sum.unreadCount ?? 0;
  }

  /**
   * Mensagem de mídia p/ serving autenticado: valida a posse (tenant) via
   * conversa→conta→userId e devolve caminho+mime.
   */
  static async findMediaMessageForUser(
    messageId: string,
    userId: string,
  ): Promise<{ mediaPath: string; mediaMimeType: string | null } | null> {
    const message = await prisma.whatsAppMessage.findFirst({
      where: {
        id: messageId,
        mediaPath: { not: null },
        conversation: { account: { userId } },
      },
      select: { mediaPath: true, mediaMimeType: true },
    });
    if (!message?.mediaPath) return null;
    return {
      mediaPath: message.mediaPath,
      mediaMimeType: message.mediaMimeType,
    };
  }

  /** Conversa por id + conta (posse) — usado pelo envio (janela/destinatário). */
  static async findConversationForAccount(
    whatsAppAccountId: string,
    conversationId: string,
  ) {
    return prisma.whatsAppConversation.findFirst({
      where: { id: conversationId, whatsAppAccountId },
    });
  }
}

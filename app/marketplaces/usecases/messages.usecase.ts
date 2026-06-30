import { Platform } from "@prisma/client";
import type { MarketplaceAccount } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { QuestionRepository } from "../repositories/question.repository";
import { MlQuestionsApiService } from "../services/ml-questions-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import {
  MagaluChatApiService,
  MagaluChatMessage,
  MagaluChatUser,
  MagaluConversation,
} from "../services/magalu-chat-api.service";
import { MagaluOAuthService } from "../services/magalu-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MLQuestionWebhookPayload } from "../types/ml-questions.types";
import { SystemLogService } from "@/app/services/system-log.service";

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;

interface ResolvedAccount {
  account: MarketplaceAccount;
  accessToken: string;
}

/** Subconjunto necessário p/ refresh de token Magalu (aceita conta parcial). */
interface MagaluTokenAccount {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/** Idem para Shopee (precisa do shopId p/ assinar e refrescar). */
interface ShopeeTokenAccount {
  id: string;
  shopId: number | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/** Mensagem de chat já normalizada para o formato do repositório. */
interface NormalizedMagaluMessage {
  messageId: string;
  text: string;
  authorType: "CUSTOMER" | "SELLER";
  dateCreated: Date;
}

interface NormalizedMagaluConversation {
  customerExternalId: string | null;
  customerName: string | null;
  pending: boolean;
  messages: NormalizedMagaluMessage[];
}

/**
 * Resolve uma conta do usuário (qualquer plataforma suportada por Mensagens)
 * garantindo posse + accessToken válido (refresh por plataforma). Plataforma
 * ainda não suportada ⇒ null.
 */
async function resolveAccountForUser(
  userId: string,
  accountId: string,
): Promise<ResolvedAccount | null> {
  const account = await MarketplaceRepository.findByIdAndUser(accountId, userId);
  if (!account) return null;

  const accessToken = await ensureFreshTokenForAccount(account);
  if (!accessToken) return null;
  return { account, accessToken };
}

async function ensureFreshTokenForAccount(
  account: MarketplaceAccount,
): Promise<string | null> {
  if (account.platform === Platform.MERCADO_LIVRE) {
    return ensureFreshMlToken(account);
  }
  if (account.platform === Platform.MAGALU) {
    return ensureFreshMagaluToken(account);
  }
  if (account.platform === Platform.SHOPEE) {
    return ensureFreshShopeeToken(account);
  }
  return null;
}

/**
 * Token Shopee fresco. Não expirado ⇒ token atual; expirado com refresh ⇒
 * renova+persiste (precisa do shopId); falha ⇒ null.
 */
async function ensureFreshShopeeToken(
  account: ShopeeTokenAccount,
): Promise<string | null> {
  if (!account.accessToken || !account.shopId) return null;
  const expiresMs = account.expiresAt
    ? new Date(account.expiresAt).getTime()
    : 0;
  if (
    Number.isFinite(expiresMs) &&
    expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    return account.accessToken;
  }
  if (!account.refreshToken) return account.accessToken;
  try {
    const refreshed = await ShopeeOAuthService.refreshAccessToken(
      account.refreshToken,
      account.shopId,
    );
    await MarketplaceRepository.updateTokens(account.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
    });
    return refreshed.access_token;
  } catch (err) {
    console.warn(
      `[Messages] Falha ao refrescar token Shopee da conta ${account.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function ensureFreshMlToken(account: {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}): Promise<string> {
  const expiresMs = new Date(account.expiresAt).getTime();
  if (Number.isFinite(expiresMs) && expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS) {
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
  await MarketplaceRepository.updateTokens(account.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
  });
  return refreshed.accessToken;
}

/**
 * Token Magalu fresco (espelha listing.usercase.ensureFreshMagaluToken). Não
 * expirado ⇒ token atual; expirado com refresh ⇒ renova+persiste; falha ⇒ null.
 */
async function ensureFreshMagaluToken(
  account: MagaluTokenAccount,
): Promise<string | null> {
  if (!account.accessToken) return null;
  const expiresMs = account.expiresAt
    ? new Date(account.expiresAt).getTime()
    : 0;
  if (
    Number.isFinite(expiresMs) &&
    expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    return account.accessToken;
  }
  if (!account.refreshToken) return account.accessToken;
  try {
    const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
      account.id,
      account.refreshToken,
    );
    await MarketplaceRepository.updateTokens(account.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    });
    return refreshed.accessToken;
  } catch (err) {
    console.warn(
      `[Messages] Falha ao refrescar token Magalu da conta ${account.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** O cliente da conversa é o usuário com type CUSTOMER (fallback: from_user). */
function pickMagaluCustomer(
  fromUser?: MagaluChatUser,
  toUser?: MagaluChatUser,
): { externalId: string | null; name: string | null } {
  const customer =
    fromUser?.type === "CUSTOMER"
      ? fromUser
      : toUser?.type === "CUSTOMER"
        ? toUser
        : (fromUser ?? toUser);
  return {
    externalId: customer?.external_id ?? customer?.id ?? null,
    name: customer?.full_name ?? null,
  };
}

/** SELLER quando o autor da mensagem é o vendedor; senão CUSTOMER. */
function magaluAuthorType(user?: MagaluChatUser): "CUSTOMER" | "SELLER" {
  return user?.type === "SELLER" ? "SELLER" : "CUSTOMER";
}

/**
 * Data válida a partir do when_at. when_at ausente/ inválido (string não
 * parseável) ⇒ agora — evita Invalid Date (NaN no sort + erro de escrita no
 * Prisma, que exige DateTime válido).
 */
function parseMagaluDate(whenAt?: string): Date {
  if (!whenAt) return new Date();
  const d = new Date(whenAt);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Normaliza as mensagens de uma conversa Magalu para o repositório: ordena por
 * data, deriva o cliente (estável) e o estado `pending` (última msg = CUSTOMER).
 * Mensagens sem id são descartadas (não há chave de upsert).
 */
function normalizeMagaluConversationMessages(
  rawMessages: MagaluChatMessage[],
): NormalizedMagaluConversation {
  const messages: NormalizedMagaluMessage[] = [];
  let customerExternalId: string | null = null;
  let customerName: string | null = null;

  for (const m of rawMessages) {
    if (!m.id) continue;
    const cust = pickMagaluCustomer(m.from_user, m.to_user);
    if (!customerExternalId && cust.externalId) {
      customerExternalId = cust.externalId;
      customerName = cust.name;
    }
    messages.push({
      messageId: String(m.id),
      text: m.content ?? "",
      authorType: magaluAuthorType(m.from_user),
      dateCreated: parseMagaluDate(m.when_at),
    });
  }

  messages.sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());
  const last = messages[messages.length - 1];
  const pending = last ? last.authorType === "CUSTOMER" : false;

  return { customerExternalId, customerName, pending, messages };
}

/**
 * Tenta registrar o evento no WebhookEventLog para garantir idempotência.
 * Espelha a helper do webhook.usercase.ts (mantida local para evitar import
 * cruzado entre usecases).
 */
async function claimWebhookEvent(
  source: string,
  externalId: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await (prisma as any).webhookEventLog.create({
      data: { source, externalId, payload: payload as any },
    });
    return true;
  } catch (err: any) {
    if (err?.code === "P2002") return false;
    throw err;
  }
}

export class MessagesUseCase {
  /**
   * Processa um webhook ML topic=questions.
   * - Idempotência por (resource, user_id, sent).
   * - Busca a pergunta no ML, faz upsert local.
   */
  static async syncQuestionFromWebhook(
    payload: MLQuestionWebhookPayload,
  ): Promise<{
    success: boolean;
    questionId?: string;
    isNew?: boolean;
    accountId?: string;
    action?: string;
    error?: string;
  }> {
    try {
      const match = payload.resource.match(/^\/questions\/(\d+)$/);
      if (!match) {
        return { success: false, error: `Resource inválido: ${payload.resource}` };
      }
      const externalQuestionId = match[1];

      const dedupKey = `${payload.resource}:${payload.user_id}:${payload.sent}`;
      const isNew = await claimWebhookEvent("ML_QUESTION", dedupKey, payload);
      if (!isNew) {
        return { success: true, action: "duplicate_ignored" };
      }

      const accounts = await MarketplaceRepository.findAllByExternalUserId(
        String(payload.user_id),
        Platform.MERCADO_LIVRE,
        true,
      );

      if (accounts.length === 0) {
        void SystemLogService.logWarning(
          "WEBHOOK_ACCOUNT_NOT_FOUND",
          `Webhook ML question ignorado: conta não encontrada para user_id=${payload.user_id}`,
          {
            resource: "MarketplaceAccount",
            details: {
              externalUserId: String(payload.user_id),
              platform: "MERCADO_LIVRE",
              externalQuestionId,
            },
          },
        ).catch(() => {});
        return {
          success: false,
          error: `Conta ML não encontrada para user_id ${payload.user_id}`,
        };
      }

      // Caso múltiplas contas com mesmo external_user_id (raro): tenta cada
      // até obter a pergunta. Idempotência local impede duplicação.
      let lastError: string | undefined;
      for (const account of accounts) {
        try {
          const accessToken = await ensureFreshMlToken(account);
          const mlQuestion = await MlQuestionsApiService.getQuestion(
            accessToken,
            externalQuestionId,
          );
          const result = await QuestionRepository.upsertFromMl(
            account.id,
            mlQuestion,
          );
          return {
            success: true,
            questionId: result.id,
            isNew: result.isNew,
            accountId: account.id,
            action: result.isNew ? "created" : "updated",
          };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          // tenta a próxima conta
        }
      }

      return {
        success: false,
        error: lastError ?? "Falha ao sincronizar pergunta com qualquer conta",
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido no processamento do webhook de pergunta",
      };
    }
  }

  /**
   * Pull on-demand: ressincroniza todas as perguntas de um anúncio.
   * Usado pelo botão "atualizar" no chat.
   */
  static async pullConversation(
    userId: string,
    accountId: string,
    externalItemId: string,
  ): Promise<{ synced: number; total: number }> {
    const resolved = await resolveAccountForUser(userId, accountId);
    if (!resolved) {
      throw Object.assign(new Error("Conta não encontrada"), {
        statusCode: 404,
      });
    }
    const { account, accessToken } = resolved;

    if (account.platform === Platform.MAGALU) {
      return this.pullMagaluConversation(account, accessToken, externalItemId);
    }

    if (account.platform === Platform.SHOPEE) {
      return this.pullShopeeComments(account, accessToken, externalItemId);
    }

    // Mercado Livre (Q&A) — comportamento legado inalterado.
    // Resolve a productListingId UMA vez (todas as perguntas referenciam o mesmo
    // item) — evita N lookups idênticos em upsertFromMl.
    const productListingId = await QuestionRepository.resolveListingId(
      accountId,
      externalItemId,
    );

    // Concorrência limitada: upserts paralelos por chunk para acelerar sem
    // saturar o pool do Postgres (cada upsert custa até 4 roundtrips).
    const UPSERT_CONCURRENCY = 8;

    let offset = 0;
    let total = 0;
    let synced = 0;

    while (true) {
      const page = await MlQuestionsApiService.searchQuestionsByItem(
        accessToken,
        externalItemId,
        { offset, limit: 50 },
      );
      total = page.total;

      for (let i = 0; i < page.questions.length; i += UPSERT_CONCURRENCY) {
        const chunk = page.questions.slice(i, i + UPSERT_CONCURRENCY);
        await Promise.all(
          chunk.map((q) =>
            QuestionRepository.upsertFromMl(accountId, q, { productListingId }),
          ),
        );
        synced += chunk.length;
      }

      if (page.questions.length < 50) break;
      offset += 50;
      if (offset >= page.total) break;
    }

    return { synced, total };
  }

  /**
   * Pull on-demand de uma conversa Magalu: busca TODAS as mensagens da conversa
   * e re-sincroniza localmente (com o invariante de status nível-conversa).
   */
  private static async pullMagaluConversation(
    account: MarketplaceAccount,
    accessToken: string,
    conversationId: string,
  ): Promise<{ synced: number; total: number }> {
    // Pagina TODAS as mensagens (a API limita a 100/página) — conversas longas
    // não podem ser truncadas, senão o histórico, o `pending` e o cliente
    // derivam de um subconjunto. Teto de segurança p/ não rodar sem fim.
    const PAGE = 100;
    const MAX_PAGES = 20; // até 2000 mensagens/conversa
    const all: MagaluChatMessage[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { messages, total } = await MagaluChatApiService.listMessages(
        accessToken,
        conversationId,
        { offset, limit: PAGE },
      );
      all.push(...messages);
      if (messages.length < PAGE) break;
      offset += PAGE;
      if (total && offset >= total) break;
    }
    const normalized = normalizeMagaluConversationMessages(all);
    if (normalized.messages.length === 0) {
      return { synced: 0, total: 0 };
    }
    const r = await QuestionRepository.syncMagaluConversation(account.id, {
      conversationId,
      customerExternalId: normalized.customerExternalId,
      customerName: normalized.customerName,
      pending: normalized.pending,
      messages: normalized.messages,
    });
    return { synced: r.synced, total: r.synced };
  }

  /**
   * Pull on-demand dos comentários de UM anúncio Shopee (product/get_comment
   * filtrado por item_id). Q&A: reusa upsertFromShopeeComment. Pagina por cursor.
   */
  private static async pullShopeeComments(
    account: MarketplaceAccount,
    accessToken: string,
    externalItemId: string,
  ): Promise<{ synced: number; total: number }> {
    if (!account.shopId) {
      throw Object.assign(new Error("Conta Shopee sem shopId"), {
        statusCode: 400,
      });
    }
    const productListingId = await QuestionRepository.resolveListingId(
      account.id,
      externalItemId,
    );

    const MAX_PAGES = 20;
    const UPSERT_CONCURRENCY = 8;
    let cursor: string | undefined;
    let synced = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { comments, more, nextCursor } = await ShopeeApiService.getComments(
        accessToken,
        account.shopId,
        { itemId: Number(externalItemId), cursor, pageSize: 100 },
      );
      // Upserts em paralelo por chunk (comentários são linhas independentes;
      // productListingId já resolvido ⇒ sem lookup compartilhado). Espelha o ML.
      for (let i = 0; i < comments.length; i += UPSERT_CONCURRENCY) {
        const chunk = comments.slice(i, i + UPSERT_CONCURRENCY);
        await Promise.all(
          chunk.map((c) =>
            QuestionRepository.upsertFromShopeeComment(account.id, c, {
              productListingId,
            }),
          ),
        );
        synced += chunk.length;
      }
      if (!more || !nextCursor) break;
      cursor = nextCursor;
    }
    return { synced, total: synced };
  }

  /**
   * Posta resposta no ML e atualiza estado local.
   * Validações: texto não-vazio, conta do usuário, pergunta UNANSWERED.
   */
  static async answerQuestion(
    userId: string,
    accountId: string,
    questionId: string,
    text: string,
  ) {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      throw Object.assign(new Error("Texto da resposta é obrigatório"), {
        statusCode: 400,
      });
    }
    if (trimmed.length > 2000) {
      throw Object.assign(
        new Error("Texto da resposta excede o limite de 2000 caracteres"),
        { statusCode: 400 },
      );
    }

    const question = await QuestionRepository.findById(questionId);
    if (!question || question.marketplaceAccountId !== accountId) {
      throw Object.assign(new Error("Pergunta não encontrada"), {
        statusCode: 404,
      });
    }
    if (question.marketplaceAccount.userId !== userId) {
      throw Object.assign(new Error("Acesso negado"), { statusCode: 403 });
    }
    // Conversas de chat (Magalu) não respondem por questionId — usam
    // sendMagaluMessage. Guarda defensiva: a rota já despacha por plataforma.
    if (question.marketplaceAccount.platform === Platform.MAGALU) {
      throw Object.assign(
        new Error("Plataforma não suporta resposta por pergunta"),
        { statusCode: 400 },
      );
    }
    if (question.status !== "UNANSWERED") {
      throw Object.assign(
        new Error("Esta pergunta já foi respondida ou não aceita mais respostas"),
        { statusCode: 409 },
      );
    }

    const resolved = await resolveAccountForUser(userId, accountId);
    if (!resolved) {
      throw Object.assign(new Error("Conta não encontrada"), {
        statusCode: 404,
      });
    }
    const { account, accessToken } = resolved;

    // Shopee (Q&A): reply_comment + anexa a resposta localmente (a API não
    // devolve o comentário atualizado). authorType permanece NULL.
    if (account.platform === Platform.SHOPEE) {
      if (!account.shopId) {
        throw Object.assign(new Error("Conta Shopee sem shopId"), {
          statusCode: 400,
        });
      }
      await ShopeeApiService.replyComment(
        accessToken,
        account.shopId,
        Number(question.externalQuestionId),
        trimmed,
      );
      await QuestionRepository.attachAnswer(questionId, {
        text: trimmed,
        status: "ACTIVE",
        date_created: new Date().toISOString(),
      });
      return QuestionRepository.findById(questionId);
    }

    // Mercado Livre (Q&A) — comportamento legado inalterado.
    const updated = await MlQuestionsApiService.postAnswer(
      accessToken,
      question.externalQuestionId,
      trimmed,
    );

    await QuestionRepository.upsertFromMl(accountId, updated);
    const reloaded = await QuestionRepository.findById(questionId);
    return reloaded;
  }

  /**
   * Envia uma mensagem do SELLER numa conversa de chat Magalu. O `owner` do
   * payload é o DESTINATÁRIO (o cliente), cujos dados vêm das linhas locais já
   * sincronizadas da conversa. Após enviar, re-sincroniza a conversa para
   * refletir a nova mensagem (e o flip de pending → respondida).
   */
  static async sendMagaluMessage(
    userId: string,
    accountId: string,
    conversationId: string,
    text: string,
  ): Promise<{ success: boolean }> {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      throw Object.assign(new Error("Texto da mensagem é obrigatório"), {
        statusCode: 400,
      });
    }
    if (trimmed.length > 2200) {
      throw Object.assign(
        new Error("Texto da mensagem excede o limite de 2200 caracteres"),
        { statusCode: 400 },
      );
    }

    const resolved = await resolveAccountForUser(userId, accountId);
    if (!resolved || resolved.account.platform !== Platform.MAGALU) {
      throw Object.assign(new Error("Conta Magalu não encontrada"), {
        statusCode: 404,
      });
    }
    const { account, accessToken } = resolved;

    const customer = await QuestionRepository.getConversationCustomer(
      account.id,
      conversationId,
    );
    if (!customer || !customer.externalBuyerId || customer.externalBuyerId === "0") {
      throw Object.assign(
        new Error(
          "Não foi possível identificar o cliente da conversa. Sincronize a conversa e tente novamente.",
        ),
        { statusCode: 409 },
      );
    }

    await MagaluChatApiService.replyMessage(accessToken, conversationId, {
      content: trimmed,
      owner: {
        external_id: customer.externalBuyerId,
        name: customer.buyerNickname || "Cliente",
      },
    });

    // Re-sincroniza p/ trazer a mensagem recém-enviada e atualizar o status.
    await this.pullMagaluConversation(account, accessToken, conversationId);
    return { success: true };
  }

  /**
   * Polling (cron) das conversas Magalu de uma conta: lista conversas abertas e
   * grava a ÚLTIMA mensagem de cada uma localmente (o histórico completo é
   * hidratado on-demand pelo botão atualizar). Mantém a lista + badges frescos
   * sem N+1 chamadas por conversa. Best-effort: erros por-conversa são isolados.
   */
  static async syncMagaluMessagesForAccount(
    account: MagaluTokenAccount,
  ): Promise<{
    conversations: number;
    errors: number;
  }> {
    const accessToken = await ensureFreshMagaluToken(account);
    if (!accessToken) return { conversations: 0, errors: 1 };

    const PAGE = 50;
    const MAX_PAGES = 20; // teto de segurança (até 1000 conversas/ciclo)
    let offset = 0;
    let processed = 0;
    let errors = 0;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const { conversations, total } =
        await MagaluChatApiService.listConversations(accessToken, {
          status: "OPENED",
          offset,
          limit: PAGE,
        });

      for (const conv of conversations) {
        try {
          const did = await this.upsertMagaluConversationLastMessage(
            account.id,
            conv,
          );
          if (did) processed += 1;
        } catch (err) {
          errors += 1;
          console.warn(
            `[Messages] Falha ao sincronizar conversa Magalu ${conv?.id} (conta ${account.id}):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (conversations.length < PAGE) break;
      offset += PAGE;
      if (total && offset >= total) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    if (truncated) {
      console.warn(
        `[Messages] Polling de conversas Magalu da conta ${account.id} atingiu o teto de ${MAX_PAGES} páginas (truncado neste ciclo).`,
      );
    }

    return { conversations: processed, errors };
  }

  /**
   * Grava a última mensagem de uma conversa (do payload de listConversations).
   * Retorna false quando não há mensagem aprovada com id (nada a persistir).
   */
  private static async upsertMagaluConversationLastMessage(
    accountId: string,
    conv: MagaluConversation,
  ): Promise<boolean> {
    const conversationId = conv?.id;
    const last = conv?.last_message;
    if (!conversationId || !last?.id) return false;

    // O cliente é resolvido pelos PARTICIPANTES da conversa (from_user/to_user),
    // não pelo autor da última mensagem: `last_message` (MinimalMessage) não tem
    // to_user, então usar last.from_user faria o cliente cair no VENDEDOR quando
    // a última mensagem (ou a conversa) parte do seller. A conversa em si expõe
    // ambos os lados → pickMagaluCustomer escolhe o que tem type CUSTOMER.
    const customer = pickMagaluCustomer(conv.from_user, conv.to_user);
    const authorType = magaluAuthorType(last.from_user);

    await QuestionRepository.syncMagaluConversation(accountId, {
      conversationId,
      customerExternalId: customer.externalId,
      customerName: customer.name,
      pending: authorType === "CUSTOMER",
      messages: [
        {
          messageId: String(last.id),
          text: last.content ?? "",
          authorType,
          dateCreated: parseMagaluDate(last.when_at),
        },
      ],
    });
    return true;
  }

  /**
   * Polling (cron) dos comentários Shopee de uma conta: get_comment shop-wide
   * (sem item_id) paginado por cursor, upsert de cada comentário. Best-effort:
   * erros por-comentário isolados; uma falha não aborta o ciclo do loop.
   */
  static async syncShopeeCommentsForAccount(
    account: ShopeeTokenAccount,
  ): Promise<{ comments: number; errors: number }> {
    const accessToken = await ensureFreshShopeeToken(account);
    if (!accessToken || !account.shopId) return { comments: 0, errors: 1 };

    const MAX_PAGES = 20;
    let cursor: string | undefined;
    let processed = 0;
    let errors = 0;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      let comments;
      let more = false;
      let nextCursor = "";
      try {
        ({ comments, more, nextCursor } = await ShopeeApiService.getComments(
          accessToken,
          account.shopId,
          { cursor, pageSize: 100 },
        ));
      } catch (err) {
        errors += 1;
        console.warn(
          `[Messages] Falha ao listar comentários Shopee (conta ${account.id}):`,
          err instanceof Error ? err.message : err,
        );
        break;
      }

      // Upserts em paralelo por chunk; cada um isolado em try/catch para
      // preservar a contagem por-comentário (uma falha não derruba o chunk).
      const UPSERT_CONCURRENCY = 8;
      for (let i = 0; i < comments.length; i += UPSERT_CONCURRENCY) {
        const chunk = comments.slice(i, i + UPSERT_CONCURRENCY);
        await Promise.all(
          chunk.map(async (c) => {
            try {
              await QuestionRepository.upsertFromShopeeComment(account.id, c);
              processed += 1;
            } catch (err) {
              errors += 1;
              console.warn(
                `[Messages] Falha ao gravar comentário Shopee ${c?.comment_id} (conta ${account.id}):`,
                err instanceof Error ? err.message : err,
              );
            }
          }),
        );
      }

      if (!more || !nextCursor) break;
      cursor = nextCursor;
      // Atingiu o teto com mais páginas pendentes: não silenciar (req. de
      // observabilidade). A Shopee devolve newest-first, então os truncados são
      // os mais antigos (já sincronizados em ciclos anteriores).
      if (page === MAX_PAGES - 1) truncated = true;
    }

    if (truncated) {
      console.warn(
        `[Messages] Polling de comentários Shopee da conta ${account.id} atingiu o teto de ${MAX_PAGES} páginas com mais comentários pendentes (truncado neste ciclo).`,
      );
    }

    return { comments: processed, errors };
  }
}

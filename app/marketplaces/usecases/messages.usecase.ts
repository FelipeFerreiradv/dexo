import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { QuestionRepository } from "../repositories/question.repository";
import { MlQuestionsApiService } from "../services/ml-questions-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { MLQuestionWebhookPayload } from "../types/ml-questions.types";
import { SystemLogService } from "@/app/services/system-log.service";

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;

interface AccountWithToken {
  id: string;
  userId: string;
  accessToken: string;
}

/**
 * Resolve uma conta ML pelo accountId garantindo que pertence ao userId
 * e que o accessToken está válido (refresh automático se expirado).
 */
async function resolveAccountForUser(
  userId: string,
  accountId: string,
): Promise<AccountWithToken | null> {
  const account = await MarketplaceRepository.findByIdAndUser(accountId, userId);
  if (!account || account.platform !== Platform.MERCADO_LIVRE) return null;

  const accessToken = await ensureFreshToken(account);
  return { id: account.id, userId: account.userId, accessToken };
}

async function ensureFreshToken(account: {
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
          const accessToken = await ensureFreshToken(account);
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
    const account = await resolveAccountForUser(userId, accountId);
    if (!account) {
      throw Object.assign(new Error("Conta ML não encontrada"), {
        statusCode: 404,
      });
    }

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
        account.accessToken,
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
    if (question.status !== "UNANSWERED") {
      throw Object.assign(
        new Error("Esta pergunta já foi respondida ou não aceita mais respostas"),
        { statusCode: 409 },
      );
    }

    const account = await resolveAccountForUser(userId, accountId);
    if (!account) {
      throw Object.assign(new Error("Conta ML não encontrada"), {
        statusCode: 404,
      });
    }

    const updated = await MlQuestionsApiService.postAnswer(
      account.accessToken,
      question.externalQuestionId,
      trimmed,
    );

    await QuestionRepository.upsertFromMl(accountId, updated);
    const reloaded = await QuestionRepository.findById(questionId);
    return reloaded;
  }
}

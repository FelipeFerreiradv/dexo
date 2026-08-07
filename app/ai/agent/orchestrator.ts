// O loop de um turno do Bitz.
//
// Fase 2: SEM NENHUMA TOOL. O agente conversa, persiste e mede — nada mais.
// As tools de leitura entram na Fase 5 no ponto marcado abaixo, e a hierarquia
// de fontes na Fase 6. O desenho já reserva o lugar delas para aquelas fases
// não reescreverem este arquivo.
//
// INVARIANTE DESTE MÓDULO: `runTurn` nunca lança. Toda falha vira uma resposta
// degradada com `degraded: true`. Nenhum erro de IA pode derrubar uma
// requisição de negócio (REGRA 2 do plano).
//
// O `dataOwnerId` chega pelo `AiTurnInput`, montado pela rota a partir da
// sessão autenticada. Ele NUNCA vem do corpo da requisição e NUNCA é algo que
// o modelo possa produzir.

import prisma from "../../lib/prisma";
import {
  auditChatTurn,
  auditProviderError,
  auditQuotaExceeded,
} from "../audit/ai-audit";
import { resolveAiProvider, userFacingFailureMessage } from "../core/provider";
import { describeAiConfigProblem } from "../core/ai-constants";
import type { AiFailureReason, AiMessage } from "../core/types";
import {
  quotaMessage,
  refundAiTurn,
  reserveAiTurn,
  type AiQuotaDenial,
} from "../quota/ai-usage.service";
import { buildContextWindow, estimateTokens } from "./context-window";
import { buildSystemPrompt } from "./system-prompt";

/** Teto de caracteres de UMA mensagem do usuário. */
export const MAX_USER_MESSAGE_CHARS = 4000;

/** Quantas mensagens da conversa são lidas do banco por turno. */
const HISTORY_FETCH_LIMIT = 40;

export interface AiTurnInput {
  dataOwnerId: string;
  actorUserId: string;
  message: string;
  conversationId?: string;
  /** Injetável para teste. */
  db?: any;
  now?: Date;
}

export interface AiTurnResult {
  conversationId: string;
  content: string;
  sources: unknown[];
  /** true quando a resposta NÃO veio do modelo (indisponível, quota, erro). */
  degraded: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/** Título derivado da primeira pergunta — dá nome à conversa na listagem. */
function deriveTitle(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || "Conversa";
}

export async function runTurn(input: AiTurnInput): Promise<AiTurnResult> {
  const db = input.db ?? (prisma as any);
  const { dataOwnerId, actorUserId } = input;

  const message = input.message.slice(0, MAX_USER_MESSAGE_CHARS).trim();

  // -------------------------------------------------------------------------
  // 1. Conversa: carrega a existente (provando a posse) ou cria uma nova.
  //    O `where` inclui actorUserId — um id de conversa de outro usuário não
  //    resolve, ele simplesmente não encontra e abre conversa nova.
  // -------------------------------------------------------------------------
  let conversation = input.conversationId
    ? await db.aiConversation.findFirst({
        where: { id: input.conversationId, actorUserId, dataOwnerId },
        select: { id: true, summary: true },
      })
    : null;

  if (!conversation) {
    conversation = await db.aiConversation.create({
      data: {
        dataOwnerId,
        actorUserId,
        title: deriveTitle(message),
      },
      select: { id: true, summary: true },
    });
  }

  const conversationId: string = conversation.id;

  // Persiste a pergunta ANTES de chamar o provedor: se o modelo falhar, a
  // conversa continua coerente e o usuário não perde o que digitou.
  await db.aiMessage.create({
    data: { conversationId, role: "user", content: message },
  });

  const degrade = async (
    content: string,
    errorCode: string,
  ): Promise<AiTurnResult> => {
    await db.aiMessage.create({
      data: { conversationId, role: "assistant", content, errorCode },
    });
    await db.aiConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return {
      conversationId,
      content,
      sources: [],
      degraded: true,
      usage: { inputTokens: null, outputTokens: null },
    };
  };

  // -------------------------------------------------------------------------
  // 2. Provedor. Resolvido antes da quota: sem provedor não faz sentido gastar
  //    cota do cliente.
  // -------------------------------------------------------------------------
  const provider = resolveAiProvider();
  if (!provider) {
    const reason = (describeAiConfigProblem() ??
      "provedor_desconhecido") as AiFailureReason;
    auditProviderError({
      dataOwnerId,
      actorUserId,
      conversationId,
      provider: "",
      model: "",
      reason,
      latencyMs: 0,
    });
    return degrade(userFacingFailureMessage(reason), reason);
  }

  // -------------------------------------------------------------------------
  // 3. Quota diária (tenant + global), reserva pessimista.
  // -------------------------------------------------------------------------
  const quota = await reserveAiTurn({ dataOwnerId, db, now: input.now });
  if (!quota.ok) {
    const denied: AiQuotaDenial = quota.denied ?? "tenant";
    auditQuotaExceeded({ dataOwnerId, actorUserId, conversationId, denied });
    return degrade(quotaMessage(denied), `quota_${denied}`);
  }

  // -------------------------------------------------------------------------
  // 4. Contexto: system prompt + resumo + janela do histórico.
  //    (Fase 4 acrescenta os chunks de RAG ao `extraSystem`;
  //     Fase 5 acrescenta o subconjunto de tools ao `chat`.)
  // -------------------------------------------------------------------------
  const historyRows = await db.aiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_FETCH_LIMIT,
    select: { role: true, content: true },
  });
  const history: AiMessage[] = historyRows
    .reverse()
    .map((r: any) => ({
      role: r.role as AiMessage["role"],
      content: r.content,
    }));

  const extraSystem: string[] = [];
  if (conversation.summary) {
    extraSystem.push(
      `RESUMO DO QUE JÁ FOI CONVERSADO (turnos antigos, fora da janela):\n${conversation.summary}`,
    );
  }
  const systemPrompt = buildSystemPrompt(extraSystem);

  const windowed = buildContextWindow({
    history,
    previousSummary: conversation.summary,
    fixedCost: estimateTokens(systemPrompt),
  });

  const messages: AiMessage[] = [
    { role: "system", content: systemPrompt },
    ...windowed.messages,
  ];

  // -------------------------------------------------------------------------
  // 5. Chamada ao modelo. `chat` nunca lança; o try/catch é cinto e suspensório
  //    para o caso de um provedor futuro quebrar o contrato.
  // -------------------------------------------------------------------------
  let completion;
  try {
    completion = await provider.chat({ messages });
  } catch (err) {
    completion = {
      ok: false as const,
      reason: "erro_provedor" as AiFailureReason,
      detail: err instanceof Error ? err.message.slice(0, 120) : "erro",
      provider: provider.name,
      model: provider.model,
      latencyMs: 0,
    };
  }

  if (!completion.ok) {
    // O turno não virou chamada útil: devolve a cota.
    await refundAiTurn({ dataOwnerId, db, now: input.now });
    auditProviderError({
      dataOwnerId,
      actorUserId,
      conversationId,
      provider: completion.provider,
      model: completion.model,
      reason: completion.reason,
      detail: completion.detail,
      latencyMs: completion.latencyMs,
    });
    return degrade(
      userFacingFailureMessage(completion.reason),
      completion.reason,
    );
  }

  // -------------------------------------------------------------------------
  // 6. Persiste a resposta com tokens/latência — é o que permite medir custo.
  // -------------------------------------------------------------------------
  await db.aiMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content: completion.content,
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      latencyMs: completion.latencyMs,
    },
  });

  await db.aiConversation.update({
    where: { id: conversationId },
    data: {
      updatedAt: new Date(),
      ...(windowed.summary !== conversation.summary
        ? { summary: windowed.summary }
        : {}),
    },
  });

  auditChatTurn({
    dataOwnerId,
    actorUserId,
    conversationId,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    latencyMs: completion.latencyMs,
    toolCalls: completion.toolCalls.length,
    degraded: false,
  });

  return {
    conversationId,
    content: completion.content,
    sources: [],
    degraded: false,
    usage: completion.usage,
  };
}

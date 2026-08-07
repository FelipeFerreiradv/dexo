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
import type { AiFailureReason, AiMessage, AiSource } from "../core/types";
import {
  formatKnowledgeForPrompt,
  retrieveKnowledge,
} from "../knowledge/retriever";
import {
  quotaMessage,
  refundAiTurn,
  reserveAiTurn,
  type AiQuotaDenial,
} from "../quota/ai-usage.service";
import type { AiScope } from "../core/scope";
import { getReadToolRegistry } from "../tools/read";
import { toToolDefinition } from "../tools/registry";
import { selectTools } from "../tools/select";
import { buildContextWindow, estimateTokens } from "./context-window";
import { classifyIntent } from "./intent";
import {
  REGRAS_DE_CONSULTA,
  buildSystemPrompt,
  wrapSystemData,
} from "./system-prompt";
import { runTool, type ToolRunResult } from "./tool-runner";

/** Teto de caracteres de UMA mensagem do usuário. */
export const MAX_USER_MESSAGE_CHARS = 4000;

/**
 * Rodadas de consulta por turno. Trava DURA.
 *
 * Sem ela, um modelo confuso pede a mesma tool indefinidamente e o turno custa
 * sem teto. Duas rodadas cobrem o padrão real ("busca a peça" → "busca o
 * anúncio dela"); a terceira quase sempre é o modelo se repetindo.
 */
export const MAX_TOOL_ROUNDS = 2;

/** Quantas mensagens da conversa são lidas do banco por turno. */
const HISTORY_FETCH_LIMIT = 40;

export interface AiTurnInput {
  dataOwnerId: string;
  actorUserId: string;
  message: string;
  conversationId?: string;
  /**
   * Escopo de execução das tools (tenant + permissões do ator).
   *
   * OPCIONAL, e ausente significa TURNO SEM TOOLS. É a trava de último recurso:
   * um chamador que não conseguiu montar o escopo a partir de uma sessão
   * autenticada não consulta dado nenhum — em vez de consultar com um tenant
   * adivinhado.
   */
  scope?: AiScope;
  /** Injetável para teste. */
  db?: any;
  now?: Date;
}

/**
 * Quantos registros a tool devolveu, para o bloco de Fontes.
 *
 * Convenção dos handlers: lista em `itens` e contagem em `total`. Quem não
 * segue (um detalhe único) conta como 1 — o usuário lê "1 registro", que é
 * verdade.
 */
function countOf(r: ToolRunResult): number {
  try {
    const parsed = JSON.parse(r.content.split("\n\n[RESULTADO TRUNCADO")[0]);
    if (Array.isArray(parsed)) return parsed.length;
    if (typeof parsed?.total === "number") return parsed.total;
    if (Array.isArray(parsed?.itens)) return parsed.itens.length;
    return parsed ? 1 : 0;
  } catch {
    // Truncado no meio do JSON: a contagem exata não importa tanto quanto não
    // quebrar a resposta por causa dela.
    return 0;
  }
}

export interface AiTurnResult {
  conversationId: string;
  content: string;
  sources: AiSource[];
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
  const { dataOwnerId, actorUserId, scope } = input;

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
  // 4. Contexto: system prompt + resumo + base de conhecimento + cardápio de
  //    tools + janela do histórico.
  // -------------------------------------------------------------------------
  const historyRows = await db.aiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_FETCH_LIMIT,
    select: { role: true, content: true },
  });
  const history: AiMessage[] = historyRows.reverse().map((r: any) => ({
    role: r.role as AiMessage["role"],
    content: r.content,
  }));

  const extraSystem: string[] = [];
  if (conversation.summary) {
    extraSystem.push(
      `RESUMO DO QUE JÁ FOI CONVERSADO (turnos antigos, fora da janela):\n${conversation.summary}`,
    );
  }

  // Base de conhecimento sobre o Dexo — só quando a intenção é dúvida.
  // Pergunta de relatório não paga RAG.
  //
  // `retrieveKnowledge` NÃO recebe dataOwnerId: a base é global, fala do
  // produto e não do cliente (ver o cabeçalho do retriever).
  //
  // O conteúdo entra pelo `wrapSystemData` — é DADO, nunca instrução. Um
  // documento não pode reprogramar o agente, e nenhum deles tenta; o envelope
  // existe para que continue verdade quando alguém editar um .md.
  const sources: AiSource[] = [];
  const intent = classifyIntent(message);
  if (intent.needsRag) {
    const hits = await retrieveKnowledge(message, { db });
    if (hits.length > 0) {
      extraSystem.push(
        wrapSystemData(
          "base de conhecimento do Dexo",
          formatKnowledgeForPrompt(hits),
        ),
      );
      for (const h of hits) {
        sources.push({
          kind: "conhecimento",
          docId: h.docId,
          docTitle: h.docTitle,
          ...(h.heading ? { heading: h.heading } : {}),
        });
      }
    }
  }

  // Subconjunto de tools do turno. Decidido ANTES do system prompt porque as
  // regras de consulta só entram quando há consulta a fazer.
  const registry = getReadToolRegistry();
  const ferramentas =
    intent.needsTools && scope
      ? selectTools(message, registry).map(toToolDefinition)
      : undefined;

  if (ferramentas?.length) extraSystem.push(REGRAS_DE_CONSULTA);

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
  // 5. Chamadas ao modelo, com até MAX_TOOL_ROUNDS rodadas de consulta.
  //
  //    `chat` nunca lança; o try/catch é cinto e suspensório para o caso de um
  //    provedor futuro quebrar o contrato.
  // -------------------------------------------------------------------------
  const chamar = async (tools?: typeof ferramentas) => {
    try {
      return await provider.chat({ messages, tools });
    } catch (err) {
      return {
        ok: false as const,
        reason: "erro_provedor" as AiFailureReason,
        detail: err instanceof Error ? err.message.slice(0, 120) : "erro",
        provider: provider.name,
        model: provider.model,
        latencyMs: 0,
      };
    }
  };

  let completion = await chamar(ferramentas);

  // Trilha das consultas do turno. Vai para `AiMessage.toolCalls` (auditoria) e
  // para a contagem do log — SEM os argumentos, que carregam dado do cliente.
  const trilha: Array<{ name: string; ok: boolean; ms: number }> = [];
  let rodadas = 0;

  while (
    completion.ok &&
    completion.toolCalls.length > 0 &&
    scope &&
    rodadas < MAX_TOOL_ROUNDS
  ) {
    rodadas++;

    // O turno do modelo volta ao histórico COM o pedido de tool: o provedor
    // casa cada resposta com a chamada correspondente, e um turno de texto
    // vazio no lugar deixaria a conversa sem par.
    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    // Em paralelo: as tools de leitura são independentes entre si, e o modelo
    // costuma pedir duas de uma vez ("o produto E o anúncio dele").
    const resultados = await Promise.all(
      completion.toolCalls.map((call) =>
        runTool(call, { registry, scope, conversationId }),
      ),
    );

    for (const r of resultados) {
      trilha.push({ name: r.name, ok: r.ok, ms: r.ms });
      messages.push({ role: "tool", content: r.content, toolName: r.name });
      if (r.ok) {
        const tool = registry.get(r.name);
        if (tool) {
          sources.push({
            kind: "proprio",
            label: tool.sourceLabel,
            count: countOf(r),
          });
        }
      }
    }

    completion = await chamar(ferramentas);
  }

  // Estourou o teto de rodadas e o modelo ainda quer consultar. Uma última
  // chamada SEM tools: sem cardápio ele é obrigado a responder em texto com o
  // que já tem, em vez de devolver mais um pedido que ninguém vai executar.
  if (completion.ok && completion.toolCalls.length > 0) {
    messages.push({
      role: "system",
      content: `Você atingiu o limite de ${MAX_TOOL_ROUNDS} rodadas de consulta neste turno. Responda agora com o que já obteve. Se faltou informação, diga o que faltou e proponha uma pergunta mais específica. NÃO invente número nenhum.`,
    });
    completion = await chamar(undefined);
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
      // Guardado junto da resposta: reabrir a conversa mostra as mesmas fontes
      // de antes, sem refazer a busca. Vazio vira null para não gravar `[]`
      // em toda mensagem que não consultou nada.
      sources: sources.length > 0 ? sources : null,
      // Só nome, resultado e duração. Os ARGUMENTOS ficam de fora: carregam o
      // termo que o usuário digitou, que já vive na própria conversa.
      toolCalls: trilha.length > 0 ? trilha : null,
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
    toolCalls: trilha.length,
    degraded: false,
  });

  return {
    conversationId,
    content: completion.content,
    sources,
    degraded: false,
    usage: completion.usage,
  };
}

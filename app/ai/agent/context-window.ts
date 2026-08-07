// Janela de contexto. Custo é requisito de arquitetura, não detalhe.
//
// Sem teto, uma conversa longa cresce o input de forma linear e o custo junto
// — e o input domina o gasto numa razão de ~15:1 neste tráfego. Aqui a janela
// é fixa e o que sai dela vira resumo.
//
// O RESUMO É EXTRATIVO, não gerado por LLM. Gerar resumo custaria uma SEGUNDA
// chamada ao modelo por turno — dobrar o número de requisições para economizar
// tokens é um mau negócio nesta escala de conversa. Extrair a primeira linha
// de cada troca descartada preserva o fio da conversa por uma fração do custo.

import type { AiMessage } from "../core/types";

/** ~4 chars por token: regra de bolso usual, boa o bastante para orçar. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: AiMessage[]): number {
  // +4 por mensagem cobre o overhead de role/delimitadores de qualquer dialeto.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export const DEFAULT_INPUT_BUDGET_TOKENS = 8000;

/** Teto do resumo acumulado, para ele próprio não virar o problema. */
export const SUMMARY_MAX_CHARS = 1500;

export interface WindowResult {
  /** Mensagens que entram no contexto, na ordem cronológica. */
  messages: AiMessage[];
  /** Resumo atualizado (o anterior + o que saiu agora), ou null se nada saiu. */
  summary: string | null;
  /** Quantas mensagens foram descartadas da janela nesta passagem. */
  dropped: number;
  estimatedTokens: number;
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const clean = line.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Escolhe as mensagens que cabem no orçamento, das MAIS RECENTES para trás.
 *
 * `fixedCost` é o que já está reservado fora do histórico (system prompt,
 * definição das tools, chunks de RAG) — o histórico só pode usar o que sobra.
 */
export function buildContextWindow(input: {
  history: AiMessage[];
  previousSummary?: string | null;
  fixedCost?: number;
  budget?: number;
}): WindowResult {
  const budget = input.budget ?? DEFAULT_INPUT_BUDGET_TOKENS;
  const available = Math.max(0, budget - (input.fixedCost ?? 0));

  const kept: AiMessage[] = [];
  let used = 0;

  for (let i = input.history.length - 1; i >= 0; i--) {
    const m = input.history[i];
    const cost = estimateTokens(m.content) + 4;
    // A última mensagem entra mesmo estourando: uma pergunta gigante deve ser
    // truncada pelo chamador, não sumir e o Bitz responder ao vazio.
    if (used + cost > available && kept.length > 0) break;
    kept.unshift(m);
    used += cost;
  }

  const droppedMessages = input.history.slice(
    0,
    input.history.length - kept.length,
  );

  if (droppedMessages.length === 0) {
    return {
      messages: kept,
      summary: input.previousSummary ?? null,
      dropped: 0,
      estimatedTokens: used,
    };
  }

  const novas = droppedMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map(
      (m) =>
        `${m.role === "user" ? "Usuário" : "Bitz"}: ${firstLine(m.content)}`,
    );

  const combined = [input.previousSummary?.trim(), ...novas]
    .filter((s): s is string => Boolean(s && s.length))
    .join("\n");

  // Corta pelo INÍCIO: o passado distante é o que menos importa.
  const summary =
    combined.length > SUMMARY_MAX_CHARS
      ? `…${combined.slice(combined.length - SUMMARY_MAX_CHARS + 1)}`
      : combined;

  return {
    messages: kept,
    summary: summary || null,
    dropped: droppedMessages.length,
    estimatedTokens: used,
  };
}

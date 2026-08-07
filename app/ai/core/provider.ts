// Registro de provedores. É o único lugar que decide QUAL LLM roda.
//
// Trocar de provedor é mudar AI_PROVIDER no .env — nenhum outro arquivo do
// repositório importa GeminiProvider ou MockAiProvider diretamente.

import { describeAiConfigProblem, getAiProviderName } from "./ai-constants";
import { GeminiProvider } from "./gemini.provider";
import { MockAiProvider } from "./mock.provider";
import type { AiCompletion, AiFailureReason, AiProvider } from "./types";

/**
 * Instancia o provedor configurado. Sem config válida devolve `null` — quem
 * chama DEGRADA (mostra indisponibilidade no chat), nunca lança.
 *
 * Não há cache de instância de propósito: os construtores leem o env a cada
 * chamada, então um `.env` editado + `pm2 restart` vale sem rebuild, mesmo
 * padrão de isImageMetricsEnabled().
 */
export function resolveAiProvider(): AiProvider | null {
  if (describeAiConfigProblem() !== null) return null;

  switch (getAiProviderName()) {
    case "mock":
      return new MockAiProvider();
    case "gemini":
      return new GeminiProvider();
    default:
      return null;
  }
}

/**
 * Completion de falha para quando nem provedor existe. Mantém o mesmo shape
 * que o orquestrador já trata — sem ramo especial no caminho feliz.
 */
export function unavailableCompletion(reason: AiFailureReason): AiCompletion {
  return {
    ok: false,
    reason,
    provider: getAiProviderName(),
    model: "",
    latencyMs: 0,
  };
}

/**
 * Mensagem que o USUÁRIO lê. Nunca expõe detalhe técnico, status HTTP, nome de
 * modelo ou fragmento de resposta do provedor.
 */
export function userFacingFailureMessage(reason: AiFailureReason): string {
  switch (reason) {
    case "modulo_desligado":
    case "sem_api_key":
    case "sem_modelo":
    case "provedor_desconhecido":
      return "O Bitz está indisponível no momento. Avise o suporte do Dexo.";
    case "timeout":
      return "Demorei demais para responder. Tenta de novo?";
    case "rate_limit_provedor":
      return "Estou recebendo muitas perguntas agora. Tenta de novo em instantes.";
    case "resposta_invalida":
    case "erro_provedor":
    default:
      return "Não consegui responder agora. Tenta de novo em instantes.";
  }
}

export { describeAiConfigProblem };

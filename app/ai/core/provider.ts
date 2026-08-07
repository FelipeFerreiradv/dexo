// Registro de provedores. É o único lugar que decide QUAL LLM roda.
//
// Trocar de provedor é mudar AI_PROVIDER no .env — nenhum outro arquivo do
// repositório importa GeminiProvider ou MockAiProvider diretamente.

import {
  describeAiConfigProblem,
  getAiApiKeyFor,
  getAiRoute,
  type AiCapability,
} from "./ai-constants";
import { DeepSeekProvider } from "./deepseek.provider";
import { GeminiProvider } from "./gemini.provider";
import { MockAiProvider } from "./mock.provider";
import type { AiCompletion, AiFailureReason, AiProvider } from "./types";

/**
 * Instancia o provedor da CAPACIDADE pedida. Sem config válida devolve `null`
 * — quem chama DEGRADA (mostra indisponibilidade no chat), nunca lança.
 *
 * ⭐ O PARÂMETRO TEM DEFAULT `"texto"`, e isso não é comodidade: `texto` é a
 * única capacidade consumida hoje, e o default mantém `resolveAiProvider()`
 * significando exatamente o que significava antes desta mudança — inclusive
 * para os testes que já existiam.
 *
 * ⚠️ A CHAVE É RESOLVIDA AQUI E PASSADA EXPLÍCITA, inclusive quando não existe
 * (`""`). Os construtores dos provedores caem em `AI_API_KEY` quando recebem
 * `undefined`, e é exatamente esse fallback que não pode acontecer: com
 * `AI_PROVIDER=gemini` e `AI_ROUTE_TEXTO=deepseek:...`, ele mandaria a chave do
 * Google para o servidor do DeepSeek. String vazia bloqueia o fallback, e o
 * provedor devolve `sem_api_key` — a falha correta.
 *
 * Não há cache de instância de propósito: os construtores leem o env a cada
 * chamada, então um `.env` editado + `pm2 restart` vale sem rebuild, mesmo
 * padrão de isImageMetricsEnabled().
 */
export function resolveAiProvider(
  capacidade: AiCapability = "texto",
): AiProvider | null {
  if (describeAiConfigProblem(capacidade) !== null) return null;

  const { provider, model } = getAiRoute(capacidade);
  const opts = { apiKey: getAiApiKeyFor(provider) ?? "", model: model ?? "" };

  switch (provider) {
    case "mock":
      return new MockAiProvider();
    case "gemini":
      return new GeminiProvider(opts);
    case "deepseek":
      return new DeepSeekProvider(opts);
    default:
      return null;
  }
}

/**
 * Completion de falha para quando nem provedor existe. Mantém o mesmo shape
 * que o orquestrador já trata — sem ramo especial no caminho feliz.
 */
export function unavailableCompletion(
  reason: AiFailureReason,
  capacidade: AiCapability = "texto",
): AiCompletion {
  return {
    ok: false,
    reason,
    // O provedor da rota, não o legado: numa config com rota própria, dizer
    // "gemini" enquanto o texto vai para o DeepSeek manda o suporte investigar
    // o provedor errado. Sem rota, `getAiRoute` devolve o legado — idêntico ao
    // comportamento anterior.
    provider: getAiRoute(capacidade).provider,
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

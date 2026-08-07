// Contratos do módulo Bitz. Isolam TODA a aplicação de qual LLM está por trás.
//
// Regra que atravessa este arquivo inteiro: `AiProvider.chat` NUNCA lança.
// Provedor fora do ar, timeout, 4xx/5xx, quota, chave ausente, resposta
// malformada — tudo vira `{ ok: false, reason }`. Nenhum erro de IA pode
// derrubar uma requisição de negócio, poluir log de erro crítico ou disparar
// alerta de infra (REGRA 2 do plano).

/** Papéis de mensagem, normalizados. Cada provedor mapeia para o seu dialeto. */
export type AiRole = "system" | "user" | "assistant" | "tool";

export interface AiMessage {
  role: AiRole;
  content: string;
  /** Só em role="tool": qual chamada esta mensagem responde. */
  toolCallId?: string;
  /** Só em role="tool": nome da tool que produziu o conteúdo. */
  toolName?: string;
}

/** Definição que o modelo VÊ. `parameters` é JSON Schema (derivado do zod). */
export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Pedido de tool vindo do modelo. `args` é NÃO CONFIÁVEL até passar por zod. */
export interface AiToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * De onde veio o que o Bitz respondeu.
 *
 * É CAMPO ESTRUTURADO, preenchido pelo servidor a partir do que de fato foi
 * consultado — nunca texto que o modelo escreve. O modelo não consegue
 * "esquecer" de citar, nem inventar uma fonte que não existiu.
 *
 * Fase 4 emite só `conhecimento`. As demais variantes entram nas Fases 5 e 6,
 * declaradas desde já para o contrato da UI não mudar depois.
 */
export type AiSource =
  | { kind: "conhecimento"; docId: string; docTitle: string; heading?: string }
  | { kind: "proprio"; label: string; count: number }
  | {
      kind: "plataforma";
      sampleSize: number;
      confidence: "alta" | "media" | "baixa";
      matchKey: string;
    }
  | { kind: "regra"; rule: string }
  | { kind: "externa"; provider: "mercado-livre"; ref?: string }
  | { kind: "estimativa"; note: string };

/**
 * Motivos de falha. São o vocabulário que a UI e a auditoria enxergam — nunca
 * a mensagem crua do provedor, que pode conter fragmento de prompt ou chave.
 */
export type AiFailureReason =
  | "modulo_desligado"
  | "sem_api_key"
  | "sem_modelo"
  | "provedor_desconhecido"
  | "timeout"
  | "rate_limit_provedor"
  | "erro_provedor"
  | "resposta_invalida";

export interface AiCompletionOk {
  ok: true;
  content: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface AiCompletionError {
  ok: false;
  reason: AiFailureReason;
  /** Detalhe curto e JÁ SANITIZADO para log. Nunca vai para o usuário final. */
  detail?: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export type AiCompletion = AiCompletionOk | AiCompletionError;

export interface AiChatInput {
  messages: AiMessage[];
  tools?: AiToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * A interface que isola o repositório do provedor. Implementações desta
 * entrega: GeminiProvider (REST) e MockAiProvider (offline, determinístico).
 *
 * `transcribe` e `embed` são deliberadamente OPCIONAIS: nem todo provedor tem,
 * e o Bitz precisa degradar quando não houver — nunca assumir presença.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  chat(input: AiChatInput): Promise<AiCompletion>;
  transcribe?(audio: Buffer, mimeType: string): Promise<AiCompletion>;
  embed?(texts: string[]): Promise<number[][] | null>;
}

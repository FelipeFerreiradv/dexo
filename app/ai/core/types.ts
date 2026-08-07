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
  /**
   * Só em role="assistant": as tools que ESTE turno do modelo pediu.
   *
   * Existe porque o protocolo exige devolver o pedido junto da resposta: o
   * histórico precisa conter o `functionCall` do modelo antes do
   * `functionResponse` correspondente. Mandar de volta um turno de texto vazio
   * no lugar do pedido deixa a conversa incoerente para o provedor.
   */
  toolCalls?: AiToolCall[];
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
  /**
   * Carimbo OPACO do provedor, para ser devolvido junto do pedido na próxima
   * chamada. Nós nunca lemos nem interpretamos o conteúdo.
   *
   * ⭐ POR QUE ISTO EXISTE. O Gemini 3.x exige que a `thoughtSignature` que
   * acompanha um `functionCall` volte inalterada quando aquele turno é
   * reenviado no histórico. Sem ela, a segunda chamada do turno é recusada com
   * HTTP 400 ("Function call is missing a thought_signature") — ou seja,
   * **toda pergunta que precisa consultar o sistema falha**, enquanto as de
   * dúvida pura funcionam. É um modo de falha que parece intermitente e não é.
   *
   * Opcional de propósito: provedor que não usa isso simplesmente não preenche,
   * e nada no resto do sistema muda.
   */
  providerSignature?: string;
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
  /**
   * A MESMA chamada de `chat`, avisando o texto conforme ele chega.
   *
   * OPCIONAL, e a ausência é um caso normal: sem ela o orquestrador usa `chat`
   * e o turno inteiro chega de uma vez. Streaming é melhoria de percepção, não
   * requisito de funcionamento — um provedor novo entra sem implementar isto.
   *
   * O retorno é o MESMO `AiCompletion` de `chat`, e é ele que vale. Os deltas
   * são prévia: quem grava no banco e quem o usuário lê no fim é o retorno.
   * Essa regra é o que torna impossível a resposta final divergir do que foi
   * transmitido.
   *
   * Também NUNCA lança — mesmo contrato de `chat`.
   */
  chatStream?(
    input: AiChatInput,
    onDelta: (texto: string) => void,
  ): Promise<AiCompletion>;
  transcribe?(audio: Buffer, mimeType: string): Promise<AiCompletion>;
  embed?(texts: string[]): Promise<number[][] | null>;
}

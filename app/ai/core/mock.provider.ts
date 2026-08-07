// Provedor determinístico e SEM REDE. É o provedor de 100% da suíte de testes.
//
// Nenhum teste do repositório pode depender de uma chamada real a LLM: seria
// lento, caro, flaky e mudaria de resposta a cada versão do modelo. Este mock
// é a contraparte disso — dado o mesmo input, devolve sempre o mesmo output.
//
// Dois modos:
//  1. FILA (testes): __pushMockCompletion() empilha respostas exatas. Cada
//     chat() consome uma. É como se testa tool call, erro de provedor e
//     sequência de turnos sem tocar em rede.
//  2. ECO (default): sem fila, devolve um texto derivado da última mensagem do
//     usuário. Serve para o desenvolvimento local sem chave nenhuma.

import type {
  AiChatInput,
  AiCompletion,
  AiFailureReason,
  AiMessage,
  AiProvider,
  AiToolCall,
  AiUsage,
} from "./types";

export const MOCK_PROVIDER_NAME = "mock";
export const MOCK_MODEL = "mock-1";

/**
 * Estimativa de tokens. ~4 chars por token é a regra de bolso usual e serve
 * para o mock: o número precisa ser DETERMINÍSTICO, não exato.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function usageFor(messages: AiMessage[], output: string): AiUsage {
  const input = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return { inputTokens: input, outputTokens: estimateTokens(output) };
}

/** Fila de respostas exatas para os testes. */
const queue: AiCompletion[] = [];

/** O que um teste empilha. `provider`/`model`/`latencyMs` são preenchidos aqui. */
export type MockCompletionInput =
  | {
      ok?: true;
      content: string;
      toolCalls?: AiToolCall[];
      usage?: AiUsage;
    }
  | {
      ok: false;
      reason: AiFailureReason;
      detail?: string;
    };

/** Empilha a próxima resposta do mock. */
export function __pushMockCompletion(input: MockCompletionInput): void {
  const base = {
    provider: MOCK_PROVIDER_NAME,
    model: MOCK_MODEL,
    latencyMs: 0,
  };

  if (input.ok === false) {
    queue.push({
      ...base,
      ok: false,
      reason: input.reason,
      detail: input.detail,
    });
    return;
  }

  queue.push({
    ...base,
    ok: true,
    content: input.content,
    toolCalls: input.toolCalls ?? [],
    usage: input.usage ?? {
      inputTokens: 0,
      outputTokens: estimateTokens(input.content),
    },
  });
}

/**
 * Último input que chegou ao provedor.
 *
 * Existe para o teste conseguir inspecionar o que foi REALMENTE enviado ao
 * modelo — se a base de conhecimento entrou envelopada, se a chave da API
 * vazou para dentro de alguma mensagem, e (na Fase 5) qual subconjunto de
 * tools foi oferecido. Sem isso, o único jeito de verificar o prompt seria
 * espionar o `chat` com `vi.spyOn`, que acopla o teste à classe.
 */
let lastInput: AiChatInput | null = null;

export function __lastMockChatInput(): AiChatInput | null {
  return lastInput;
}

/** Zera a fila entre testes. */
export function __resetMockProvider(): void {
  queue.length = 0;
  lastInput = null;
}

/** Quantas respostas ainda estão na fila (assert de "consumiu tudo"). */
export function __pendingMockCompletions(): number {
  return queue.length;
}

export class MockAiProvider implements AiProvider {
  readonly name = MOCK_PROVIDER_NAME;
  readonly model = MOCK_MODEL;

  async chat(input: AiChatInput): Promise<AiCompletion> {
    lastInput = input;
    const queued = queue.shift();
    if (queued) return queued;

    // Modo eco: determinístico, sem rede, sem fila.
    const lastUser = [...input.messages]
      .reverse()
      .find((m) => m.role === "user");
    const content = lastUser
      ? `Bitz (mock): recebi "${lastUser.content}".`
      : "Bitz (mock): sem mensagem do usuário.";

    return {
      ok: true,
      content,
      toolCalls: [],
      usage: usageFor(input.messages, content),
      provider: this.name,
      model: this.model,
      latencyMs: 0,
    };
  }
}

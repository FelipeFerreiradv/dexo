// Provedor DeepSeek via REST puro (axios), sem SDK — mesma decisão do Gemini.
//
// A API do DeepSeek é COMPATÍVEL COM O FORMATO DA OPENAI: `/chat/completions`,
// `Authorization: Bearer`, papéis `system|user|assistant|tool`, `tools` e
// `tool_calls`. Isso torna este arquivo o molde para qualquer outro provedor
// OpenAI-compatible que entre depois (basta trocar a base URL).
//
// ⚠️ ELE SÓ FAZ TEXTO. Não tem visão (a leitura de imagem existe apenas no
// chat.deepseek.com, não na API) e não tem áudio em forma nenhuma. É por isso
// que `AI_ROUTE_IMAGEM` e `AI_ROUTE_AUDIO` apontam para o Gemini: rotear
// imagem ou áudio para cá não quebra na configuração, quebra na chamada.
//
// ⚠️ NOME DE MODELO NÃO SE ADIVINHA AQUI. `deepseek-chat` e `deepseek-reasoner`
// foram descontinuados em 24/07/2026 em favor dos nomes da V4. O modelo vem
// SEMPRE de `AI_ROUTE_TEXTO` / `AI_MODEL`; sem ele, o provedor devolve
// `sem_modelo` em vez de chamar algo que o cliente não escolheu.
//
// A resposta do modelo é ENTRADA NÃO CONFIÁVEL e passa por zod antes de virar
// AiCompletion. NADA aqui lança. Ver o contrato em types.ts.

import axios from "axios";
import { z } from "zod";

import {
  AI_CONSTANTS,
  getAiMaxTokens,
  getAiTemperature,
  getAiTimeoutMs,
} from "./ai-constants";
import {
  classifyAxiosError,
  iterarSse,
  logarFalhaDoProvedor,
} from "./provider-http";
import type {
  AiChatInput,
  AiCompletion,
  AiFailureReason,
  AiMessage,
  AiProvider,
  AiToolCall,
  AiToolDefinition,
} from "./types";

export const DEEPSEEK_PROVIDER_NAME = "deepseek";

const logarFalha = (contexto: string, err: unknown) =>
  logarFalhaDoProvedor(DEEPSEEK_PROVIDER_NAME, contexto, err);

// ---------------------------------------------------------------------------
// Schemas. Tudo opcional: a API omite campos conforme o finish_reason, e campo
// ausente é caso NORMAL — `content` vem `null` sempre que há tool_calls.
// ---------------------------------------------------------------------------
const toolCallSchema = z.object({
  index: z.number().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      /** JSON **em string**. Pode chegar fatiado no streaming. */
      arguments: z.string().optional(),
    })
    .optional(),
});

const mensagemSchema = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const respostaSchema = z.object({
  choices: z
    .array(
      z.object({
        message: mensagemSchema.optional(),
        delta: mensagemSchema.optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

// ---------------------------------------------------------------------------
// Tradução das mensagens normalizadas para o dialeto OpenAI.
// ---------------------------------------------------------------------------
interface MensagemOpenAi {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * ⭐ O PONTO DELICADO DESTA TRADUÇÃO É O `tool_call_id`.
 *
 * O Gemini casa a resposta de uma tool com o pedido **pelo nome**. A API da
 * OpenAI casa **pelo id**, e recusa (HTTP 400) um `role:"tool"` sem
 * `tool_call_id` válido. Como o histórico do turno é montado uma vez e servido
 * aos dois provedores, o id precisa sobreviver.
 *
 * O orquestrador passou a preencher `toolCallId` (mudança aditiva: o Gemini
 * ignora o campo). Mas quem chega aqui sem id — histórico antigo, provedor
 * novo, teste — não pode simplesmente falhar: a reconstrução abaixo procura,
 * no último turno de assistant que pediu tools, uma chamada com o mesmo nome
 * ainda não usada. Cada id é consumido UMA vez, então duas chamadas à mesma
 * tool no mesmo turno recebem ids diferentes, na ordem em que foram pedidas.
 */
export function toDeepSeekMessages(messages: AiMessage[]): MensagemOpenAi[] {
  const saida: MensagemOpenAi[] = [];
  /** Ids anunciados pelo último assistant, por nome, ainda não consumidos. */
  let pendentes = new Map<string, string[]>();

  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      pendentes = new Map();
      for (const c of m.toolCalls) {
        const lista = pendentes.get(c.name) ?? [];
        lista.push(c.id);
        pendentes.set(c.name, lista);
      }
      saida.push({
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: {
            name: c.name,
            // A API quer os argumentos em STRING. O que temos é o objeto que o
            // modelo mandou; devolvê-lo serializado é a ida e volta correta.
            arguments:
              typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}),
          },
        })),
      });
      continue;
    }

    if (m.role === "tool") {
      const nome = m.toolName ?? "";
      let id = m.toolCallId;
      if (!id) {
        const lista = pendentes.get(nome);
        id = lista?.shift();
      }
      saida.push({
        role: "tool",
        content: m.content,
        // Sem id nenhum a API recusaria o turno inteiro. Um id sintético e
        // estável é melhor que 400: o pior caso é o modelo casar errado duas
        // respostas, e não o turno morrer.
        tool_call_id: id ?? `call_${nome || "desconhecida"}`,
      });
      continue;
    }

    saida.push({ role: m.role, content: m.content });
  }

  return saida;
}

/** Definições de tool no formato `{type:"function", function:{...}}`. */
export function toDeepSeekTools(tools: AiToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * `arguments` chega como STRING de JSON. Parse falho NÃO vira `{}`.
 *
 * ⚠️ Devolver `{}` seria falhar ABERTO: uma tool cujos argumentos são todos
 * opcionais executaria com filtro nenhum — uma consulta ampla, disparada por
 * um argumento corrompido. Devolvendo a string crua, o `.strict()` do
 * tool-runner rejeita (`argumentos_invalidos`) e nada roda, que é o caminho já
 * testado para argumento inválido.
 */
function parseArgs(bruto: string | undefined): unknown {
  const texto = (bruto ?? "").trim();
  if (!texto) return {};
  try {
    const v = JSON.parse(texto);
    return v && typeof v === "object" ? v : texto;
  } catch {
    return texto;
  }
}

export class DeepSeekProvider implements AiProvider {
  readonly name = DEEPSEEK_PROVIDER_NAME;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? "";
    this.model = opts?.model ?? "";
    this.baseUrl = opts?.baseUrl ?? AI_CONSTANTS.DEEPSEEK_BASE_URL;
  }

  /**
   * O corpo, montado uma vez só para `chat` e `chatStream`. Duas montagens
   * paralelas derivariam, e o modo streaming passaria a responder diferente do
   * normal — o mesmo cuidado do provedor do Gemini.
   */
  private montarCorpo(
    input: AiChatInput,
    streaming: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toDeepSeekMessages(input.messages),
      temperature: input.temperature ?? getAiTemperature(),
      max_tokens: input.maxTokens ?? getAiMaxTokens(),
    };
    if (input.tools?.length) body.tools = toDeepSeekTools(input.tools);
    if (streaming) {
      body.stream = true;
      // Sem isto o `usage` não vem no streaming e o custo do turno seria
      // gravado como desconhecido — logo depois de a contagem ter sido
      // corrigida para somar todas as chamadas. Campo padrão da API compatível.
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  /** Chave em header, NUNCA na query: a URL vaza em log de proxy e em stack. */
  private get cabecalhos(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  private falhar(
    started: number,
    reason: AiFailureReason,
    detail?: string,
  ): AiCompletion {
    return {
      ok: false,
      reason,
      detail,
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  async chat(input: AiChatInput): Promise<AiCompletion> {
    const started = Date.now();
    if (!this.apiKey) return this.falhar(started, "sem_api_key");
    if (!this.model) return this.falhar(started, "sem_modelo");

    let raw: unknown;
    try {
      const res = await axios.post(
        `${this.baseUrl}/chat/completions`,
        this.montarCorpo(input, false),
        { headers: this.cabecalhos, timeout: getAiTimeoutMs() },
      );
      raw = res.data;
    } catch (err) {
      logarFalha("chat/completions", err);
      const { reason, detail } = classifyAxiosError(err);
      return this.falhar(started, reason, detail);
    }

    const parsed = respostaSchema.safeParse(raw);
    if (!parsed.success) {
      return this.falhar(started, "resposta_invalida", "shape inesperado");
    }

    const escolha = parsed.data.choices?.[0];
    if (!escolha?.message) {
      return this.falhar(started, "resposta_invalida", "sem choices[0].message");
    }

    const chamadas: AiToolCall[] = [];
    for (const [i, c] of (escolha.message.tool_calls ?? []).entries()) {
      const nome = c.function?.name;
      if (!nome) continue;
      chamadas.push({
        id: c.id || `call_${i}`,
        name: nome,
        args: parseArgs(c.function?.arguments),
      });
    }

    return {
      ok: true,
      // `content` vem `null` quando o turno é só pedido de tool. Isso é normal,
      // e o orquestrador já trata texto vazio com tool_calls presentes.
      content: escolha.message.content ?? "",
      toolCalls: chamadas,
      usage: {
        inputTokens: parsed.data.usage?.prompt_tokens ?? null,
        outputTokens: parsed.data.usage?.completion_tokens ?? null,
      },
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * A mesma chamada, com `stream: true`. O envelope SSE é idêntico ao do
   * Gemini (`data: {json}`, terminado por `data: [DONE]`), então o leitor é o
   * mesmo — `iterarSse` de `provider-http.ts`.
   *
   * ⚠️ O `timeout` do axios em stream cobre só até a RESPOSTA COMEÇAR. Um
   * servidor que abre a conexão e emudece seguraria o socket e o turno para
   * sempre. Daí o teto de duração total, igual ao do Gemini.
   *
   * ⚠️ NO STREAMING, UM `tool_call` CHEGA EM PEDAÇOS. O `id` e o `name` vêm no
   * primeiro fragmento; os `arguments` vêm fatiados nos seguintes, e a única
   * coisa que amarra os fragmentos é o `index`. Concatenar por ordem de
   * chegada, sem olhar o índice, embaralha os argumentos de duas tools pedidas
   * no mesmo turno — e o resultado é uma consulta com o filtro da outra.
   */
  async chatStream(
    input: AiChatInput,
    onDelta: (texto: string) => void,
  ): Promise<AiCompletion> {
    const started = Date.now();
    if (!this.apiKey) return this.falhar(started, "sem_api_key");
    if (!this.model) return this.falhar(started, "sem_modelo");

    const limiteMs = getAiTimeoutMs();
    let stream: any;
    let estourouOTeto = false;

    try {
      const res = await axios.post(
        `${this.baseUrl}/chat/completions`,
        this.montarCorpo(input, true),
        {
          headers: this.cabecalhos,
          timeout: limiteMs,
          responseType: "stream",
        },
      );
      stream = res.data;
    } catch (err) {
      logarFalha("chat/completions (stream)", err);
      const { reason, detail } = classifyAxiosError(err);
      return this.falhar(started, reason, detail);
    }

    const relogio = setTimeout(() => {
      estourouOTeto = true;
      try {
        stream?.destroy?.();
      } catch {
        // destruir um stream já morto não é problema de ninguém.
      }
    }, limiteMs);

    let texto = "";
    let entrada: number | null = null;
    let saida: number | null = null;
    /** Fragmentos por `index`, exatamente como a API os numera. */
    const emMontagem = new Map<
      number,
      { id?: string; name?: string; args: string }
    >();

    try {
      for await (const evento of iterarSse(stream)) {
        const parsed = respostaSchema.safeParse(evento);
        // Evento de shape inesperado no meio de um stream é ruído, não o fim do
        // mundo: o que vale é o acumulado. Descartar um e seguir é melhor que
        // derrubar um turno que já entregou metade da resposta.
        if (!parsed.success) continue;

        const delta = parsed.data.choices?.[0]?.delta;
        if (delta?.content) {
          texto += delta.content;
          onDelta(delta.content);
        }

        for (const [i, frag] of (delta?.tool_calls ?? []).entries()) {
          const idx = frag.index ?? i;
          const atual = emMontagem.get(idx) ?? { args: "" };
          if (frag.id) atual.id = frag.id;
          if (frag.function?.name) atual.name = frag.function.name;
          if (frag.function?.arguments) atual.args += frag.function.arguments;
          emMontagem.set(idx, atual);
        }

        // O uso vem no ÚLTIMO evento (graças a `include_usage`); sobrescrever a
        // cada um deixa o valor final correto sem precisar saber qual era o
        // último.
        if (parsed.data.usage) {
          entrada = parsed.data.usage.prompt_tokens ?? entrada;
          saida = parsed.data.usage.completion_tokens ?? saida;
        }
      }
    } catch (err) {
      if (estourouOTeto) {
        return this.falhar(started, "timeout", `teto de ${limiteMs}ms`);
      }
      logarFalha("leitura do stream", err);
      const { reason, detail } = classifyAxiosError(err);
      return this.falhar(started, reason, detail);
    } finally {
      clearTimeout(relogio);
    }

    if (estourouOTeto) {
      return this.falhar(started, "timeout", `teto de ${limiteMs}ms`);
    }

    const chamadas: AiToolCall[] = [...emMontagem.entries()]
      // Ordem pelo índice da API, não pela ordem de chegada dos fragmentos.
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => !!c.name)
      .map(([idx, c]) => ({
        id: c.id || `call_${idx}`,
        name: c.name as string,
        args: parseArgs(c.args),
      }));

    return {
      ok: true,
      content: texto,
      toolCalls: chamadas,
      usage: { inputTokens: entrada, outputTokens: saida },
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

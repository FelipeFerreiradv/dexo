// Provedor Gemini via REST puro (axios), sem SDK.
//
// POR QUE REST E NÃO SDK: a casa já fala REST com ML, Shopee, Magalu, Focus e
// SEFAZ por axios puro — um SDK aqui seria a exceção, não a regra. Ganhos
// concretos: zero KB de dependência nova na API, endpoint novo é mudança de
// string (não espera release do SDK), e o mock dos testes é `vi.mock("axios")`,
// que é o padrão de todos os *-api.service.ts do repositório.
//
// A resposta do modelo é ENTRADA NÃO CONFIÁVEL e passa por zod antes de virar
// AiCompletion (REGRA 12). Um `candidates[0].content.parts` com shape
// inesperado vira `resposta_invalida`, não um crash e não um `undefined`
// vazando para o banco.
//
// NADA aqui lança. Ver o contrato em types.ts.

import axios from "axios";
import { z } from "zod";

import {
  AI_CONSTANTS,
  getAiApiKey,
  getAiMaxTokens,
  getAiModel,
  getAiTemperature,
  getAiTimeoutMs,
} from "./ai-constants";
import type {
  AiChatInput,
  AiCompletion,
  AiFailureReason,
  AiMessage,
  AiProvider,
  AiToolCall,
} from "./types";

export const GEMINI_PROVIDER_NAME = "gemini";

// ---------------------------------------------------------------------------
// Schema da resposta. Tudo opcional de propósito: a API omite campos conforme
// o finishReason, e um campo ausente é um caso NORMAL, não um erro.
// ---------------------------------------------------------------------------
const functionCallSchema = z.object({
  name: z.string(),
  args: z.unknown().optional(),
});

const partSchema = z.object({
  text: z.string().optional(),
  functionCall: functionCallSchema.optional(),
  /**
   * Carimbo do raciocínio do modelo. Opaco para nós — o valor precisa apenas
   * voltar inalterado no histórico. Ver `AiToolCall.providerSignature`.
   */
  thoughtSignature: z.string().optional(),
});

const candidateSchema = z.object({
  content: z.object({ parts: z.array(partSchema).optional() }).optional(),
  finishReason: z.string().optional(),
});

const geminiResponseSchema = z.object({
  candidates: z.array(candidateSchema).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

// ---------------------------------------------------------------------------
// Tradução das mensagens normalizadas para o dialeto do Gemini.
// ---------------------------------------------------------------------------
interface GeminiContent {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
}

/**
 * O Gemini só conhece os papéis "user" e "model", e leva o system separado em
 * `systemInstruction`. Resultado de tool vai como functionResponse com role
 * "user" — é assim que a API espera receber de volta.
 */
export function toGeminiContents(messages: AiMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemTexts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? "desconhecida",
              // A API exige objeto; o conteúdo da tool é string para nós.
              response: { resultado: m.content },
            },
          },
        ],
      });
      continue;
    }

    // Turno do modelo que PEDIU tools: o `functionCall` volta como estava. A
    // API casa o functionResponse seguinte pelo nome, e um turno de texto vazio
    // no lugar do pedido deixaria a conversa sem par.
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls) {
        // ⭐ O carimbo volta NA MESMA parte do functionCall — é assim que a API
        // o associa ao pedido. Sem ele, o Gemini 3.x recusa o turno inteiro.
        parts.push({
          functionCall: { name: call.name, args: call.args ?? {} },
          ...(call.providerSignature
            ? { thoughtSignature: call.providerSignature }
            : {}),
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    // Parte de texto vazia é recusada pela API; um turno sem conteúdo e sem
    // tool não acrescenta nada ao histórico.
    if (!m.content) continue;

    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  return {
    contents,
    systemInstruction: systemTexts.length
      ? { parts: [{ text: systemTexts.join("\n\n") }] }
      : undefined,
  };
}

/**
 * Log de diagnóstico no SERVIDOR, com o motivo que o Google devolveu.
 *
 * Sem isto, um turno degradado é indistinguível de outro: o usuário vê sempre
 * "Não consegui responder agora" e o `detail` guardado é só `HTTP 400`. Foi
 * exatamente o que aconteceu no primeiro teste com chave real — o motivo
 * verdadeiro ("este modelo não está mais disponível para novos usuários")
 * existia na resposta e não chegava a ninguém.
 *
 * O que entra no log é `error.message` do Google, que é a descrição do
 * problema. NÃO entra a URL (carrega a chave em algumas formas de chamada),
 * não entra o corpo enviado (carrega o prompt, com dado do cliente), e nada
 * disto vai para o `detail` que o orquestrador persiste — `ai-secret-leak.spec.ts`
 * continua provando isso.
 */
function logarFalhaDoProvedor(contexto: string, err: unknown): void {
  const e = err as any;
  const status = e?.response?.status;
  const corpo = e?.response?.data;

  const escrever = (motivo: unknown) =>
    console.error(
      `[bitz-gemini] ${contexto} falhou: HTTP ${status ?? "-"} ${e?.code ?? ""} — ${String(motivo).slice(0, 400)}`,
    );

  // ⚠️ Em `responseType: "stream"`, o corpo do ERRO também vem como stream — e
  // não como JSON já parseado. Sem drenar, todo 400 do caminho de streaming
  // aparece como "Request failed with status code 400" e o motivo real (que o
  // Google manda) some. Foi assim que uma falha de payload ficou opaca no
  // primeiro teste com chave real.
  if (corpo && typeof corpo.on === "function") {
    let texto = "";
    corpo.on("data", (c: unknown) => {
      texto += String(c);
    });
    corpo.on("end", () => {
      try {
        escrever(JSON.parse(texto)?.error?.message ?? texto);
      } catch {
        escrever(texto);
      }
    });
    corpo.on("error", () => escrever(e?.message ?? "sem descrição"));
    return;
  }

  escrever(corpo?.error?.message ?? e?.message ?? "sem descrição");
}

/** Classifica a falha SEM vazar corpo de resposta nem a chave para o log. */
function classifyAxiosError(err: unknown): {
  reason: AiFailureReason;
  detail: string;
} {
  const anyErr = err as any;
  const code = anyErr?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return { reason: "timeout", detail: `timeout (${code})` };
  }
  const status = anyErr?.response?.status;
  if (status === 429) {
    return { reason: "rate_limit_provedor", detail: "HTTP 429" };
  }
  if (typeof status === "number") {
    // Só o status. O corpo pode ecoar trecho do prompt — que carrega dado do
    // cliente — e a URL carrega a chave na query string.
    return { reason: "erro_provedor", detail: `HTTP ${status}` };
  }
  return {
    reason: "erro_provedor",
    detail: code ? String(code) : "erro de rede",
  };
}

export class GeminiProvider implements AiProvider {
  readonly name = GEMINI_PROVIDER_NAME;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? getAiApiKey() ?? "";
    this.model = opts?.model ?? getAiModel() ?? "";
    this.baseUrl = opts?.baseUrl ?? AI_CONSTANTS.GEMINI_BASE_URL;
  }

  /**
   * O corpo da requisição. Extraído para `chat` e `chatStream` mandarem
   * EXATAMENTE o mesmo payload — só o endpoint muda. Duas montagens paralelas
   * derivariam, e o modo streaming passaria a responder diferente do normal.
   */
  private montarCorpo(input: AiChatInput): Record<string, unknown> {
    const { contents, systemInstruction } = toGeminiContents(input.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: input.temperature ?? getAiTemperature(),
        maxOutputTokens: input.maxTokens ?? getAiMaxTokens(),
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (input.tools?.length) {
      body.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }
    return body;
  }

  /** Chave em header, NUNCA na query: a URL vaza em log de proxy e em stack. */
  private get cabecalhos(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-goog-api-key": this.apiKey,
    };
  }

  async chat(input: AiChatInput): Promise<AiCompletion> {
    const started = Date.now();
    const fail = (reason: AiFailureReason, detail?: string): AiCompletion => ({
      ok: false,
      reason,
      detail,
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    });

    if (!this.apiKey) return fail("sem_api_key");
    if (!this.model) return fail("sem_modelo");

    const body = this.montarCorpo(input);

    let raw: unknown;
    try {
      const res = await axios.post(
        `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
        body,
        {
          headers: this.cabecalhos,
          timeout: getAiTimeoutMs(),
        },
      );
      raw = res.data;
    } catch (err) {
      logarFalhaDoProvedor("generateContent", err);
      const { reason, detail } = classifyAxiosError(err);
      return fail(reason, detail);
    }

    const parsed = geminiResponseSchema.safeParse(raw);
    if (!parsed.success) return fail("resposta_invalida", "shape inesperado");

    const data = parsed.data;
    if (data.promptFeedback?.blockReason) {
      return fail(
        "resposta_invalida",
        `bloqueado: ${data.promptFeedback.blockReason}`,
      );
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const content = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    const toolCalls: AiToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        // A API não devolve id de chamada; geramos um estável por posição.
        id: `${p.functionCall!.name}-${i}`,
        name: p.functionCall!.name,
        args: p.functionCall!.args ?? {},
        ...(p.thoughtSignature
          ? { providerSignature: p.thoughtSignature }
          : {}),
      }));

    // Sem texto E sem tool call é resposta vazia — tratar como falha para o
    // orquestrador degradar, em vez de gravar uma mensagem em branco.
    if (!content && toolCalls.length === 0) {
      return fail("resposta_invalida", "resposta vazia");
    }

    return {
      ok: true,
      content,
      toolCalls,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? null,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      },
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * A mesma chamada, no endpoint de streaming (`:streamGenerateContent`, SSE).
   *
   * O que muda em relação a `chat`: o endpoint, `responseType: "stream"` e o
   * laço que lê os eventos. O CORPO é o mesmo (`montarCorpo`), então o modelo
   * recebe exatamente o mesmo prompt, as mesmas tools e a mesma configuração.
   *
   * ⚠️ O `timeout` do axios em stream cobre só até a RESPOSTA COMEÇAR. Depois
   * disso ele não vale mais, e um servidor que abre a conexão e para de falar
   * seguraria o socket e o turno para sempre. Por isso o teto total abaixo, que
   * destrói o stream e devolve `timeout` como qualquer outra falha.
   */
  async chatStream(
    input: AiChatInput,
    onDelta: (texto: string) => void,
  ): Promise<AiCompletion> {
    const started = Date.now();
    const fail = (reason: AiFailureReason, detail?: string): AiCompletion => ({
      ok: false,
      reason,
      detail,
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    });

    if (!this.apiKey) return fail("sem_api_key");
    if (!this.model) return fail("sem_modelo");

    const limiteMs = getAiTimeoutMs();
    let stream: any;
    let estourouOTeto = false;

    try {
      const res = await axios.post(
        `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`,
        this.montarCorpo(input),
        {
          headers: this.cabecalhos,
          timeout: limiteMs,
          responseType: "stream",
        },
      );
      stream = res.data;
    } catch (err) {
      logarFalhaDoProvedor("streamGenerateContent", err);
      const { reason, detail } = classifyAxiosError(err);
      return fail(reason, detail);
    }

    // Teto de duração TOTAL, contado a partir daqui.
    const relogio = setTimeout(() => {
      estourouOTeto = true;
      try {
        stream?.destroy?.();
      } catch {
        // destruir um stream já morto não é problema de ninguém.
      }
    }, limiteMs);

    let texto = "";
    const chamadas: AiToolCall[] = [];
    let entrada: number | null = null;
    let saida: number | null = null;
    let bloqueio: string | null = null;

    try {
      for await (const evento of iterarSse(stream)) {
        const parsed = geminiResponseSchema.safeParse(evento);
        // Evento com shape inesperado no meio de um stream é ruído, não o fim
        // do mundo: o que vale é o acumulado. Descartar um e seguir é melhor
        // que derrubar um turno que já entregou metade da resposta.
        if (!parsed.success) continue;

        const data = parsed.data;
        if (data.promptFeedback?.blockReason) {
          bloqueio = data.promptFeedback.blockReason;
          break;
        }

        for (const parte of data.candidates?.[0]?.content?.parts ?? []) {
          if (parte.text) {
            texto += parte.text;
            onDelta(parte.text);
          }
          if (parte.functionCall) {
            chamadas.push({
              id: `${parte.functionCall.name}-${chamadas.length}`,
              name: parte.functionCall.name,
              args: parte.functionCall.args ?? {},
              ...(parte.thoughtSignature
                ? { providerSignature: parte.thoughtSignature }
                : {}),
            });
          } else if (parte.thoughtSignature && chamadas.length > 0) {
            // No streaming o carimbo pode chegar numa parte SOZINHA, depois do
            // pedido. Nesse caso ele pertence à última chamada anunciada.
            const ultima = chamadas[chamadas.length - 1];
            if (!ultima.providerSignature) {
              ultima.providerSignature = parte.thoughtSignature;
            }
          }
        }

        // O uso vem no ÚLTIMO evento; sobrescrever a cada um deixa o valor
        // final correto sem precisar saber qual era o último.
        if (data.usageMetadata) {
          entrada = data.usageMetadata.promptTokenCount ?? entrada;
          saida = data.usageMetadata.candidatesTokenCount ?? saida;
        }
      }
    } catch (err) {
      if (estourouOTeto) return fail("timeout", `teto de ${limiteMs}ms`);
      logarFalhaDoProvedor("leitura do stream", err);
      const { reason, detail } = classifyAxiosError(err);
      return fail(reason, detail);
    } finally {
      clearTimeout(relogio);
    }

    if (estourouOTeto) return fail("timeout", `teto de ${limiteMs}ms`);
    if (bloqueio) return fail("resposta_invalida", `bloqueado: ${bloqueio}`);

    const content = texto.trim();
    if (!content && chamadas.length === 0) {
      return fail("resposta_invalida", "resposta vazia");
    }

    return {
      ok: true,
      content,
      toolCalls: chamadas,
      usage: { inputTokens: entrada, outputTokens: saida },
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Lê um corpo SSE (`data: {json}` separados por linha em branco) e devolve
 * cada payload já parseado.
 *
 * Escrito à mão, e não com uma biblioteca de SSE, pelo mesmo motivo do
 * conversor de zod→JSON Schema: o caso geral do protocolo tem retry, `event:`,
 * `id:` e reconexão, e nada disso existe aqui — a resposta do Gemini é uma
 * sequência de `data:` e acabou.
 *
 * ⚠️ O ponto que quebra implementação ingênua: um chunk de rede NÃO é uma
 * linha. Ele parte no meio de um JSON. O buffer existe para isso, e é por isso
 * que o `split` guarda sempre o último pedaço para o próximo chunk.
 */
export async function* iterarSse(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    const linhas = buffer.split("\n");
    // A última pode estar cortada no meio: volta para o buffer.
    buffer = linhas.pop() ?? "";
    for (const linha of linhas) {
      const payload = extrairData(linha);
      if (payload !== null) yield payload;
    }
  }
  const resto = extrairData(buffer);
  if (resto !== null) yield resto;
}

/** `data: {...}` -> objeto. Qualquer outra coisa (comentário, vazio) -> null. */
function extrairData(linha: string): unknown | null {
  const limpa = linha.trim();
  if (!limpa.startsWith("data:")) return null;
  const corpo = limpa.slice(5).trim();
  if (!corpo || corpo === "[DONE]") return null;
  try {
    return JSON.parse(corpo);
  } catch {
    return null;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
vi.mock("axios", () => ({
  default: { post: (...args: any[]) => postMock(...args) },
}));

import {
  GeminiProvider,
  toGeminiContents,
} from "../app/ai/core/gemini.provider";
import {
  MockAiProvider,
  __pendingMockCompletions,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";
import {
  resolveAiProvider,
  userFacingFailureMessage,
} from "../app/ai/core/provider";
import type { AiMessage } from "../app/ai/core/types";

// ===========================================================================
// Camada de provedor. O invariante que atravessa TUDO aqui: chat() NUNCA
// lança. Provedor fora do ar, timeout, 4xx/5xx, resposta malformada — tudo
// vira { ok:false, reason }. É isso que permite ao ERP não sentir nada quando
// a IA cai.
// ===========================================================================

describe("MockAiProvider — determinístico e offline", () => {
  beforeEach(() => {
    __resetMockProvider();
  });

  it("modo eco: mesma entrada, mesma saída, sem rede", async () => {
    const p = new MockAiProvider();
    const messages: AiMessage[] = [{ role: "user", content: "quanto vendi?" }];

    const a = await p.chat({ messages });
    const b = await p.chat({ messages });

    expect(a).toEqual(b);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("fila: devolve exatamente o que o teste empilhou, em ordem", async () => {
    const p = new MockAiProvider();
    __pushMockCompletion({ content: "primeira" });
    __pushMockCompletion({ content: "segunda" });

    const a = await p.chat({ messages: [] });
    const b = await p.chat({ messages: [] });

    expect(a.ok && a.content).toBe("primeira");
    expect(b.ok && b.content).toBe("segunda");
    expect(__pendingMockCompletions()).toBe(0);
  });

  it("fila aceita falha, para exercitar o caminho degradado", async () => {
    const p = new MockAiProvider();
    __pushMockCompletion({ ok: false, reason: "timeout" });

    const res = await p.chat({ messages: [] });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe("timeout");
  });
});

describe("toGeminiContents — tradução de papéis", () => {
  it("system sai do array e vira systemInstruction", () => {
    const { contents, systemInstruction } = toGeminiContents([
      { role: "system", content: "voce e o bitz" },
      { role: "user", content: "oi" },
    ]);

    expect(systemInstruction?.parts[0].text).toBe("voce e o bitz");
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("user");
  });

  it("assistant vira model (o Gemini não conhece 'assistant')", () => {
    const { contents } = toGeminiContents([
      { role: "user", content: "oi" },
      { role: "assistant", content: "ola" },
    ]);

    expect(contents.map((c) => c.role)).toEqual(["user", "model"]);
  });

  it("tool vira functionResponse com role user", () => {
    const { contents } = toGeminiContents([
      { role: "tool", toolName: "buscar_produto", content: "3 encontrados" },
    ]);

    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0]).toHaveProperty("functionResponse");
  });
});

describe("GeminiProvider — nunca lança, sempre classifica", () => {
  beforeEach(() => {
    postMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const provider = () =>
    new GeminiProvider({ apiKey: "k", model: "m", baseUrl: "https://x" });

  // AxiosError estende Error na vida real. Rejeitar com objeto simples além de
  // irrealista deixa uma promise pendente que o vitest reporta como rejeição
  // não-tratada, mascarando o resultado do teste.
  const axiosError = (props: Record<string, unknown>): Error =>
    Object.assign(new Error("falha simulada do axios"), props);

  it("sem apiKey: sem_api_key, sem tocar a rede", async () => {
    const res = await new GeminiProvider({ apiKey: "", model: "m" }).chat({
      messages: [],
    });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe("sem_api_key");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sem modelo: sem_modelo", async () => {
    const res = await new GeminiProvider({ apiKey: "k", model: "" }).chat({
      messages: [],
    });

    expect(!res.ok && res.reason).toBe("sem_modelo");
  });

  it("resposta feliz: extrai texto e tokens", async () => {
    postMock.mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: "Vendeu R$ 10." }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 9 },
      },
    });

    const res = await provider().chat({ messages: [] });

    expect(res.ok).toBe(true);
    expect(res.ok && res.content).toBe("Vendeu R$ 10.");
    expect(res.ok && res.usage).toEqual({ inputTokens: 120, outputTokens: 9 });
  });

  it("a chave vai em HEADER, nunca na URL (log de proxy vazaria)", async () => {
    postMock.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    });

    await provider().chat({ messages: [] });

    const [url, , config] = postMock.mock.calls[0];
    expect(String(url)).not.toContain("k");
    expect(config.headers["x-goog-api-key"]).toBe("k");
  });

  it("functionCall vira toolCall", async () => {
    postMock.mockResolvedValue({
      data: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "buscar_produto", args: { q: "mola" } },
                },
              ],
            },
          },
        ],
      },
    });

    const res = await provider().chat({ messages: [] });

    expect(res.ok).toBe(true);
    expect(res.ok && res.toolCalls).toEqual([
      { id: "buscar_produto-0", name: "buscar_produto", args: { q: "mola" } },
    ]);
  });

  it("timeout do axios: reason timeout", async () => {
    postMock.mockRejectedValueOnce(axiosError({ code: "ECONNABORTED" }));

    const res = await provider().chat({ messages: [] });

    expect(!res.ok && res.reason).toBe("timeout");
  });

  it("429: reason rate_limit_provedor", async () => {
    postMock.mockRejectedValueOnce(axiosError({ response: { status: 429 } }));

    const res = await provider().chat({ messages: [] });

    expect(!res.ok && res.reason).toBe("rate_limit_provedor");
  });

  it("500: erro_provedor com SÓ o status no detail (corpo pode ter dado do cliente)", async () => {
    postMock.mockRejectedValueOnce(
      axiosError({
        response: { status: 500, data: { erro: "prompt: CPF 123.456.789-00" } },
      }),
    );

    const res = await provider().chat({ messages: [] });

    expect(!res.ok && res.reason).toBe("erro_provedor");
    expect(!res.ok && res.detail).toBe("HTTP 500");
    expect(!res.ok && res.detail).not.toContain("CPF");
  });

  it("shape inesperado: resposta_invalida (resposta de LLM é entrada não confiável)", async () => {
    postMock.mockResolvedValue({ data: { candidates: "isto não é array" } });

    const res = await provider().chat({ messages: [] });

    expect(!res.ok && res.reason).toBe("resposta_invalida");
  });

  it("resposta vazia (sem texto e sem tool): resposta_invalida", async () => {
    postMock.mockResolvedValue({
      data: { candidates: [{ content: { parts: [] } }] },
    });

    const res = await provider().chat({ messages: [] });

    expect(!res.ok && res.reason).toBe("resposta_invalida");
  });

  it("promptFeedback.blockReason: resposta_invalida", async () => {
    postMock.mockResolvedValue({
      data: { promptFeedback: { blockReason: "SAFETY" } },
    });

    const res = await provider().chat({ messages: [] });

    expect(!res.ok && res.reason).toBe("resposta_invalida");
  });
});

describe("resolveAiProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("módulo desligado: null (quem chama degrada, não quebra)", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "");
    expect(resolveAiProvider()).toBeNull();
  });

  it("flag ligada sem AI_PROVIDER: cai no mock, que não toca rede", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.stubEnv("AI_PROVIDER", "");
    expect(resolveAiProvider()?.name).toBe("mock");
  });

  it("gemini sem chave: null", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "");
    expect(resolveAiProvider()).toBeNull();
  });

  it("gemini configurado: instancia o GeminiProvider", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "chave");
    vi.stubEnv("AI_MODEL", "modelo-x");
    const p = resolveAiProvider();
    expect(p?.name).toBe("gemini");
    expect(p?.model).toBe("modelo-x");
  });
});

describe("userFacingFailureMessage — nunca vaza detalhe técnico", () => {
  const reasons = [
    "modulo_desligado",
    "sem_api_key",
    "sem_modelo",
    "provedor_desconhecido",
    "timeout",
    "rate_limit_provedor",
    "erro_provedor",
    "resposta_invalida",
  ] as const;

  it.each(reasons)("%s: mensagem legível, sem jargão nem status", (reason) => {
    const msg = userFacingFailureMessage(reason);
    expect(msg.length).toBeGreaterThan(10);
    expect(msg).not.toMatch(/HTTP|api_key|token|gemini|null|undefined/i);
  });
});

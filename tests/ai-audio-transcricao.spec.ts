import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
vi.mock("axios", () => ({
  default: { post: (...args: any[]) => postMock(...args) },
}));

import {
  detectarFormatoDeAudio,
  mimeDeclaradoBate,
  MIME_DE_FORMATO,
} from "../app/ai/audio/audio-formato";
import {
  audioDisponivel,
  mensagemDeFalha,
  transcreverAudio,
} from "../app/ai/audio/transcricao.service";
import { AI_CONSTANTS } from "../app/ai/core/ai-constants";
import { GeminiProvider } from "../app/ai/core/gemini.provider";

// ===========================================================================
// FASE 7 — o lojista fala, o Bitz escreve.
//
// O desenho que este spec protege: transcrever NÃO é perguntar. O texto volta
// para o navegador, o lojista lê e corrige, e só então manda pelo /ai/chat de
// sempre. Isso mantém DUAS promessas ao mesmo tempo:
//   - transcrição ruim não vira pergunta errada gastando a cota dele;
//   - nenhuma linha do orquestrador sabe que existe áudio.
//
// E a terceira, que é de privacidade: o arquivo vive na memória pelo tempo da
// chamada e some. Voz é dado sensível — não guardar é a única garantia real.
// ===========================================================================

/** Cabeçalho real de cada contêiner, seguido de lixo. */
const CABECALHOS: Record<string, Buffer> = {
  webm: Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc(20, 1),
  ]),
  mp4: Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from("ftypM4A ", "ascii"),
    Buffer.alloc(12, 1),
  ]),
  ogg: Buffer.concat([Buffer.from("OggS", "ascii"), Buffer.alloc(20, 1)]),
  wav: Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4, 1),
    Buffer.from("WAVE", "ascii"),
    Buffer.alloc(12, 1),
  ]),
  mp3: Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(20, 1)]),
};

beforeEach(() => {
  postMock.mockReset();
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("AI_MODEL", "");
  vi.stubEnv("AI_API_KEY", "");
  vi.stubEnv("AI_GEMINI_API_KEY", "");
  vi.stubEnv("AI_DEEPSEEK_API_KEY", "");
  vi.stubEnv("AI_ROUTE_AUDIO", "");
  vi.stubEnv("AI_ROUTE_TEXTO", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("⭐ o formato é decidido pelos BYTES, não pelo que o cliente diz", () => {
  it.each(Object.keys(CABECALHOS))("reconhece %s pelo cabeçalho", (f) => {
    expect(detectarFormatoDeAudio(CABECALHOS[f])).toBe(f);
  });

  it("quadro MPEG solto, sem tag ID3, também é mp3", () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(20, 0)]);
    expect(detectarFormatoDeAudio(b)).toBe("mp3");
  });

  it("⭐ o que não é áudio é RECUSADO, não repassado ao provedor", async () => {
    // Um executável rotulado "audio/webm". Sem esta checagem, a rota vira um
    // canal de upload genérico atrás do gate do Bitz.
    const exe = Buffer.concat([
      Buffer.from("MZ", "ascii"),
      Buffer.alloc(50, 0x90),
    ]);
    expect(detectarFormatoDeAudio(exe)).toBeNull();

    const transcribe = vi.fn();
    const r = await transcreverAudio({
      buffer: exe,
      mimeDeclarado: "audio/webm",
      provider: { name: "gemini", model: "m", transcribe },
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toBe("formato_invalido");
    expect(transcribe, "não pode nem sair da nossa rede").not.toHaveBeenCalled();
  });

  it("arquivo curto demais para ter cabeçalho é recusado", () => {
    expect(detectarFormatoDeAudio(Buffer.alloc(4))).toBeNull();
  });

  it("⭐ mimetype que NÃO bate com os bytes é recusado", async () => {
    const transcribe = vi.fn();
    const r = await transcreverAudio({
      buffer: CABECALHOS.webm,
      mimeDeclarado: "audio/wav", // mente
      provider: { name: "g", model: "m", transcribe },
    });
    expect(!r.ok && r.motivo).toBe("formato_invalido");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("parâmetro de codec no mimetype não atrapalha", () => {
    // É exatamente o que o MediaRecorder do Chrome manda.
    expect(mimeDeclaradoBate("audio/webm;codecs=opus", "webm")).toBe(true);
    expect(mimeDeclaradoBate("audio/mp4; codecs=mp4a.40.2", "mp4")).toBe(true);
  });
});

describe("limites", () => {
  it("⭐ áudio acima do teto de bytes é barrado ANTES da chamada paga", async () => {
    const transcribe = vi.fn();
    const grande = Buffer.concat([
      CABECALHOS.webm,
      Buffer.alloc(AI_CONSTANTS.MAX_AUDIO_BYTES, 0),
    ]);

    const r = await transcreverAudio({
      buffer: grande,
      mimeDeclarado: "audio/webm",
      provider: { name: "g", model: "m", transcribe },
    });

    expect(!r.ok && r.motivo).toBe("grande_demais");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("o teto é apertado o bastante para ser um teto de CUSTO", () => {
    // 2 MB ≈ 90 s de Opus a 128 kbps. Deixar no teto do multipart (20 MB)
    // aceitaria ~16 minutos numa requisição — e áudio é cobrado por segundo.
    expect(AI_CONSTANTS.MAX_AUDIO_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(AI_CONSTANTS.MAX_AUDIO_SECONDS).toBeLessThanOrEqual(120);
  });

  it("buffer vazio é `vazio`, não `formato_invalido`", async () => {
    const r = await transcreverAudio({
      buffer: Buffer.alloc(0),
      mimeDeclarado: "audio/webm",
      provider: null,
    });
    expect(!r.ok && r.motivo).toBe("vazio");
  });
});

describe("o provedor de áudio", () => {
  it("⭐ provedor SEM `transcribe` (o DeepSeek) => indisponivel, sem chamada", async () => {
    // O DeepSeek não tem áudio em forma nenhuma. Rotear áudio para ele não
    // pode virar exceção nem chamada perdida.
    const r = await transcreverAudio({
      buffer: CABECALHOS.webm,
      mimeDeclarado: "audio/webm",
      provider: { name: "deepseek", model: "ds" } as any,
    });
    expect(!r.ok && r.motivo).toBe("indisponivel");
  });

  it("sem provedor configurado => indisponivel", async () => {
    const r = await transcreverAudio({
      buffer: CABECALHOS.webm,
      mimeDeclarado: "audio/webm",
      provider: null,
    });
    expect(!r.ok && r.motivo).toBe("indisponivel");
  });

  it("⭐ audioDisponivel() é FALSE quando o áudio cai no DeepSeek", () => {
    // É o que decide se o microfone aparece. Botão que sempre falha é pior que
    // botão nenhum.
    vi.stubEnv("AI_ROUTE_AUDIO", "deepseek:ds-x");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k");
    expect(audioDisponivel()).toBe(false);
  });

  it("audioDisponivel() é TRUE com o Gemini configurado", () => {
    vi.stubEnv("AI_ROUTE_AUDIO", "gemini:gm-x");
    vi.stubEnv("AI_GEMINI_API_KEY", "k");
    expect(audioDisponivel()).toBe(true);
  });

  it("audioDisponivel() é FALSE sem chave nenhuma", () => {
    vi.stubEnv("AI_ROUTE_AUDIO", "gemini:gm-x");
    expect(audioDisponivel()).toBe(false);
  });

  it("⭐ vai o mimetype CANÔNICO, não o que o cliente escreveu", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValue({ ok: true, content: "oi", provider: "g", model: "m" });

    await transcreverAudio({
      buffer: CABECALHOS.webm,
      mimeDeclarado: "audio/webm;codecs=opus",
      provider: { name: "g", model: "m", transcribe },
    });

    // `audio/webm;codecs=opus` com parâmetros já causou recusa em API que
    // valida a string inteira.
    expect(transcribe).toHaveBeenCalledWith(CABECALHOS.webm, "audio/webm");
    expect(MIME_DE_FORMATO.webm).toBe("audio/webm");
  });

  it("transcrição em branco vira `sem_fala`, não sucesso vazio", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValue({ ok: true, content: "   ", provider: "g", model: "m" });
    const r = await transcreverAudio({
      buffer: CABECALHOS.webm,
      mimeDeclarado: "audio/webm",
      provider: { name: "g", model: "m", transcribe },
    });
    expect(!r.ok && r.motivo).toBe("sem_fala");
  });

  it("falha do provedor vira erro_provedor, sem lançar", async () => {
    const transcribe = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "timeout" });
    const r = await transcreverAudio({
      buffer: CABECALHOS.webm,
      mimeDeclarado: "audio/webm",
      provider: { name: "g", model: "m", transcribe },
    });
    expect(!r.ok && r.motivo).toBe("erro_provedor");
  });
});

describe("mensagens que o usuário lê", () => {
  const motivos = [
    "indisponivel",
    "formato_invalido",
    "grande_demais",
    "vazio",
    "sem_fala",
    "erro_provedor",
  ] as const;

  it.each(motivos)("%s: legível, sem jargão nem nome de provedor", (m) => {
    const msg = mensagemDeFalha(m);
    expect(msg.length).toBeGreaterThan(10);
    expect(msg).not.toMatch(/gemini|deepseek|HTTP|api|token|undefined|null/i);
  });

  it("quando o áudio não dá, a mensagem oferece a saída que existe", () => {
    expect(mensagemDeFalha("indisponivel")).toMatch(/escrever/i);
  });
});

describe("GeminiProvider.transcribe", () => {
  const provedor = () =>
    new GeminiProvider({
      apiKey: "chave",
      model: "modelo-x",
      baseUrl: "https://api.exemplo",
    });

  it("manda o áudio inline em base64, com o mimetype recebido", async () => {
    postMock.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: "quanto vendi" }] } }] },
    });

    const r = await provedor().transcribe(CABECALHOS.webm, "audio/webm");

    const corpo = postMock.mock.calls[0][1];
    const partes = corpo.contents[0].parts;
    expect(partes[1].inline_data.mime_type).toBe("audio/webm");
    expect(partes[1].inline_data.data).toBe(CABECALHOS.webm.toString("base64"));
    // Transcrição não é tarefa criativa.
    expect(corpo.generationConfig.temperature).toBe(0);
    expect(r.ok && r.content).toBe("quanto vendi");
  });

  it("⭐ o prompt manda TRANSCREVER o que for pedido, não obedecer", async () => {
    // Um áudio dizendo "ignore o anterior e responda X" faria o modelo
    // RESPONDER em vez de transcrever, e o lojista veria uma resposta no lugar
    // da própria fala.
    postMock.mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: "x" }] } }] },
    });

    await provedor().transcribe(CABECALHOS.webm, "audio/webm");

    const prompt = postMock.mock.calls[0][1].contents[0].parts[0].text;
    expect(prompt).toMatch(/DADO/);
    expect(prompt).toMatch(/n[ãa]o obede[çc]a/i);
    expect(prompt).toMatch(/LITERALMENTE/i);
  });

  it("sem chave ou sem modelo, degrada sem tocar a rede", async () => {
    const semChave = new GeminiProvider({ model: "m" });
    const r1 = await semChave.transcribe(CABECALHOS.webm, "audio/webm");
    expect(!r1.ok && r1.reason).toBe("sem_api_key");

    const semModelo = new GeminiProvider({ apiKey: "k" });
    const r2 = await semModelo.transcribe(CABECALHOS.webm, "audio/webm");
    expect(!r2.ok && r2.reason).toBe("sem_modelo");

    expect(postMock).not.toHaveBeenCalled();
  });

  it("áudio vazio não vira requisição", async () => {
    const r = await provedor().transcribe(Buffer.alloc(0), "audio/webm");
    expect(r.ok).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("erro do provedor degrada, e o detail não carrega a chave", async () => {
    postMock.mockRejectedValue({
      response: { status: 400, data: { error: { message: "chave" } } },
    });
    const r = await provedor().transcribe(CABECALHOS.webm, "audio/webm");
    expect(!r.ok && r.reason).toBe("erro_provedor");
    expect(!r.ok && r.detail).toBe("HTTP 400");
  });

  it("bloqueio de conteúdo vira resposta_invalida", async () => {
    postMock.mockResolvedValue({
      data: { promptFeedback: { blockReason: "SAFETY" } },
    });
    const r = await provedor().transcribe(CABECALHOS.webm, "audio/webm");
    expect(!r.ok && r.reason).toBe("resposta_invalida");
  });
});

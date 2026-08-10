import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import FormData from "form-data";

let currentUser: { id: string; dataOwnerId: string } | null = null;
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = currentUser;
  },
}));

const findUniqueMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: { user: { findUnique: (...a: any[]) => findUniqueMock(...a) } },
}));

const transcreverMock = vi.fn();
const audioDisponivelMock = vi.fn();
vi.mock("../app/ai/audio/transcricao.service", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    audioDisponivel: () => audioDisponivelMock(),
    transcreverAudio: (...a: any[]) => transcreverMock(...a),
  };
});

const reservarMock = vi.fn();
const devolverMock = vi.fn();
vi.mock("../app/ai/quota/ai-usage.service", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    reserveAiTranscription: (...a: any[]) => reservarMock(...a),
    refundAiTranscription: (...a: any[]) => devolverMock(...a),
  };
});

import { aiRoutes } from "../app/routes/ai.routes";
import { AI_CONSTANTS } from "../app/ai/core/ai-constants";
import { clearAiEntitlementCache } from "../app/ai/entitlement/ai-entitlement.service";

// ===========================================================================
// POST /ai/audio — a rota da Fase 7.
//
// Ela NÃO responde à pergunta: devolve o TEXTO, o lojista lê e corrige, e só
// então manda pelo /ai/chat de sempre. Por isso nenhum teste aqui espera
// resposta do agente.
//
// O que este spec protege, em ordem de importância:
//   1. o gate — sem plano, 403, e nada é chamado;
//   2. a cota — nunca uma chamada paga sem reserva, nunca uma reserva perdida
//      quando não houve gasto;
//   3. o teto de bytes — a rota não pode virar canal de upload genérico.
// ===========================================================================

const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(64, 1),
]);

function corpoComAudio(buffer: Buffer, mime = "audio/webm") {
  const form = new FormData();
  form.append("audio", buffer, { filename: "fala.webm", contentType: mime });
  return { payload: form, headers: form.getHeaders() };
}

describe("POST /ai/audio", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = { id: "u1", dataOwnerId: "t1" };
    findUniqueMock.mockReset();
    transcreverMock.mockReset();
    audioDisponivelMock.mockReset().mockReturnValue(true);
    reservarMock.mockReset().mockResolvedValue({ ok: true });
    devolverMock.mockReset().mockResolvedValue(undefined);
    clearAiEntitlementCache();

    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    findUniqueMock.mockResolvedValue({
      aiEnabledAt: new Date(),
      aiDailyLimit: null,
    });

    app = fastify();
    await app.register(fastifyMultipart, {
      limits: { fileSize: 20 * 1024 * 1024 },
    });
    await app.register(aiRoutes, { prefix: "/ai" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("⭐ sem plano: 403, e nada é reservado nem transcrito", async () => {
    findUniqueMock.mockResolvedValue({ aiEnabledAt: null, aiDailyLimit: null });
    clearAiEntitlementCache();

    const { payload, headers } = corpoComAudio(WEBM);
    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    expect(res.statusCode).toBe(403);
    expect(reservarMock).not.toHaveBeenCalled();
    expect(transcreverMock).not.toHaveBeenCalled();
  });

  it("⭐ o caminho feliz devolve TEXTO — nunca resposta do agente", async () => {
    transcreverMock.mockResolvedValue({ ok: true, texto: "quanto eu vendi" });

    const { payload, headers } = corpoComAudio(WEBM);
    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, texto: "quanto eu vendi" });
    // A rota não conversa: quem responde é o /ai/chat, depois, com o texto que
    // o lojista confirmou.
    expect(res.json()).not.toHaveProperty("content");
    expect(res.json()).not.toHaveProperty("conversationId");
  });

  it("⭐ arquivo que não é áudio é barrado ANTES de reservar cota", async () => {
    const exe = Buffer.concat([
      Buffer.from("MZ", "ascii"),
      Buffer.alloc(64, 0x90),
    ]);
    const { payload, headers } = corpoComAudio(exe);

    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    expect(res.statusCode).toBe(400);
    // Arquivo inválido não pode consumir a cota de ninguém.
    expect(reservarMock).not.toHaveBeenCalled();
    expect(transcreverMock).not.toHaveBeenCalled();
  });

  it("⭐ teto de cota batido: 200 com mensagem, sem chamada paga", async () => {
    reservarMock.mockResolvedValue({ ok: false, denied: "tenant" });

    const { payload, headers } = corpoComAudio(WEBM);
    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    // 200 e não 4xx: teto batido é estado de negócio, e o front mostra no chat.
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(String(res.json().error)).toMatch(/limite de áudios/i);
    expect(transcreverMock).not.toHaveBeenCalled();
  });

  it("⭐ falha SEM custo devolve a cota reservada", async () => {
    transcreverMock.mockResolvedValue({ ok: false, motivo: "sem_fala" });

    const { payload, headers } = corpoComAudio(WEBM);
    await app.inject({ method: "POST", url: "/ai/audio", payload, headers });

    // O lojista vai regravar — não pode ter perdido a tentativa.
    expect(devolverMock).toHaveBeenCalledWith({ dataOwnerId: "t1" });
  });

  it("⭐ falha DEPOIS de chamar o provedor NÃO devolve a cota", async () => {
    transcreverMock.mockResolvedValue({
      ok: false,
      motivo: "erro_provedor",
      detalhe: "timeout",
    });

    const { payload, headers } = corpoComAudio(WEBM);
    await app.inject({ method: "POST", url: "/ai/audio", payload, headers });

    // O provedor já foi chamado: devolver aqui seria o mesmo vazamento de
    // dinheiro que o refund do turno já teve.
    expect(devolverMock).not.toHaveBeenCalled();
  });

  it("requisição sem arquivo nenhum: 400", async () => {
    const form = new FormData();
    form.append("nada", "x");
    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(reservarMock).not.toHaveBeenCalled();
  });

  it("⭐ áudio acima do teto da ROTA é recusado, mesmo cabendo no global", async () => {
    // O multipart global aceita 20 MB. Esta rota impõe o seu próprio teto por
    // requisição — sem tocar no registro global, que é regra da casa.
    const grande = Buffer.concat([
      WEBM,
      Buffer.alloc(AI_CONSTANTS.MAX_AUDIO_BYTES + 1024, 0),
    ]);
    const { payload, headers } = corpoComAudio(grande);

    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    expect(res.statusCode).toBe(400);
    expect(reservarMock).not.toHaveBeenCalled();
    expect(transcreverMock).not.toHaveBeenCalled();
  });

  it("o mimetype declarado chega ao serviço para ser conferido", async () => {
    transcreverMock.mockResolvedValue({ ok: true, texto: "ok" });
    // O MediaRecorder do Chrome manda exatamente isto, com o parâmetro.
    const { payload, headers } = corpoComAudio(WEBM, "audio/webm;codecs=opus");

    await app.inject({ method: "POST", url: "/ai/audio", payload, headers });

    // ⚠️ O busboy JÁ TIRA os parâmetros: chega `audio/webm`, não
    // `audio/webm;codecs=opus`. `mimeDeclaradoBate` corta o `;` de qualquer
    // jeito — o cliente pode ser outro (um `curl`, um app) e mandar a string
    // inteira.
    expect(transcreverMock).toHaveBeenCalledWith(
      expect.objectContaining({ mimeDeclarado: "audio/webm" }),
    );
  });
});

describe("GET /ai/capacidades", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = { id: "u1", dataOwnerId: "t1" };
    findUniqueMock.mockReset().mockResolvedValue({
      aiEnabledAt: new Date(),
      aiDailyLimit: null,
    });
    audioDisponivelMock.mockReset().mockReturnValue(true);
    clearAiEntitlementCache();
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
    // ⚠️ `anexosDisponiveis()` lê a configuração de verdade, e o `.env` do
    // worktree tem provedor configurado. Sem fixar isto, a lista de extensões
    // mudaria conforme a máquina — e o teste provaria outra coisa. Com o mock,
    // que não tem `describeImage`, sobra só o `.xml`: ler NF-e não depende de
    // provedor nenhum.
    vi.stubEnv("AI_PROVIDER", "mock");

    app = fastify();
    await app.register(aiRoutes, { prefix: "/ai" });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("diz se o microfone deve aparecer", async () => {
    const res = await app.inject({ method: "GET", url: "/ai/capacidades" });
    expect(res.statusCode).toBe(200);
    // `memorias` entrou na Fase 11: o botão "o que eu sei da sua loja" só
    // aparece para o administrador, e quem decide é o servidor. O `currentUser`
    // deste arquivo não tem `parentUserId`, logo é administrador.
    expect(res.json()).toEqual({
      audio: true,
      anexos: [".xml"],
      memorias: true,
    });
  });

  it("⭐ áudio indisponível => false, e o chat segue inteiro", async () => {
    audioDisponivelMock.mockReturnValue(false);
    const res = await app.inject({ method: "GET", url: "/ai/capacidades" });
    expect(res.json()).toEqual({
      audio: false,
      anexos: [".xml"],
      memorias: true,
    });
  });

  it("⭐ sem modelo de visão, o clipe ainda oferece XML de NF-e — e só ele", async () => {
    // A regra que isto prende: `anexos` NÃO é booleano. Um servidor sem visão
    // continua sabendo ler nota fiscal, porque quem lê é o `parseNfeXml`, local
    // e puro. Fazer a capacidade ser "sim/não" apagaria essa metade.
    const res = await app.inject({ method: "GET", url: "/ai/capacidades" });
    const anexos = res.json().anexos as string[];
    expect(anexos).toContain(".xml");
    expect(anexos).not.toContain(".jpg");
    expect(anexos).not.toContain(".png");
  });

  it("⭐ NÃO revela provedor, modelo nem chave", async () => {
    const res = await app.inject({ method: "GET", url: "/ai/capacidades" });
    expect(res.body).not.toMatch(/gemini|deepseek|model|key/i);
  });

  it("sem plano: 403 como as demais rotas de /ai/*", async () => {
    findUniqueMock.mockResolvedValue({ aiEnabledAt: null, aiDailyLimit: null });
    clearAiEntitlementCache();
    const res = await app.inject({ method: "GET", url: "/ai/capacidades" });
    expect(res.statusCode).toBe(403);
  });
});

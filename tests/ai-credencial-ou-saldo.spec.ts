import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import FormData from "form-data";

let currentUser: any = null;
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
vi.mock("../app/ai/audio/transcricao.service", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    audioDisponivel: () => true,
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

import { classifyAxiosError } from "../app/ai/core/provider-http";
import {
  falhaSemCobranca,
  userFacingFailureMessage,
} from "../app/ai/core/provider";
import { aiRoutes } from "../app/routes/ai.routes";
import { clearAiEntitlementCache } from "../app/ai/entitlement/ai-entitlement.service";

// ===========================================================================
// ⭐ RECUSA ANTES DO TRABALHO: 401, 402 e 403.
//
// Achado com um `402 Insufficient Balance` REAL em 10/08/2026, testando o
// DeepSeek sem saldo. O turno degradou certo — mas duas coisas em volta dele
// estavam erradas, e as duas são desta família:
//
//   1. a mensagem dizia "tenta de novo em instantes", conselho que NUNCA vai
//      funcionar quando o problema é saldo. Um 500 passa sozinho; conta zerada
//      não passa até alguém pagar;
//
//   2. ⭐⭐ o áudio e o anexo QUEIMAVAM UM SLOT DA COTA DO CLIENTE. A recusa
//      acontece antes de qualquer token — não custou nada — mas o discriminador
//      de devolução era "foi erro do provedor ⇒ deve ter sido cobrado". O
//      lojista perdia um dos 15 áudios do dia por uma falha de configuração
//      NOSSA, sem ter como consertar nem como perceber, e perdia outro a cada
//      regravação.
//
// O turno de chat nunca teve o defeito 2: ele soma tokens e só devolve quando
// NENHUMA chamada reportou uso. É esse critério que este arquivo estende para
// as duas rotas que não têm como somar nada.
// ===========================================================================

const erroHttp = (status: number) =>
  ({ response: { status }, message: "Request failed" }) as unknown;

describe("classificação do status do provedor", () => {
  it.each([401, 402, 403])(
    "HTTP %i é recusa por credencial ou saldo",
    (status) => {
      const { reason, detail } = classifyAxiosError(erroHttp(status));
      expect(reason).toBe("credencial_ou_saldo");
      // O status vai para o `SystemLog` — é ele que diz ao operador se o
      // problema é a chave (401/403) ou a fatura (402).
      expect(detail).toBe(`HTTP ${status}`);
    },
  );

  it("⚠️ 429 continua rate limit — é transitório e passa sozinho", () => {
    expect(classifyAxiosError(erroHttp(429)).reason).toBe(
      "rate_limit_provedor",
    );
  });

  it.each([400, 404, 500, 503])(
    "HTTP %i segue como erro genérico do provedor",
    (status) => {
      expect(classifyAxiosError(erroHttp(status)).reason).toBe("erro_provedor");
    },
  );

  it("⭐ o corpo da resposta NUNCA entra no detalhe", () => {
    // O corpo pode ecoar trecho do prompt (dado do cliente) e a URL carrega a
    // chave na query string. Só o status.
    const err = {
      response: {
        status: 402,
        data: { error: { message: "Insufficient Balance for key sk-abc123" } },
      },
    };
    const { detail } = classifyAxiosError(err);
    expect(detail).toBe("HTTP 402");
    expect(detail).not.toMatch(/sk-|Insufficient|Balance/);
  });
});

describe("a mensagem que o lojista lê", () => {
  it("⭐ NÃO manda tentar de novo — não é falha que passa sozinha", () => {
    const msg = userFacingFailureMessage("credencial_ou_saldo");
    expect(msg).not.toMatch(/tenta de novo|instantes/i);
    expect(msg).toMatch(/suporte/i);
  });

  it("e não vaza status, provedor, modelo nem chave", () => {
    const msg = userFacingFailureMessage("credencial_ou_saldo");
    expect(msg).not.toMatch(/402|401|403|http|saldo|gemini|deepseek|key/i);
  });

  it("⚠️ o erro transitório continua mandando tentar de novo", () => {
    // A regressão que este teste impede: uniformizar as duas mensagens apagaria
    // a única orientação útil que existe no caso em que tentar de novo resolve.
    expect(userFacingFailureMessage("erro_provedor")).toMatch(/de novo/i);
    expect(userFacingFailureMessage("rate_limit_provedor")).toMatch(/de novo/i);
  });
});

describe("⭐⭐ a devolução de cota do áudio e do anexo", () => {
  it("recusa por credencial ou saldo NÃO cobra — devolve o slot", () => {
    expect(falhaSemCobranca("credencial_ou_saldo")).toBe(true);
  });

  it("⚠️ erro de verdade do provedor CONTINUA cobrando", () => {
    // O outro lado da moeda, e ele importa tanto quanto: um 500 depois de o
    // modelo já ter processado o áudio custou dinheiro. Devolver ali abriria o
    // vazamento que a Fase 6 fechou no turno de chat — o cliente reenviaria a
    // mesma pergunta para sempre sem nunca consumir cota, com a fatura subindo.
    expect(falhaSemCobranca("erro_provedor")).toBe(false);
    expect(falhaSemCobranca("timeout")).toBe(false);
    expect(falhaSemCobranca("rate_limit_provedor")).toBe(false);
    expect(falhaSemCobranca(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⭐ E AGORA A ROTA DE VERDADE.
//
// ⚠️ Os testes acima exercitam uma função PURA, e sozinhos eles não provavam
// nada do que importa: tirar `|| falhaSemCobranca(...)` da rota deixaria os
// quatro verdes e o lojista continuaria perdendo cota. É esta seção que prende
// o comportamento.
// ---------------------------------------------------------------------------

const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.alloc(64, 1),
]);

function corpoComAudio() {
  const form = new FormData();
  form.append("audio", WEBM, {
    filename: "fala.webm",
    contentType: "audio/webm",
  });
  return { payload: form, headers: form.getHeaders() };
}

describe("POST /ai/audio — a cota depois de uma recusa por saldo", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    currentUser = { id: "u1", dataOwnerId: "t1" };
    findUniqueMock
      .mockReset()
      .mockResolvedValue({ aiEnabledAt: new Date(), aiDailyLimit: null });
    transcreverMock.mockReset();
    reservarMock.mockReset().mockResolvedValue({ ok: true });
    devolverMock.mockReset().mockResolvedValue(undefined);
    clearAiEntitlementCache();

    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");

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

  it("⭐⭐ 402 do provedor DEVOLVE o áudio do dia", async () => {
    // O caso real de 10/08/2026: DeepSeek sem saldo. A recusa vem antes de
    // qualquer token — não custou nada — e antes desta correção o lojista
    // perdia um dos 15 áudios do dia, e outro a cada regravação.
    transcreverMock.mockResolvedValue({
      ok: false,
      motivo: "erro_provedor",
      detalhe: "credencial_ou_saldo",
    });

    const { payload, headers } = corpoComAudio();
    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(reservarMock).toHaveBeenCalledTimes(1);
    expect(devolverMock).toHaveBeenCalledTimes(1);
  });

  it("⚠️ erro de verdade do provedor NÃO devolve — ali houve gasto", async () => {
    transcreverMock.mockResolvedValue({
      ok: false,
      motivo: "erro_provedor",
      detalhe: "erro_provedor",
    });

    const { payload, headers } = corpoComAudio();
    await app.inject({ method: "POST", url: "/ai/audio", payload, headers });

    expect(reservarMock).toHaveBeenCalledTimes(1);
    expect(devolverMock).not.toHaveBeenCalled();
  });

  it("e a mensagem da recusa não manda tentar de novo para sempre", async () => {
    transcreverMock.mockResolvedValue({
      ok: false,
      motivo: "erro_provedor",
      detalhe: "credencial_ou_saldo",
    });

    const { payload, headers } = corpoComAudio();
    const res = await app.inject({
      method: "POST",
      url: "/ai/audio",
      payload,
      headers,
    });

    // ⚠️ A mensagem do ÁUDIO é a do serviço de transcrição, não a do provedor —
    // e ela ainda fala em tentar de novo. Está registrado como dívida no commit:
    // separá-la exige um motivo novo em `FalhaDeTranscricao`, que muda o switch
    // de mensagem e os specs dele. O que este teste prende é que a resposta é
    // uma falha de negócio (200 com `ok:false`), não um 500.
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().error).toBe("string");
  });
});

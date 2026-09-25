import { describe, it, expect, afterEach, vi } from "vitest";

import { FocusNfeV2Client } from "../../../app/fiscal/providers/focus-nfe-v2.client";

// Cliente Focus V2 — cancelamento (DELETE /v2/{nfe|nfce}/{ref}).
// Sucesso só com HTTP 200 + status "cancelado" + cStat 135/155: até 25/09/2026 o V1 contava
// QUALQUER 200 como sucesso e deixava a nota CANCELLED com o evento recusado pela SEFAZ; hoje
// o V1 trata "erro_cancelamento" como falha, exceto 218/420 ("já cancelada"), que lá são
// sucesso idempotente (aqui na V2 seguem falha).
// Nunca lança, nunca vaza o token.

const TOKEN = "tok_SEGREDO_focus_9f8e7d6c5b4a";
const TOKEN_B64 = Buffer.from(`${TOKEN}:`).toString("base64");
const REF = "cmu4gzo2q0q4en7";
const JUSTIFICATIVA = "Cancelamento por erro de digitacao no pedido";

type Chamada = { url: string; init: RequestInit };

function cliente(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { ambiente?: "HOMOLOGACAO" | "PRODUCAO"; modelo?: "55" | "65" } = {},
) {
  const chamadas: Chamada[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    chamadas.push({ url: String(input), init: init ?? {} });
    return responder(String(input), init ?? {});
  }) as typeof fetch;
  const c = new FocusNfeV2Client(opts.ambiente ?? "HOMOLOGACAO", opts.modelo ?? "55", { fetchImpl: impl });
  return { c, chamadas };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("FocusNfeV2Client.cancelar — requisição", () => {
  it("DELETE na ref (escapada), JSON com a justificativa, Basic auth e timeout", async () => {
    const { c, chamadas } = cliente(() => json(200, { status: "cancelado", status_sefaz: "135" }));
    await c.cancelar("cmu4 gzo2/q0?&x", JUSTIFICATIVA, TOKEN);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe("https://homologacao.focusnfe.com.br/v2/nfe/cmu4%20gzo2%2Fq0%3F%26x");
    expect(chamadas[0].init.method).toBe("DELETE");
    expect(JSON.parse(String(chamadas[0].init.body))).toEqual({ justificativa: JUSTIFICATIVA });
    const headers = chamadas[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${TOKEN_B64}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(chamadas[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("NFC-e cancela em /v2/nfce e produção usa api.focusnfe.com.br", async () => {
    const { c, chamadas } = cliente(() => json(200, { status: "cancelado", status_sefaz: "135" }), { ambiente: "PRODUCAO", modelo: "65" });
    await c.cancelar(REF, JUSTIFICATIVA, TOKEN);
    expect(chamadas[0].url).toBe(`https://api.focusnfe.com.br/v2/nfce/${REF}`);
  });
});

describe("FocusNfeV2Client.cancelar — sucesso só com prova do evento", () => {
  it.each([
    ["135 (no prazo)", "135"],
    ["155 (fora do prazo, homologado)", "155"],
  ])("200 'cancelado' cStat %s ⇒ sucesso com protocolo", async (_nome, cStat) => {
    const { c } = cliente(() => json(200, { status: "cancelado", status_sefaz: cStat, mensagem_sefaz: "Evento registrado e vinculado a NF-e", protocolo: "135260000000009" }));
    const r = await c.cancelar(REF, JUSTIFICATIVA, TOKEN);
    expect(r).toMatchObject({ sucesso: true, protocolo: "135260000000009", cStat: Number(cStat), httpStatus: 200, transporte: null });
  });

  it.each([
    ["erro_cancelamento (SEFAZ 501)", 200, { status: "erro_cancelamento", status_sefaz: "501", mensagem_sefaz: "Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao" }, "Prazo de cancelamento"],
    ["200 'cancelado' com cStat 136 (evento não vinculado)", 200, { status: "cancelado", status_sefaz: "136" }, "sem confirmação"],
    ["200 ainda processando", 200, { status: "processando_cancelamento" }, "sem confirmação"],
    ["200 sem corpo JSON", 200, null, "sem confirmação"],
    ["422 requisicao_invalida", 422, { codigo: "requisicao_invalida", mensagem: "Justificativa deve ter entre 15 e 255 caracteres" }, "Justificativa deve ter"],
    ["404 ref inexistente", 404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" }, "Nota fiscal não encontrada"],
    ["401 (corpo HTML)", 401, undefined, "HTTP 401"],
  ])("%s ⇒ falha", async (_nome, status, body, trecho) => {
    const { c } = cliente(() =>
      body === undefined
        ? new Response("<html>HTTP Basic: Access denied.</html>", { status, headers: { "content-type": "text/html" } })
        : body === null
          ? new Response("", { status, headers: { "content-type": "application/json" } })
          : json(status, body),
    );
    const r = await c.cancelar(REF, JUSTIFICATIVA, TOKEN);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain(trecho as string);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("timeout/rede: nunca lança e pede consulta (transporte preenchido)", async () => {
    const { c } = cliente(() => { throw Object.assign(new Error("abort"), { name: "TimeoutError" }); });
    const r = await c.cancelar(REF, JUSTIFICATIVA, TOKEN);
    expect(r).toMatchObject({ sucesso: false, transporte: "TIMEOUT", httpStatus: null, protocolo: null });
    expect(r.mensagem).toContain("consulte a situação");
  });

  it("protocolo_sefaz também é aceito como protocolo do evento", async () => {
    const { c } = cliente(() => json(200, { status: "cancelado", status_sefaz: 135, protocolo_sefaz: "135260000000777" }));
    const r = await c.cancelar(REF, JUSTIFICATIVA, TOKEN);
    expect(r).toMatchObject({ sucesso: true, protocolo: "135260000000777", cStat: 135 });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  emitNfceForReceivable,
  nfceToastFor,
} from "../app/pdv/lib/pdv-nfce";

// ──────────────────────────────────────────────────────────
// REGRESSÃO (incidente em PROD, 2026-07-17): o helper declarava
// "Content-Type: application/json" num POST SEM body. O Fastify rejeita isso
// na fase de parse (FST_ERR_CTP_EMPTY_JSON_BODY, 400) ANTES do handler, e o
// handler global responde { error: "Erro interno do servidor" } — o toast do
// PDV mostrava exatamente isso. O contrato pinado aqui: POST sem body NÃO
// envia Content-Type (mesmo padrão do POST /pay).
// ──────────────────────────────────────────────────────────

const fetchMock = vi.fn();
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

function okResponse(nfce: any) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ nfce }),
  };
}

describe("emitNfceForReceivable — shape da requisição", () => {
  it("POST sem body NÃO envia Content-Type (senão o Fastify 400a no parse)", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ state: "authorized", nfeId: "n1", numero: 1 }),
    );

    await emitNfceForReceivable("r-1", "user@test.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/finance/receivables/r-1/nfce");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    const headerKeys = Object.keys(init.headers ?? {}).map((h) =>
      h.toLowerCase(),
    );
    expect(headerKeys).not.toContain("content-type");
    expect(init.headers.email).toBe("user@test.com");
  });

  it("sucesso → { ok: true, nfce } e toast de autorizada", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ state: "authorized", nfeId: "n1", numero: 7 }),
    );
    const outcome = await emitNfceForReceivable("r-1", "user@test.com");
    expect(outcome.ok).toBe(true);
    const t = nfceToastFor(outcome);
    expect(t.type).toBe("success");
    expect(t.message).toContain("7");
  });

  it("HTTP !ok → { ok: false } com a mensagem do body; NUNCA lança", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "CSC nao configurado" }),
    });
    const outcome = await emitNfceForReceivable("r-1", "user@test.com");
    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: "CSC nao configurado",
    });
    expect(nfceToastFor(outcome).type).toBe("warning");
  });

  it("erro de rede → { ok: false, status: 0 }; NUNCA lança", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const outcome = await emitNfceForReceivable("r-1", "user@test.com");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(0);
  });
});

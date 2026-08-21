import { describe, it, expect, vi } from "vitest";

import { marcarConversaLida } from "@/app/mensagens/lib/mark-read";

/**
 * O defeito original (H2 do diagnóstico de 21/08/2026): o efeito do ChatPane
 * fazia o POST /read SEM checar `res.ok` e chamava `onAfterRead` sempre. Um
 * 401/404/5xx zerava o badge na tela e o poll de 30 s o trazia de volta — o
 * "some e volta" relatado pela cliente.
 *
 * A invariante travada aqui: SÓ um 2xx autoriza zerar o contador.
 */

/** Resposta mínima com o shape que o módulo consome. */
function resposta(status: number, corpo: unknown = { updated: 2 }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as unknown as Response;
}

const BASE = {
  apiBase: "https://api.exemplo",
  accountId: "acc-1",
  itemId: "MLB123",
  headers: { email: "u@x.com" },
};

describe("marcarConversaLida", () => {
  it("200: confirma e devolve quantas linhas o servidor marcou", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, { updated: 3 }));
    const r = await marcarConversaLida({ ...BASE, fetchImpl: fetchImpl as any });
    expect(r).toEqual({ confirmada: true, atualizadas: 3 });
  });

  it("monta a URL do endpoint com o itemId escapado, via POST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200));
    await marcarConversaLida({
      ...BASE,
      itemId: "conv/1",
      fetchImpl: fetchImpl as any,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://api.exemplo/messages/conversations/conv%2F1/read?accountId=acc-1",
    );
    expect(init.method).toBe("POST");
  });

  it.each([400, 401, 403, 404, 409, 500, 502])(
    "%i: NÃO confirma — o badge não pode zerar",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(resposta(status));
      const r = await marcarConversaLida({
        ...BASE,
        fetchImpl: fetchImpl as any,
      });
      expect(r.confirmada).toBe(false);
      expect(r).toMatchObject({ motivo: "http", detalhe: `HTTP ${status}` });
    },
  );

  it("falha de rede: NÃO confirma (motivo rede)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await marcarConversaLida({ ...BASE, fetchImpl: fetchImpl as any });
    expect(r).toMatchObject({ confirmada: false, motivo: "rede" });
  });

  it("abortada: motivo próprio — o chamador não deve retentar nem avisar", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const fetchImpl = vi.fn().mockRejectedValue(abortErr);
    const r = await marcarConversaLida({ ...BASE, fetchImpl: fetchImpl as any });
    expect(r).toEqual({ confirmada: false, motivo: "abortada" });
  });

  it("2xx com corpo ilegível ainda CONFIRMA (o servidor já gravou)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    const r = await marcarConversaLida({ ...BASE, fetchImpl: fetchImpl as any });
    expect(r).toEqual({ confirmada: true, atualizadas: 0 });
  });

  it("updated 0 (não havia nada por marcar) ainda é confirmação", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, { updated: 0 }));
    const r = await marcarConversaLida({ ...BASE, fetchImpl: fetchImpl as any });
    expect(r).toEqual({ confirmada: true, atualizadas: 0 });
  });
});

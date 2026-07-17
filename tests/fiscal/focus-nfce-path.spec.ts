import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { FocusNfeProvider } from "../../app/fiscal/providers/focus-nfe.provider";
import { createNfeProvider } from "../../app/fiscal/providers/provider-factory";

// NFC-e via Focus: o modelo escolhe o path (/v2/nfce). REGRESSÃO: default e
// modelo ausente ⇒ /v2/nfe em TODOS os métodos (comportamento atual intacto).

const calls: Array<{ url: string; method?: string }> = [];
const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as any;

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return okJson({ status: "autorizado" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FocusNfeProvider — path por modelo", () => {
  it("modelo 65 usa /v2/nfce em emitir/consultar/buscarXml/cancelar", async () => {
    const p = new FocusNfeProvider("homologacao", "65");
    await p.emitir({ nfeData: {}, token: "t", ref: "ref-1" });
    await p.consultar("ref-1", "t");
    await p.buscarXml("ref-1", "t");
    await p.cancelar({ ref: "ref-1", chaveAcesso: "x", protocolo: "p", justificativa: "cancelamento de teste valido", token: "t" } as any);

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.url).toContain("/v2/nfce");
      expect(c.url).not.toContain("/v2/nfe/");
    }
  });

  it("REGRESSAO: default (sem modelo) usa /v2/nfe em todos os metodos", async () => {
    const p = new FocusNfeProvider("homologacao");
    await p.emitir({ nfeData: {}, token: "t", ref: "ref-1" });
    await p.consultar("ref-1", "t");
    await p.buscarXml("ref-1", "t");

    expect(calls.every((c) => c.url.includes("/v2/nfe"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/v2/nfce"))).toBe(false);
  });

  it("inutilizar SEMPRE usa /v2/nfe/inutilizacao (65 fora de escopo)", async () => {
    const p = new FocusNfeProvider("homologacao", "65");
    await p.inutilizar({
      ambiente: "homologacao",
      cnpj: "11222333000181",
      serie: 1,
      numeroInicial: 1,
      numeroFinal: 2,
      justificativa: "justificativa valida de teste",
      token: "t",
    } as any);
    expect(calls[0].url).toContain("/v2/nfe/inutilizacao");
  });

  it("factory: opts.modelo chega ao provider; ausente ⇒ 55", async () => {
    const p65 = createNfeProvider("FOCUS_NFE", "HOMOLOGACAO", { modelo: "65" });
    await p65.emitir({ nfeData: {}, token: "t", ref: "r" });
    expect(calls[0].url).toContain("/v2/nfce");

    calls.length = 0;
    const p55 = createNfeProvider("FOCUS_NFE", "HOMOLOGACAO");
    await p55.emitir({ nfeData: {}, token: "t", ref: "r" });
    expect(calls[0].url).toContain("/v2/nfe?");
  });
});

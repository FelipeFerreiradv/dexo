// BLOCO H — histórico da venda: o lado do navegador.
//
// A tela desenha; QUEM DECIDE é `sale-timeline-client.ts`. Este spec pina as
// decisões, e três delas são invariantes de verdade:
//
//  1. TIPO DESCONHECIDO NÃO SOME. O backend guarda `type` como texto de
//     propósito, para que um tipo novo não exija `ALTER TYPE`. Uma tela que só
//     sabe lidar com os 5 tipos de hoje anularia essa escolha — e um evento
//     invisível é pior que um evento feio.
//  2. `details` É JSONB — pode conter qualquer coisa (inclusive lixo de uma
//     versão futura). Nada ali pode quebrar a renderização.
//  3. FUSO FIXO. A hora do evento não pode variar com o relógio da máquina que
//     abre a página, senão SSR e browser divergem (hydration).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getApiBaseUrl: () => "http://api.test",
}));

import {
  SALE_TIMELINE_PAGE_SIZE,
  fetchSaleTimeline,
  formatEventWhen,
  isSaleTimelineUiEnabled,
  saleEventActor,
  saleEventDetailLine,
  saleEventLabel,
  saleEventTone,
} from "../app/financeiro/lib/sale-timeline-client";

describe("Flag de UI — o botão só existe quando ligado", () => {
  it("ausente na suíte ⇒ desligado (o padrão é não mudar nada)", () => {
    expect(isSaleTimelineUiEnabled()).toBe(false);
  });

  it("só a string exata 'true' liga", async () => {
    const ORIG = process.env.NEXT_PUBLIC_SALE_TIMELINE_ENABLED;
    try {
      // A flag é lida no TOPO do módulo (referência literal a
      // process.env.NEXT_PUBLIC_*, para o Next inlinar no bundle). Testá-la
      // exige reimportar com o env já posto — mudar depois não teria efeito,
      // que é exatamente o comportamento em produção.
      process.env.NEXT_PUBLIC_SALE_TIMELINE_ENABLED = "1";
      vi.resetModules();
      const um = await import("../app/financeiro/lib/sale-timeline-client");
      expect(um.isSaleTimelineUiEnabled()).toBe(false);

      process.env.NEXT_PUBLIC_SALE_TIMELINE_ENABLED = "true";
      vi.resetModules();
      const dois = await import("../app/financeiro/lib/sale-timeline-client");
      expect(dois.isSaleTimelineUiEnabled()).toBe(true);
    } finally {
      if (ORIG === undefined)
        delete process.env.NEXT_PUBLIC_SALE_TIMELINE_ENABLED;
      else process.env.NEXT_PUBLIC_SALE_TIMELINE_ENABLED = ORIG;
      vi.resetModules();
    }
  });
});

describe("Rótulo e tom — tipo desconhecido nunca some", () => {
  it("traduz os tipos conhecidos", () => {
    expect(saleEventLabel("CREATED")).toBe("Criada");
    expect(saleEventLabel("UPDATED")).toBe("Alterada");
    expect(saleEventLabel("PAID")).toBe("Recebida");
    expect(saleEventLabel("REVERSED")).toBe("Cancelada");
    expect(saleEventLabel("FISCAL_EMITTED")).toBe("Nota fiscal");
  });

  it("tipo novo aparece CRU, não vira '—' nem desaparece", () => {
    // Se um dia o backend gravar "SHIPPED", a linha tem de continuar visível.
    expect(saleEventLabel("SHIPPED")).toBe("SHIPPED");
    expect(saleEventTone("SHIPPED")).toBe("neutral");
  });

  it("o tom acompanha a natureza do evento", () => {
    expect(saleEventTone("PAID")).toBe("success");
    expect(saleEventTone("REVERSED")).toBe("danger");
    expect(saleEventTone("CREATED")).toBe("neutral");
  });
});

describe("Linha de detalhe — acrescenta, nunca repete", () => {
  it("CREATED soma valor e forma (a mensagem já diz os itens)", () => {
    expect(
      saleEventDetailLine("CREATED", {
        totalAmount: 1234.5,
        itemCount: 3,
        paymentMethod: "DINHEIRO",
      }),
    ).toBe("R$ 1.234,50 · Dinheiro");
  });

  it("UPDATED devolve null — a mensagem já lista os campos alterados", () => {
    // `Venda alterada: Valor total, Multa` + a MESMA lista logo abaixo seria
    // ruído puro.
    expect(
      saleEventDetailLine("UPDATED", { fields: ["Valor total"] }),
    ).toBeNull();
  });

  it("PAID conta os produtos baixados, e some quando são zero", () => {
    expect(
      saleEventDetailLine("PAID", { totalAmount: 200, productsDeducted: 2 }),
    ).toBe("R$ 200,00 · 2 produtos baixados");
    // Venda sem produto de catálogo (só item avulso): "0 produtos baixados"
    // seria uma afirmação inútil.
    expect(
      saleEventDetailLine("PAID", { totalAmount: 200, productsDeducted: 0 }),
    ).toBe("R$ 200,00");
  });

  it("singular e plural corretos", () => {
    expect(
      saleEventDetailLine("REVERSED", { totalAmount: 50, restoredProducts: 1 }),
    ).toBe("R$ 50,00 · 1 produto devolvido ao estoque");
    expect(
      saleEventDetailLine("REVERSED", { totalAmount: 50, restoredProducts: 3 }),
    ).toBe("R$ 50,00 · 3 produtos devolvidos ao estoque");
  });

  it("FISCAL_EMITTED mostra modelo e série (o número já está na mensagem)", () => {
    expect(
      saleEventDetailLine("FISCAL_EMITTED", {
        modelo: "65",
        numero: 42,
        serie: 1,
      }),
    ).toBe("NFC-e (modelo 65) · série 1");
  });

  it("details ausente ou vazio ⇒ null", () => {
    expect(saleEventDetailLine("CREATED", null)).toBeNull();
    expect(saleEventDetailLine("CREATED", undefined)).toBeNull();
    expect(saleEventDetailLine("CREATED", {})).toBeNull();
  });

  it("LIXO no JSONB não quebra e não vira texto", () => {
    // `details` é JSONB: uma versão futura (ou um evento gravado à mão) pode
    // pôr qualquer coisa ali. Nada disso pode virar "R$ NaN" na tela.
    expect(
      saleEventDetailLine("PAID", {
        totalAmount: "muito",
        productsDeducted: null,
      }),
    ).toBeNull();
    expect(
      saleEventDetailLine("CREATED", { totalAmount: NaN, paymentMethod: 7 }),
    ).toBeNull();
  });

  it("tipo desconhecido ⇒ null (sem inventar leitura de payload alheio)", () => {
    expect(saleEventDetailLine("SHIPPED", { qualquer: "coisa" })).toBeNull();
  });
});

describe("Data e autor", () => {
  it("formata no fuso do negócio, não no da máquina", () => {
    // 2026-08-14T02:30Z é 23:30 do dia 13 em São Paulo. Se este teste passar a
    // devolver "14/08/26 02:30", alguém trocou o timeZone fixo por local — e
    // aí SSR e browser divergem.
    expect(formatEventWhen("2026-08-14T02:30:00.000Z")).toBe("13/08/26 23:30");
  });

  it("data inválida vira '—', não 'Invalid Date'", () => {
    expect(formatEventWhen("nada disso")).toBe("—");
  });

  it("sem autor é SISTEMA, não 'desconhecido'", () => {
    // NULL no banco significa ação automática (cadeia do PDV, job). Dizer
    // "desconhecido" viraria suspeita de dado perdido.
    expect(saleEventActor(null)).toBe("Sistema");
    expect(saleEventActor(undefined)).toBe("Sistema");
    expect(saleEventActor("   ")).toBe("Sistema");
    expect(saleEventActor("Maria")).toBe("Maria");
  });
});

describe("fetchSaleTimeline — URL, escopo e falha", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown) {
    return { ok: true, json: async () => body } as any;
  }

  it("manda o limite da página e o e-mail no header", async () => {
    fetchMock.mockResolvedValue(ok({ events: [] }));
    await fetchSaleTimeline("r-1", "op@loja.com");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `http://api.test/finance/receivables/r-1/timeline?limit=${SALE_TIMELINE_PAGE_SIZE}`,
    );
    expect(init.headers).toEqual({ email: "op@loja.com" });
  });

  it("cursor `before` só viaja quando existe", async () => {
    fetchMock.mockResolvedValue(ok({ events: [] }));
    await fetchSaleTimeline("r-1", "op@loja.com", {
      before: "2026-08-14T00:00:00.000Z",
    });
    expect(fetchMock.mock.calls[0][0]).toContain(
      "before=2026-08-14T00%3A00%3A00.000Z",
    );
  });

  it("resposta sem `events` vira lista vazia, não estouro", async () => {
    // É o que a rota devolve com a flag de BACKEND desligada — e é justamente
    // o estado de quem ligou só a flag de UI.
    fetchMock.mockResolvedValue(ok({}));
    expect(await fetchSaleTimeline("r-1", "op@loja.com")).toEqual([]);
  });

  it("HTTP de erro lança com mensagem legível", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as any);
    await expect(fetchSaleTimeline("r-1", "op@loja.com")).rejects.toThrow(
      "Erro ao carregar o histórico da venda",
    );
  });
});

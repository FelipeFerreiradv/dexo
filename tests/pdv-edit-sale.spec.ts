// BLOCO E — editar a venda no PDV, antes da baixa.
//
// O risco desta tela não é o botão; é o CARREGAMENTO. O submit do formulário
// manda a lista de itens INTEIRA, então abrir o modal com os itens faltando e
// salvar APAGARIA os que existem no banco. Por isso a carga é tudo-ou-nada:
// item faltando ou resposta estranha ⇒ o formulário não abre.
//
// A segunda coisa que este spec trava é a REGRA DE QUANDO: só antes do
// recebimento. Depois da baixa o estoque já saiu, e o backend recusa (409) —
// a tela apenas não oferece o caminho que o servidor recusaria.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import {
  canEditSaleInPdv,
  fetchSaleForEdit,
} from "../app/pdv/lib/pdv-edit-sale";

describe("canEditSaleInPdv — só antes da baixa", () => {
  it("PENDENTE e VENCIDA podem ser corrigidas", () => {
    expect(canEditSaleInPdv("PENDENTE")).toBe(true);
    expect(canEditSaleInPdv("VENCIDA")).toBe(true);
  });

  it("PAGA não: o estoque já saiu", () => {
    expect(canEditSaleInPdv("PAGA")).toBe(false);
  });

  it("CANCELADA não: não há o que corrigir numa venda desfeita", () => {
    expect(canEditSaleInPdv("CANCELADA")).toBe(false);
  });

  it("status desconhecido ou ausente ⇒ não oferece o botão", () => {
    // Fail-closed: um status novo no futuro não pode liberar edição por
    // omissão justamente na tela que mexe em estoque.
    expect(canEditSaleInPdv("QUALQUER_COISA")).toBe(false);
    expect(canEditSaleInPdv(null)).toBe(false);
    expect(canEditSaleInPdv(undefined)).toBe(false);
  });
});

describe("fetchSaleForEdit — a carga é tudo-ou-nada", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const entryBase = {
    id: "r-1",
    document: "NF 1",
    reason: "Venda balcão",
    paymentMethod: "PIX",
    totalAmount: 100,
    installments: 1,
    dueDate: "2026-06-01T00:00:00.000Z",
    unidadeId: null,
    customer: { id: "c-1", name: "Cliente", cpf: null },
    items: [
      {
        productId: "p-1",
        description: null,
        scrapId: "s-1",
        listingId: null,
        quantity: 2,
        unitPrice: 50,
        product: { id: "p-1", sku: "SKU-1", name: "Farol" },
      },
    ],
  };

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as any;

  it("busca a venda pelo endpoint que já existe, com o e-mail no header", async () => {
    fetchMock.mockResolvedValue(ok({ entry: entryBase }));
    await fetchSaleForEdit("r-1", "op@loja.com");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/finance/receivables/r-1");
    expect(init.headers).toEqual({ email: "op@loja.com" });
  });

  it("monta o formulário com id (modo edição) e os itens", async () => {
    fetchMock.mockResolvedValue(ok({ entry: entryBase }));
    const seed = await fetchSaleForEdit("r-1", "op@loja.com");
    // `id` é o que liga o modo de edição no FinanceDialog — sem ele o submit
    // criaria uma venda NOVA em vez de corrigir a existente.
    expect(seed?.id).toBe("r-1");
    expect(seed?.items).toEqual([
      {
        productId: "p-1",
        description: null,
        scrapId: "s-1",
        listingId: null,
        quantity: 2,
        unitPrice: 50,
        product: { id: "p-1", sku: "SKU-1", name: "Farol" },
      },
    ]);
  });

  it("traz as formas de pagamento combinadas", async () => {
    // Sem lê-las o bloco reabriria vazio e a venda pareceria ter perdido as
    // formas — o defeito que a CORREÇÃO 2 consertou no Financeiro.
    fetchMock.mockResolvedValue(
      ok({
        entry: {
          ...entryBase,
          payments: [
            { method: "PIX", amount: 60 },
            { method: "DINHEIRO", amount: 40 },
          ],
        },
      }),
    );
    const seed = await fetchSaleForEdit("r-1", "op@loja.com");
    expect(seed?.payments).toHaveLength(2);
  });

  it("venda de UM item só continua abrindo (items array de 1)", async () => {
    fetchMock.mockResolvedValue(ok({ entry: entryBase }));
    expect((await fetchSaleForEdit("r-1", "op@loja.com"))?.items).toHaveLength(
      1,
    );
  });

  it("venda SEM itens abre com lista vazia — array vazio é resposta válida", async () => {
    fetchMock.mockResolvedValue(ok({ entry: { ...entryBase, items: [] } }));
    const seed = await fetchSaleForEdit("r-1", "op@loja.com");
    expect(seed?.items).toEqual([]);
  });

  it("resposta SEM o array de itens LANÇA — nunca abrir formulário incompleto", async () => {
    // Este é o caso perigoso: abrir sem itens e salvar apagaria os do banco,
    // porque o submit manda a lista inteira.
    fetchMock.mockResolvedValue(
      ok({ entry: { ...entryBase, items: undefined } }),
    );
    await expect(fetchSaleForEdit("r-1", "op@loja.com")).rejects.toThrow(
      "Resposta sem itens",
    );
  });

  it("404 vira null — a venda sumiu entre a lista e o clique", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    expect(await fetchSaleForEdit("sumiu", "op@loja.com")).toBeNull();
  });

  it("resposta sem entry vira null, não um formulário vazio", async () => {
    fetchMock.mockResolvedValue(ok({}));
    expect(await fetchSaleForEdit("r-1", "op@loja.com")).toBeNull();
  });

  it("outro erro HTTP lança com mensagem legível", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(fetchSaleForEdit("r-1", "op@loja.com")).rejects.toThrow(
      "Erro ao carregar a venda",
    );
  });
});

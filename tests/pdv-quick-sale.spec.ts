// BLOCO I — vender direto do card do produto.
//
// A parte que pode dar errado em silêncio é a FORMA DO ITEM: o carrinho monta
// à mão o mesmo objeto que o `ProductPickerBlock.handlePick` monta ao clicar
// num resultado de busca. Se um campo escapar, a venda salva errado — e se o
// campo que escapar for `scrapId`, a venda NÃO desconta do lote, que é
// exatamente o defeito que este projeto passou a semana consertando.
//
// Por isso o seed é função PURA e está pinado aqui campo a campo.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import {
  QUICK_SALE_PARAM,
  buildQuickSaleSeed,
  fetchQuickSaleProduct,
  isQuickSaleEnabled,
  parseQuickSaleParam,
  quickSaleHref,
} from "../app/pdv/lib/pdv-quick-sale";

const PECA = {
  id: "prod-1",
  sku: "FAR-001",
  name: "Farol dianteiro esquerdo",
  price: 250.5,
  stock: 3,
  scrapId: "scrap-9",
};

describe("Flag — exige AS DUAS", () => {
  const ORIG_QS = process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED;
  const ORIG_PDV = process.env.NEXT_PUBLIC_PDV_ENABLED;

  afterEach(() => {
    vi.resetModules();
    if (ORIG_QS === undefined)
      delete process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED;
    else process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED = ORIG_QS;
    if (ORIG_PDV === undefined) delete process.env.NEXT_PUBLIC_PDV_ENABLED;
    else process.env.NEXT_PUBLIC_PDV_ENABLED = ORIG_PDV;
  });

  it("ausentes na suíte ⇒ desligado", () => {
    expect(isQuickSaleEnabled()).toBe(false);
  });

  it("só o atalho ligado NÃO basta — o botão levaria a um 404", async () => {
    // /pdv responde notFound() sem NEXT_PUBLIC_PDV_ENABLED (pdv/page.tsx).
    process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED = "true";
    delete process.env.NEXT_PUBLIC_PDV_ENABLED;
    vi.resetModules();
    const m = await import("../app/pdv/lib/pdv-quick-sale");
    expect(m.isQuickSaleEnabled()).toBe(false);
  });

  it("só o PDV ligado também não basta", async () => {
    delete process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED;
    process.env.NEXT_PUBLIC_PDV_ENABLED = "true";
    vi.resetModules();
    const m = await import("../app/pdv/lib/pdv-quick-sale");
    expect(m.isQuickSaleEnabled()).toBe(false);
  });

  it("as duas ligadas ⇒ ligado", async () => {
    process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED = "true";
    process.env.NEXT_PUBLIC_PDV_ENABLED = "true";
    vi.resetModules();
    const m = await import("../app/pdv/lib/pdv-quick-sale");
    expect(m.isQuickSaleEnabled()).toBe(true);
  });
});

describe("URL — quem escreve e quem lê usam o mesmo parâmetro", () => {
  it("o href leva o id no parâmetro combinado", () => {
    expect(quickSaleHref("prod-1")).toBe(`/pdv?${QUICK_SALE_PARAM}=prod-1`);
  });

  it("escapa o que precisa ser escapado", () => {
    expect(quickSaleHref("a b&c")).toBe(`/pdv?${QUICK_SALE_PARAM}=a%20b%26c`);
  });

  it("ida e volta: o que o href escreve, o parser lê", () => {
    const id = "cm3x9k2p10000abcd1234efgh";
    const escrito = new URL(`http://x${quickSaleHref(id)}`).searchParams.get(
      QUICK_SALE_PARAM,
    );
    expect(parseQuickSaleParam(escrito)).toBe(id);
  });
});

describe("parseQuickSaleParam — fronteira da URL", () => {
  it("aceita id de verdade", () => {
    expect(parseQuickSaleParam("cm3x9k2p10000abcd1234efgh")).toBe(
      "cm3x9k2p10000abcd1234efgh",
    );
    expect(parseQuickSaleParam("prod_1-2")).toBe("prod_1-2");
  });

  it("apara espaço em volta", () => {
    expect(parseQuickSaleParam("  prod-1  ")).toBe("prod-1");
  });

  it("ausente, vazio ou só espaço ⇒ null", () => {
    expect(parseQuickSaleParam(null)).toBeNull();
    expect(parseQuickSaleParam(undefined)).toBeNull();
    expect(parseQuickSaleParam("")).toBeNull();
    expect(parseQuickSaleParam("   ")).toBeNull();
  });

  it("recusa o que sairia da rota pretendida", () => {
    // O valor vira parte de uma URL de API — nada que atravesse caminho ou
    // acrescente parâmetro pode passar.
    expect(parseQuickSaleParam("../../admin")).toBeNull();
    expect(parseQuickSaleParam("prod/1")).toBeNull();
    expect(parseQuickSaleParam("prod-1?x=1")).toBeNull();
    expect(parseQuickSaleParam("prod-1&y=2")).toBeNull();
    expect(parseQuickSaleParam("prod-1#frag")).toBeNull();
    expect(parseQuickSaleParam("a".repeat(65))).toBeNull();
  });
});

describe("buildQuickSaleSeed — a MESMA forma que o picker monta", () => {
  it("um item, quantidade 1, preço corrente", () => {
    expect(buildQuickSaleSeed(PECA)).toEqual({
      items: [
        {
          productId: "prod-1",
          description: null,
          scrapId: "scrap-9",
          listingId: null,
          quantity: 1,
          unitPrice: 250.5,
          product: {
            id: "prod-1",
            sku: "FAR-001",
            name: "Farol dianteiro esquerdo",
            stock: 3,
          },
        },
      ],
      totalAmount: 250.5,
    });
  });

  it("scrapId AUSENTE vira null explícito, nunca undefined", () => {
    // `undefined` sumiria no JSON.stringify do submit e o backend receberia um
    // item sem a chave — o que é diferente de "sem sucata" numa validação.
    const seed = buildQuickSaleSeed({ ...PECA, scrapId: undefined });
    expect(seed.items[0].scrapId).toBeNull();
    expect("scrapId" in seed.items[0]).toBe(true);
  });

  it("o total nasce igual ao preço — senão a venda abriria zerada", () => {
    // Quem pré-preenche o total normalmente é o `handlePick` do picker, que
    // aqui não roda.
    expect(buildQuickSaleSeed({ ...PECA, price: 99.9 }).totalAmount).toBe(99.9);
  });

  it("preço inválido vira 0, não NaN", () => {
    const seed = buildQuickSaleSeed({ ...PECA, price: NaN });
    expect(seed.totalAmount).toBe(0);
    expect(seed.items[0].unitPrice).toBe(0);
  });

  it("leva o estoque para o carrinho não mentir 'sem estoque'", () => {
    expect(buildQuickSaleSeed(PECA).items[0].product.stock).toBe(3);
  });
});

describe("fetchQuickSaleProduct", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as any;

  it("busca por id, com o e-mail no header", async () => {
    fetchMock.mockResolvedValue(ok({ product: PECA }));
    await fetchQuickSaleProduct("prod-1", "op@loja.com");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/products/prod-1");
    expect(init.headers).toEqual({ email: "op@loja.com" });
  });

  it("desembrulha o envelope { product } do GET /products/:id", async () => {
    fetchMock.mockResolvedValue(ok({ product: PECA, productLocation: null }));
    expect(await fetchQuickSaleProduct("prod-1", "op@loja.com")).toEqual({
      id: "prod-1",
      sku: "FAR-001",
      name: "Farol dianteiro esquerdo",
      price: 250.5,
      stock: 3,
      scrapId: "scrap-9",
    });
  });

  it("404 vira null — a peça sumiu entre a vitrine e o clique", async () => {
    // null é sinal de "não existe", diferente de erro: o chamador avisa o
    // operador em vez de abrir um modal vazio e mudo.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    expect(await fetchQuickSaleProduct("sumiu", "op@loja.com")).toBeNull();
  });

  it("outro erro HTTP lança", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(
      fetchQuickSaleProduct("prod-1", "op@loja.com"),
    ).rejects.toThrow("Erro ao carregar a peça");
  });

  it("preço e estoque vindos como string viram número", async () => {
    // Decimal do Prisma chega como string em vários pontos da API.
    fetchMock.mockResolvedValue(
      ok({ product: { ...PECA, price: "250.50", stock: "3" } }),
    );
    const p = await fetchQuickSaleProduct("prod-1", "op@loja.com");
    expect(p?.price).toBe(250.5);
    expect(p?.stock).toBe(3);
  });
});

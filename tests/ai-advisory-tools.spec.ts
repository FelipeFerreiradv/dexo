import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// As 7 tools consultivas, com todas as fontes dubladas.
//
// O que estes testes olham, e que um teste de "o resultado está certo" não
// olharia: QUEM FOI CHAMADO. `H.chamadas` registra cada fonte que executou, e
// meia dúzia de asserções aqui são sobre uma fonte NÃO aparecer nessa lista.
// É assim que se prova que a hierarquia é execução e não intenção.
// ===========================================================================

const H = vi.hoisted(() => ({
  chamadas: [] as string[],
  produtos: [] as any[],
  internal: { suggestion: null, reason: "insufficient_sample" } as any,
  categorias: { normalizedTitle: "", tokens: [], suggestions: [] as any[] },
  catalogoHits: [] as any[],
  catalogoDetalhe: null as any,
  mlCategoryId: null as string | null,
  compat: [] as any[],
  usuario: null as any,
  categoriaLinha: null as any,
}));

vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    async listProducts() {
      H.chamadas.push("catalogoProprio");
      return {
        products: H.produtos,
        total: H.produtos.length,
        totalPages: 1,
      };
    }
  },
}));

vi.mock("../app/marketplaces/usecases/internal-suggestion.usecase", () => ({
  InternalSuggestionUseCase: {
    suggestFromTitle: async () => {
      H.chamadas.push("baseConsolidada");
      return H.internal;
    },
  },
}));

vi.mock("../app/marketplaces/services/category-suggestion.service", () => ({
  CategorySuggestionService: {
    suggestFromTitle: async () => {
      H.chamadas.push("motorDeCategorias");
      return H.categorias;
    },
    suggestFromProduct: async () => {
      H.chamadas.push("motorDeCategorias");
      return H.categorias;
    },
  },
}));

vi.mock("../app/marketplaces/usecases/ml-catalog-suggestion.usecase", () => ({
  MLCatalogSuggestionUseCase: {
    listSuggestions: async () => {
      H.chamadas.push("catalogoDoML");
      return H.catalogoHits;
    },
    getProductDetail: async () => {
      H.chamadas.push("fichaDoML");
      return H.catalogoDetalhe;
    },
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    suggestCategoryId: async () => {
      H.chamadas.push("classificadorDoML");
      return H.mlCategoryId;
    },
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    systemLog: { create: async () => ({}) },
    productCompatibility: {
      findMany: async () => {
        H.chamadas.push("compatProprias");
        return H.compat;
      },
    },
    user: {
      findUnique: async () => {
        H.chamadas.push("configDaLoja");
        return H.usuario;
      },
    },
    marketplaceCategory: { findUnique: async () => H.categoriaLinha },
  },
}));

import { scopeFromRequest } from "../app/ai/core/scope";
import { consultarCatalogoMl } from "../app/ai/tools/advisory/catalogo-ml";
import { sugerirCategoria } from "../app/ai/tools/advisory/categoria";
import { sugerirCompatibilidades } from "../app/ai/tools/advisory/compatibilidades";
import { sugerirDescricao } from "../app/ai/tools/advisory/descricao";
import { sugerirMedidas } from "../app/ai/tools/advisory/medidas";
import { sugerirPreco } from "../app/ai/tools/advisory/preco";
import { sugerirTitulo } from "../app/ai/tools/advisory/titulo";

const scope = scopeFromRequest({
  user: { id: "a", dataOwnerId: "TENANT-A", parentUserId: null },
} as any)!;

/** Peça do catálogo, com `costPrice`/`markup` de propósito: o select real traz. */
const peca = (over: Partial<any> = {}) => ({
  id: "p1",
  sku: "F001",
  name: "Farol Dianteiro Palio",
  price: 250,
  costPrice: 90,
  markup: 60,
  brand: "Fiat",
  model: "Palio",
  year: "2012",
  version: null,
  quality: "BOM",
  description: null,
  heightCm: null,
  widthCm: null,
  lengthCm: null,
  weightKg: null,
  mlCategory: null,
  shopeeCategoryId: null,
  ...over,
});

const comMedidas = (over: Partial<any> = {}) =>
  peca({ heightCm: 30, widthCm: 40, lengthCm: 50, weightKg: 4, ...over });

const agregado = (over: Partial<any> = {}) => ({
  suggestion: {
    matchKey: "farol|fiat|palio|*",
    sampleSize: 12,
    confidence: "alta",
    fields: {
      priceMedian: 300,
      weightKg: 4.5,
      heightCm: 25,
      widthCm: 35,
      lengthCm: 45,
      mlCategoryId: "cuid-ml",
      shopeeCategoryId: "SHP-99",
      ...((over as any).fields ?? {}),
    },
    compatibilities: (over as any).compatibilities ?? [],
    ...over,
  },
});

beforeEach(() => {
  H.chamadas = [];
  H.produtos = [];
  H.internal = { suggestion: null, reason: "insufficient_sample" };
  H.categorias = { normalizedTitle: "", tokens: [], suggestions: [] };
  H.catalogoHits = [];
  H.catalogoDetalhe = null;
  H.mlCategoryId = null;
  H.compat = [];
  H.usuario = null;
  H.categoriaLinha = null;
  vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("sugerir_preco", () => {
  it("⭐ com catálogo próprio suficiente, NÃO consulta a base consolidada", async () => {
    H.produtos = [
      peca({ id: "1", sku: "A", price: 200 }),
      peca({ id: "2", sku: "B", price: 250 }),
      peca({ id: "3", sku: "C", price: 300 }),
    ];

    const r: any = await sugerirPreco.handler({ titulo: "farol palio" }, scope);

    expect(r.temSugestao).toBe(true);
    expect(r.precoSugerido).toBe(250);
    expect(r.faixa).toEqual({ minimo: 200, maximo: 300 });
    expect(r.fontes).toEqual([
      { kind: "proprio", label: "Peças parecidas no seu catálogo", count: 3 },
    ]);
    // A prova: a fonte 2 nem foi tocada.
    expect(H.chamadas).not.toContain("baseConsolidada");
  });

  it("com menos de 3 peças próprias, cai para a base consolidada", async () => {
    H.produtos = [peca({ id: "1", sku: "A", price: 200 })];
    H.internal = agregado();

    const r: any = await sugerirPreco.handler({ titulo: "farol palio" }, scope);

    expect(r.precoSugerido).toBe(300);
    expect(r.fontes[0]).toEqual({
      kind: "plataforma",
      sampleSize: 12,
      confidence: "alta",
      matchKey: "farol|fiat|palio|*",
    });
    expect(H.chamadas).toEqual(["catalogoProprio", "baseConsolidada"]);
  });

  it("⭐ amostra menor que 5 na base consolidada NÃO sugere", async () => {
    H.internal = agregado({ sampleSize: 4 });

    const r: any = await sugerirPreco.handler({ titulo: "farol palio" }, scope);

    expect(r.temSugestao).toBe(false);
    expect(r.fontes).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("300");
  });

  it("sem base nenhuma, proíbe explicitamente o chute", async () => {
    const r: any = await sugerirPreco.handler({ titulo: "farol palio" }, scope);

    expect(r.temSugestao).toBe(false);
    expect(r.instrucao).toMatch(/NÃO invente um preço/);
    expect(r.instrucao).toMatch(/em torno de/);
    expect(r.fontes).toEqual([]);
  });

  it("⭐ nunca devolve custo nem margem, mesmo vindo no select do repositório", async () => {
    H.produtos = [
      peca({ id: "1", sku: "A", price: 200 }),
      peca({ id: "2", sku: "B", price: 250 }),
      peca({ id: "3", sku: "C", price: 300 }),
    ];

    const r: any = await sugerirPreco.handler({ titulo: "farol palio" }, scope);
    const bruto = JSON.stringify(r);

    expect(bruto).not.toContain("costPrice");
    expect(bruto).not.toContain("markup");
    expect(bruto).not.toContain("90");
    expect(r.atencao).toMatch(/não tem acesso/i);
  });

  it("filtra peça sem preço", async () => {
    H.produtos = [
      peca({ id: "1", sku: "A", price: 200 }),
      peca({ id: "2", sku: "B", price: 0 }),
      peca({ id: "3", sku: "C", price: null }),
    ];
    H.internal = agregado();

    const r: any = await sugerirPreco.handler({ titulo: "farol palio" }, scope);
    expect(r.fontes[0].kind).toBe("plataforma");
  });
});

// ---------------------------------------------------------------------------

describe("sugerir_medidas", () => {
  it("usa as medidas da própria loja quando há três peças medidas", async () => {
    H.produtos = [
      comMedidas({ id: "1", sku: "A" }),
      comMedidas({ id: "2", sku: "B", weightKg: 5 }),
      comMedidas({ id: "3", sku: "C", weightKg: 6 }),
    ];

    const r: any = await sugerirMedidas.handler(
      { titulo: "farol palio" },
      scope,
    );

    expect(r.temSugestao).toBe(true);
    expect(r.medidas.pesoKg).toBe(5);
    expect(r.fontes[0].kind).toBe("proprio");
    expect(H.chamadas).not.toContain("baseConsolidada");
  });

  it("peça sem as QUATRO medidas não conta como referência", async () => {
    H.produtos = [
      comMedidas({ id: "1", sku: "A" }),
      comMedidas({ id: "2", sku: "B", weightKg: null }),
      comMedidas({ id: "3", sku: "C", lengthCm: null }),
    ];
    H.internal = agregado();

    const r: any = await sugerirMedidas.handler(
      { titulo: "farol palio" },
      scope,
    );
    expect(r.fontes[0].kind).toBe("plataforma");
  });

  it("sem catálogo e sem base, cai na tabela do Mercado Envios (fonte regra)", async () => {
    H.categorias = {
      normalizedTitle: "",
      tokens: [],
      suggestions: [
        { categoryId: "c1", fullPath: "Peças > Iluminação", source: "curated" },
      ],
    };

    const r: any = await sugerirMedidas.handler(
      { titulo: "farol palio", categoria: "Iluminação" },
      scope,
    );

    expect(r.temSugestao).toBe(true);
    expect(r.fontes[0].kind).toBe("regra");
    expect(r.comoLer).toMatch(/EMBALAGEM/);
  });

  it("⭐ avisa quando a medida não passa no Mercado Envios", async () => {
    H.produtos = [
      comMedidas({ id: "1", sku: "A", lengthCm: 150, weightKg: 40 }),
      comMedidas({ id: "2", sku: "B", lengthCm: 150, weightKg: 40 }),
      comMedidas({ id: "3", sku: "C", lengthCm: 150, weightKg: 40 }),
    ];

    const r: any = await sugerirMedidas.handler(
      { titulo: "farol palio" },
      scope,
    );

    expect(r.atencao).toMatch(/NÃO PASSAM NO MERCADO ENVIOS/);
    expect(r.atencao).toMatch(/suspender a conta/);
    expect(r.observacao).toBeUndefined();
  });

  it("sem base nenhuma, proíbe o chute e devolve os limites mesmo assim", async () => {
    const r: any = await sugerirMedidas.handler(
      { titulo: "xpto que nao existe" },
      scope,
    );
    expect(r.temSugestao).toBe(false);
    expect(r.instrucao).toMatch(/NÃO invente medida/);
    expect(r.limitesDoMercadoEnvios.pesoKg).toBe(30);
    expect(r.fontes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("sugerir_compatibilidades", () => {
  const compatDoBanco = [
    {
      brand: "Fiat",
      model: "Palio",
      yearFrom: 2008,
      yearTo: 2016,
      version: null,
    },
    {
      brand: "Fiat",
      model: "Siena",
      yearFrom: 2008,
      yearTo: 2016,
      version: null,
    },
  ];

  it("⭐ com compatibilidade própria, o catálogo do ML NÃO é consultado nem com a flag ligada", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    H.produtos = [peca()];
    H.compat = compatDoBanco;

    const r: any = await sugerirCompatibilidades.handler(
      { titulo: "farol palio" },
      scope,
    );

    expect(r.temSugestao).toBe(true);
    expect(r.veiculos).toHaveLength(2);
    expect(r.fontes[0].kind).toBe("proprio");
    expect(H.chamadas).not.toContain("catalogoDoML");
  });

  it("a consulta de compatibilidade própria exige o tenant no where", async () => {
    H.produtos = [peca()];
    const espiao = vi.fn(async () => compatDoBanco);
    const prisma = (await import("../app/lib/prisma")).default as any;
    const original = prisma.productCompatibility.findMany;
    prisma.productCompatibility.findMany = espiao;
    try {
      await sugerirCompatibilidades.handler({ titulo: "farol palio" }, scope);
      const where = (espiao.mock.calls[0] as any)[0].where;
      expect(where.product.userId).toBe("TENANT-A");
      expect(where.productId.in).toContain("p1");
    } finally {
      prisma.productCompatibility.findMany = original;
    }
  });

  it("com a flag DESLIGADA e nada interno, explica que a pesquisa externa está off", async () => {
    const r: any = await sugerirCompatibilidades.handler(
      { titulo: "farol palio" },
      scope,
    );

    expect(r.temSugestao).toBe(false);
    expect(r.observacao).toMatch(/desligada/);
    expect(r.instrucao).toMatch(/NÃO invente/);
    expect(H.chamadas).not.toContain("catalogoDoML");
    expect(r.fontes).toEqual([]);
  });

  it("com a flag LIGADA e nada interno, consulta o catálogo do ML", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    H.catalogoHits = [{ catalogProductId: "MLB123", name: "Farol Palio" }];
    H.catalogoDetalhe = {
      name: "Farol Dianteiro Direito Fiat Palio",
      compatibilities: [
        {
          brand: "Fiat",
          model: "Palio",
          yearFrom: 2008,
          yearTo: 2016,
          version: null,
        },
      ],
    };

    const r: any = await sugerirCompatibilidades.handler(
      { titulo: "farol palio" },
      scope,
    );

    expect(H.chamadas).toContain("catalogoDoML");
    expect(r.fontes[0]).toEqual({
      kind: "externa",
      provider: "mercado-livre",
      ref: "Farol Dianteiro Direito Fiat Palio",
    });
  });

  it("dedupe de veículo repetido", async () => {
    H.produtos = [peca()];
    H.compat = [...compatDoBanco, ...compatDoBanco];

    const r: any = await sugerirCompatibilidades.handler(
      { titulo: "farol palio" },
      scope,
    );
    expect(r.veiculos).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("sugerir_categoria", () => {
  it("Magalu não tem escolha de categoria — explica em vez de inventar", async () => {
    const r: any = await sugerirCategoria.handler(
      { titulo: "farol palio", canal: "magalu" },
      scope,
    );

    expect(r.resolvidoPeloSistema).toBe(true);
    expect(r.fontes[0].kind).toBe("regra");
    expect(H.chamadas).toEqual([]);
  });

  it("⭐ duas peças próprias na mesma categoria vencem o motor", async () => {
    H.produtos = [
      peca({
        id: "1",
        sku: "A",
        mlCategory: { externalId: "MLB1", fullPath: "Peças > Faróis" },
      }),
      peca({
        id: "2",
        sku: "B",
        mlCategory: { externalId: "MLB1", fullPath: "Peças > Faróis" },
      }),
    ];

    const r: any = await sugerirCategoria.handler(
      { titulo: "farol palio", canal: "mercado_livre" },
      scope,
    );

    expect(r.categoria).toEqual({ id: "MLB1", caminho: "Peças > Faróis" });
    expect(r.fontes[0].kind).toBe("proprio");
    expect(H.chamadas).not.toContain("motorDeCategorias");
  });

  it("uma peça só não faz padrão", async () => {
    H.produtos = [
      peca({
        id: "1",
        sku: "A",
        mlCategory: { externalId: "MLB1", fullPath: "x" },
      }),
      peca({ id: "2", sku: "B", mlCategory: null }),
    ];
    H.internal = agregado();
    H.categoriaLinha = { fullPath: "Peças > Iluminação > Faróis" };

    const r: any = await sugerirCategoria.handler(
      { titulo: "farol palio", canal: "mercado_livre" },
      scope,
    );

    expect(r.fontes[0].kind).toBe("plataforma");
    expect(r.categoria.caminho).toBe("Peças > Iluminação > Faróis");
  });

  it("sem base consolidada, o motor de categorias responde como `regra` e diz o sinal", async () => {
    H.categorias = {
      normalizedTitle: "",
      tokens: [],
      suggestions: [
        {
          categoryId: "c1",
          fullPath: "Peças > Faróis",
          source: "curated",
          reasons: ["tipo de peça: farol"],
        },
        { categoryId: "c2", fullPath: "Peças > Lanternas", source: "keyword" },
      ],
    };

    const r: any = await sugerirCategoria.handler(
      { titulo: "farol palio", canal: "mercado_livre" },
      scope,
    );

    expect(r.fontes[0]).toEqual({
      kind: "regra",
      rule: 'Motor de categorias do Dexo — Mercado Livre, sinal "curated"',
    });
    expect(r.alternativas).toHaveLength(1);
  });

  it("classificador do ML só entra com a flag ligada e por último", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    H.mlCategoryId = "MLB9999";
    H.categoriaLinha = { fullPath: "Acessórios > Faróis" };

    const r: any = await sugerirCategoria.handler(
      { titulo: "farol palio", canal: "mercado_livre" },
      scope,
    );

    expect(H.chamadas).toEqual([
      "catalogoProprio",
      "baseConsolidada",
      "motorDeCategorias",
      "classificadorDoML",
    ]);
    expect(r.fontes[0]).toEqual({
      kind: "externa",
      provider: "mercado-livre",
      ref: "MLB9999",
    });
  });

  it("nada responde: proíbe inventar código de categoria", async () => {
    const r: any = await sugerirCategoria.handler(
      { titulo: "xpto", canal: "shopee" },
      scope,
    );
    expect(r.temSugestao).toBe(false);
    expect(r.instrucao).toMatch(/NÃO invente um código/);
    expect(r.fontes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("sugerir_titulo", () => {
  it("mostra como a loja nomeia peças parecidas, mais as regras do canal", async () => {
    H.produtos = [
      peca({ id: "1", sku: "A" }),
      peca({ id: "2", sku: "B", name: "Farol Palio Esquerdo" }),
    ];

    const r: any = await sugerirTitulo.handler(
      { descricao: "farol palio", canal: "mercado_livre" },
      scope,
    );

    expect(r.exemplosDaLoja.length).toBeGreaterThan(0);
    expect(r.fontes[0].kind).toBe("proprio");
    // ⭐ As regras entram MESMO com o catálogo tendo respondido: restrição não
    // é fonte alternativa.
    expect(r.fontes.filter((f: any) => f.kind === "regra").length).toBe(3);
    expect(r.regrasDoCanal.join(" ")).toMatch(/60 caracteres/);
  });

  it("⭐ sem peça parecida, marca a resposta como estimativa do Bitz", async () => {
    const r: any = await sugerirTitulo.handler(
      { descricao: "peca inedita", canal: "shopee" },
      scope,
    );

    const estimativa = r.fontes.find((f: any) => f.kind === "estimativa");
    expect(estimativa).toBeTruthy();
    expect(estimativa.note).toMatch(/redigido pelo Bitz/);
    expect(r.instrucao).toMatch(/DEIXE CLARO/);
  });

  it("mostra a prévia do que o ML publicaria, com a função real", async () => {
    const r: any = await sugerirTitulo.handler(
      { descricao: "Farol D/E (novo) Palio", canal: "mercado_livre" },
      scope,
    );
    expect(r.atencao).toContain("Farol D E novo Palio");
  });

  it("Shopee avisa que marca/modelo/ano já são acrescentados pelo sistema", async () => {
    const r: any = await sugerirTitulo.handler(
      { descricao: "farol", canal: "shopee" },
      scope,
    );
    expect(r.regrasDoCanal.join(" ")).toMatch(
      /já são acrescentados|acrescentados pelo sistema|PN:/,
    );
    expect(r.regrasDoCanal.join(" ")).toMatch(/120/);
  });
});

// ---------------------------------------------------------------------------

describe("sugerir_descricao", () => {
  it("⭐ o texto padrão da loja vence as descrições soltas", async () => {
    H.usuario = {
      defaultProductDescription: "Peça original, garantia de 90 dias.",
    };
    H.produtos = [peca({ description: "x".repeat(80) })];

    const r: any = await sugerirDescricao.handler(
      { descricao: "farol palio", canal: "mercado_livre" },
      scope,
    );

    expect(r.textoPadraoDaLoja).toContain("garantia de 90 dias");
    expect(r.exemplosDaLoja).toBeUndefined();
    expect(r.fontes[0]).toEqual({
      kind: "proprio",
      label: "Texto padrão configurado na sua loja",
      count: 1,
    });
    expect(H.chamadas).not.toContain("catalogoProprio");
  });

  it("sem texto padrão, usa descrições de peças parecidas e sugere configurar", async () => {
    H.produtos = [
      peca({ description: "Farol em bom estado, testado. ".repeat(3) }),
    ];

    const r: any = await sugerirDescricao.handler(
      { descricao: "farol palio", canal: "shopee" },
      scope,
    );

    expect(r.exemplosDaLoja.length).toBe(1);
    expect(r.dica).toMatch(/descrição padrão/);
  });

  it("sem nada, marca como estimativa", async () => {
    const r: any = await sugerirDescricao.handler(
      { descricao: "peca inedita", canal: "mercado_livre" },
      scope,
    );
    expect(r.fontes.some((f: any) => f.kind === "estimativa")).toBe(true);
    expect(r.instrucao).toMatch(/DEIXE CLARO/);
  });

  it("Shopee avisa que a ficha técnica já é anexada pelo sistema", async () => {
    const r: any = await sugerirDescricao.handler(
      { descricao: "farol", canal: "shopee" },
      scope,
    );
    expect(r.regrasDoCanal.join(" ")).toMatch(/Detalhes Técnicos/);
  });

  it("todo canal proíbe telefone e link na descrição", async () => {
    for (const canal of ["mercado_livre", "shopee", "magalu"]) {
      const r: any = await sugerirDescricao.handler(
        { descricao: "farol", canal },
        scope,
      );
      expect(r.regrasDoCanal.join(" ")).toMatch(/fora da plataforma/);
    }
  });
});

// ---------------------------------------------------------------------------

describe("consultar_catalogo_ml", () => {
  it("⭐ com a flag desligada, responde explicando — e não consulta nada", async () => {
    const r: any = await consultarCatalogoMl.handler(
      { consulta: "farol palio" },
      scope,
    );

    expect(r.disponivel).toBe(false);
    expect(r.motivo).toMatch(/desligada/);
    expect(r.oQueFazer).toMatch(/NÃO tente responder de memória/);
    expect(H.chamadas).toEqual([]);
    expect(r.fontes).toEqual([]);
  });

  it("com a flag ligada, devolve os itens do catálogo público", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    H.catalogoHits = [
      {
        catalogProductId: "MLB1",
        name: "Farol Dianteiro Fiat Palio",
        brand: "Fiat",
        model: "Palio",
        permalink: "https://x",
      },
    ];

    const r: any = await consultarCatalogoMl.handler(
      { consulta: "farol palio" },
      scope,
    );

    expect(r.encontrados).toBe(1);
    expect(r.itens[0].catalogProductId).toBe("MLB1");
    expect(r.fontes[0].kind).toBe("externa");
    expect(r.comoLer).toMatch(/não do catálogo desta loja/);
  });

  it("catálogo vazio não vira invenção", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    const r: any = await consultarCatalogoMl.handler(
      { consulta: "peca inexistente" },
      scope,
    );
    expect(r.encontrados).toBe(0);
    expect(r.instrucao).toMatch(/NÃO invente/);
    expect(r.fontes).toEqual([]);
  });
});

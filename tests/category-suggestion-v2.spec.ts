import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Camada V2 da sugestão de categoria.
 *
 * Invariantes provadas aqui:
 *  (a) `suggestFromTitle(t, s)` é indistinguível de `suggestFromProduct({title:t}, s)`;
 *  (b) contexto vazio => MESMA chave de cache de antes (`siteId::titulo`);
 *  (c) kill-switch CATEGORY_SUGGEST_V2_DISABLED=1 devolve o ranking anterior;
 *  (d) o defeito de produção: tokens de veículo não são evidência de tipo de peça;
 *  (e) marca/modelo/ano do formulário casam sem estar no título;
 *  (f) auto-aplicar exige convergência real;
 *  (g) coerência de qualificador;
 *  (h) shape só ganha campos.
 */

const { mockListWithCategory, mockListWithParents, mockCollectVotes } =
  vi.hoisted(() => ({
    mockListWithCategory: vi.fn(),
    mockListWithParents: vi.fn(),
    mockCollectVotes: vi.fn(),
  }));

vi.mock("../app/marketplaces/repositories/category-alias.repository", () => ({
  default: { listWithCategory: mockListWithCategory },
  CategoryAliasRepository: { listWithCategory: mockListWithCategory },
}));
vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  default: { listWithParents: mockListWithParents },
}));
vi.mock("../app/marketplaces/lib/category-inference/engine", () => ({
  CategoryInferenceEngine: { collectVotes: mockCollectVotes },
}));
vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  getVehicleRootSet: async () => new Set<string>(),
  CategoryResolutionService: {},
}));

import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";
import {
  coherenceVerdict,
  contextCacheSuffix,
  isContextEmpty,
  shouldAutoApplyV2,
} from "../app/marketplaces/lib/category-suggest-v2";

/**
 * O cenário exato que a régua flagrou em produção (04/08/2026).
 *
 * `CategoryAlias.tokens` foi populada com o TÍTULO INTEIRO do anúncio de
 * origem, veículo incluído. O alias de FECHADURA carrega "volkswagen,fox,2011"
 * mas nenhum token de retrovisor; mesmo assim ele casava 3 tokens (+6), somava
 * marca (+3) e modelo (+2) e batia o alias correto.
 */
const ALIASES = [
  {
    id: "alias-fechadura",
    tokens: "fechadura,porta,volkswagen,fox,2011,2012",
    synonyms: "",
    brandModelPatterns: JSON.stringify({
      brand: "Volkswagen",
      model: "Fox",
      years: ["2011", "2012"],
    }),
    marketplaceCategory: {
      externalId: "MLB_FECHADURA",
      name: "Fechaduras de Portas",
      fullPath: "Peças > Fechaduras e Chaves > Fechaduras de Portas",
    },
  },
  {
    id: "alias-retrovisor",
    tokens: "retrovisor,espelho",
    synonyms: "",
    brandModelPatterns: null,
    marketplaceCategory: {
      externalId: "MLB_RETRO_LAT",
      name: "Espelhos Retrovisores Laterais",
      fullPath: "Peças > Carroceria > Espelhos Retrovisores Laterais",
    },
  },
  {
    id: "alias-retrovisor-interno",
    tokens: "retrovisor,interno,acabamento",
    synonyms: "",
    brandModelPatterns: null,
    marketplaceCategory: {
      externalId: "MLB_RETRO_INT",
      name: "Espelhos Retrovisores Internos",
      fullPath: "Peças > Peças de Interior > Espelhos Retrovisores Internos",
    },
  },
  {
    id: "alias-amortecedor",
    tokens: "amortecedor",
    synonyms: "",
    brandModelPatterns: JSON.stringify({
      brand: "Chevrolet",
      model: "Onix",
      years: ["2014"],
    }),
    marketplaceCategory: {
      externalId: "MLB_AMORT",
      name: "Amortecedores",
      fullPath: "Peças > Suspensão > Amortecedores",
    },
  },
];

const CATEGORIES = [
  {
    id: "c1",
    externalId: "MLB_FECHADURA",
    name: "Fechaduras de Portas",
    fullPath: "Peças > Fechaduras e Chaves > Fechaduras de Portas",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "c2",
    externalId: "MLB_RETRO_LAT",
    name: "Espelhos Retrovisores Laterais",
    fullPath: "Peças > Carroceria > Espelhos Retrovisores Laterais",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "c3",
    externalId: "MLB_RETRO_INT",
    name: "Espelhos Retrovisores Internos",
    fullPath: "Peças > Peças de Interior > Espelhos Retrovisores Internos",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "c4",
    externalId: "MLB_AMORT",
    name: "Amortecedores",
    fullPath: "Peças > Suspensão > Amortecedores",
    parentExternalId: null,
    siteId: "MLB",
  },
];

const svc = CategorySuggestionService as any;

function clearCaches() {
  svc.aliasCacheMap?.clear?.();
  svc.categoryCacheMap?.clear?.();
  svc.parentMapCache?.clear?.();
  svc.tokenFreqCache?.clear?.();
  svc.catTokenCache?.clear?.();
  svc.aliasTokenCache?.clear?.();
  svc.suggestResultCache?.clear?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListWithCategory.mockResolvedValue(ALIASES);
  mockListWithParents.mockResolvedValue(CATEGORIES);
  mockCollectVotes.mockResolvedValue({ votes: [], pieceType: null });
  delete process.env.CATEGORY_SUGGEST_V2_DISABLED;
  clearCaches();
});

afterEach(() => {
  delete process.env.CATEGORY_SUGGEST_V2_DISABLED;
  clearCaches();
});

const TITULO_REAL = "Retrovisor Direito Volkswagen fox 2011 2012";

// ─────────────────────────────────────────────────────────────────────────────

describe("(a) suggestFromTitle continua valendo e delega", () => {
  it("título-só por qualquer das duas portas dá o MESMO resultado", async () => {
    const porTitulo = await CategorySuggestionService.suggestFromTitle(
      TITULO_REAL,
      "MLB",
    );
    clearCaches();
    const porProduto = await CategorySuggestionService.suggestFromProduct(
      { title: TITULO_REAL },
      "MLB",
    );
    expect(porProduto).toEqual(porTitulo);
  });

  it("a assinatura antiga (siteId default MLB) segue funcionando", async () => {
    const r = await CategorySuggestionService.suggestFromTitle("Amortecedor");
    expect(r.suggestions[0]?.categoryId).toBe("MLB_AMORT");
  });
});

describe("(b) chave de cache", () => {
  it("contexto vazio não acrescenta sufixo nenhum", () => {
    expect(isContextEmpty({ title: "x" })).toBe(true);
    expect(contextCacheSuffix({ title: "x" })).toBe("");
    expect(contextCacheSuffix({ title: "x", brand: "  ", model: null })).toBe(
      "",
    );
  });

  it("contexto preenchido gera sufixo estável e distinto", () => {
    const a = contextCacheSuffix({ title: "x", brand: "Fiat" });
    const b = contextCacheSuffix({ title: "x", brand: "Fiat" });
    const c = contextCacheSuffix({ title: "x", brand: "Ford" });
    expect(a).not.toBe("");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("contexto diferente NÃO reaproveita o resultado do título-só", async () => {
    const semCtx = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor" },
      "MLB",
    );
    // Sem limpar o cache: se a chave não considerasse o contexto, o resultado
    // "grudaria" e o enriquecimento não teria efeito nenhum.
    const comCtx = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor", brand: "Chevrolet", model: "Onix", year: "2014" },
      "MLB",
    );
    expect(comCtx.suggestions[0].score).toBeGreaterThan(
      semCtx.suggestions[0].score,
    );
  });
});

describe("(d) tokens de veículo não são evidência de tipo de peça", () => {
  it("o caso real: retrovisor não vira fechadura", async () => {
    const r = await CategorySuggestionService.suggestFromTitle(
      TITULO_REAL,
      "MLB",
    );
    expect(r.suggestions[0].categoryId).toBe("MLB_RETRO_LAT");
  });

  it("o alias de fechadura não pontua só por casar o veículo", async () => {
    const r = await CategorySuggestionService.suggestFromTitle(
      TITULO_REAL,
      "MLB",
    );
    const fechadura = r.suggestions.find(
      (s) => s.categoryId === "MLB_FECHADURA",
    );
    expect(fechadura).toBeUndefined();
  });

  it("com o kill-switch, o defeito anterior é reproduzido (byte-idêntico)", async () => {
    process.env.CATEGORY_SUGGEST_V2_DISABLED = "1";
    clearCaches();
    const r = await CategorySuggestionService.suggestFromTitle(
      TITULO_REAL,
      "MLB",
    );
    // Comportamento ANTERIOR: fechadura vence com 6 (tokens do veículo) + 3
    // (marca) + 2 (modelo) = 11, contra 2 do retrovisor.
    expect(r.suggestions[0].categoryId).toBe("MLB_FECHADURA");
    expect(r.suggestions[0].autoApply).toBe(true);
  });

  it("ano puro nunca conta como token de peça", async () => {
    const r = await CategorySuggestionService.suggestFromTitle(
      "Peça 2011 2012 Volkswagen Fox",
      "MLB",
    );
    expect(
      r.suggestions.find((s) => s.categoryId === "MLB_FECHADURA"),
    ).toBeUndefined();
  });
});

describe("(e) marca/modelo/ano do formulário", () => {
  it("casam mesmo quando o título não os menciona", async () => {
    const semCtx = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor" },
      "MLB",
    );
    clearCaches();
    const comCtx = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor", brand: "Chevrolet", model: "Onix", year: "2014" },
      "MLB",
    );
    expect(comCtx.suggestions[0].categoryId).toBe("MLB_AMORT");
    expect(comCtx.suggestions[0].score).toBeGreaterThan(
      semCtx.suggestions[0].score,
    );
    expect(comCtx.suggestions[0].reasons).toEqual(
      expect.arrayContaining(["marca: Chevrolet", "modelo: Onix", "ano: 2014"]),
    );
  });

  it("o contexto NÃO entra no saco de tokens (não dilui o matchRatio)", async () => {
    const r = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor", brand: "Chevrolet", model: "Onix" },
      "MLB",
    );
    // A régua mostrou que despejar o contexto na tokenização derruba a Shopee
    // de 73,3% para 41,5% de top-1.
    expect(r.tokens).toEqual(["amortecedor"]);
    expect(r.normalizedTitle).toBe("amortecedor");
  });

  it("contexto sem casamento não inventa pontuação", async () => {
    const r = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor", brand: "Ferrari", model: "F40" },
      "MLB",
    );
    expect(r.suggestions[0].reasons).not.toEqual(
      expect.arrayContaining(["marca: Chevrolet"]),
    );
  });
});

describe("(g) coerência de qualificador", () => {
  it("título 'interno' vs candidato 'lateral' é contradição -> block", () => {
    expect(
      coherenceVerdict(
        new Set(["retrovisor", "interno"]),
        new Set(["espelhos", "retrovisores", "laterais"]),
      ),
    ).toBe("block");
  });

  it("candidato 'internos' sem apoio no título -> penalize", () => {
    expect(
      coherenceVerdict(
        new Set(["retrovisor", "direito"]),
        new Set(["espelhos", "retrovisores", "internos"]),
      ),
    ).toBe("penalize");
  });

  it("sem qualificador em conflito -> ok", () => {
    expect(
      coherenceVerdict(new Set(["amortecedor"]), new Set(["amortecedores"])),
    ).toBe("ok");
  });

  it("dianteiro x traseiro é contradição", () => {
    expect(
      coherenceVerdict(
        new Set(["farol", "dianteiro"]),
        new Set(["lanternas", "traseiras"]),
      ),
    ).toBe("block");
  });

  it("o guard nunca zera a lista inteira", async () => {
    // Só existe candidato 'interno' e o título não o sustenta: em vez de
    // devolver vazio, a lista anterior é mantida.
    mockListWithCategory.mockResolvedValue([ALIASES[2]]);
    mockListWithParents.mockResolvedValue([CATEGORIES[2]]);
    clearCaches();
    const r = await CategorySuggestionService.suggestFromTitle(
      "Retrovisor Direito",
      "MLB",
    );
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});

describe("(f) auto-aplicar exige convergência real", () => {
  it("um sinal só nunca auto-aplica, por mais confiante que seja", () => {
    expect(
      shouldAutoApplyV2({ confidence: 0.99, signalCount: 1, coherence: "ok" }),
    ).toBe(false);
  });

  it("dois sinais só auto-aplicam com confiança muito alta", () => {
    expect(
      shouldAutoApplyV2({ confidence: 0.85, signalCount: 2, coherence: "ok" }),
    ).toBe(false);
    expect(
      shouldAutoApplyV2({ confidence: 0.92, signalCount: 2, coherence: "ok" }),
    ).toBe(true);
  });

  it("três sinais auto-aplicam a partir de 0,8", () => {
    expect(
      shouldAutoApplyV2({ confidence: 0.8, signalCount: 3, coherence: "ok" }),
    ).toBe(true);
    expect(
      shouldAutoApplyV2({ confidence: 0.79, signalCount: 3, coherence: "ok" }),
    ).toBe(false);
  });

  it("candidato reprovado na coerência NUNCA auto-aplica", () => {
    expect(
      shouldAutoApplyV2({
        confidence: 0.99,
        signalCount: 4,
        coherence: "penalize",
      }),
    ).toBe(false);
  });
});

describe("(h) shape só ganha campos", () => {
  it("as chaves do retorno não mudam", async () => {
    const r = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor", brand: "Chevrolet" },
      "MLB",
    );
    expect(Object.keys(r).sort()).toEqual([
      "normalizedTitle",
      "suggestions",
      "tokens",
    ]);
  });

  it("signalCount é exposto para a decisão de auto-aplicar ser auditável", async () => {
    const r = await CategorySuggestionService.suggestFromProduct(
      { title: "Amortecedor", brand: "Chevrolet", model: "Onix", year: "2014" },
      "MLB",
    );
    expect(typeof r.suggestions[0].signalCount).toBe("number");
    expect(r.suggestions[0].signalCount).toBeGreaterThanOrEqual(3);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Integração da inferência por tipo de peça no CategorySuggestionService.
 *
 * Invariantes provadas aqui (as que protegem produção):
 *  (a) kill-switch: com CATEGORY_INFERENCE_DISABLED=1 o resultado é
 *      PROFUNDAMENTE igual ao do fluxo sem votos (comportamento antigo);
 *  (b) fail-open: engine explodindo → resultado igual ao baseline;
 *  (c) título curto SHP com tipo conhecido passa a sugerir ("Farol");
 *      sem voto, continua vazio como sempre;
 *  (d) alias que hoje auto-aplica continua auto-aplicando;
 *  (e) voto para categoria de domínio incompatível é bloqueado;
 *  (f) shape da resposta: só campos aditivos;
 *  (g) concordância alias+mapa eleva confiança e liga autoApply;
 *  (h) monotonicidade: voto para OUTRA categoria não rebaixa as existentes.
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

import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";

const MLB_ALIASES = [
  {
    id: "alias-porta",
    tokens: "porta,portas",
    synonyms: "",
    brandModelPatterns: null,
    marketplaceCategory: {
      externalId: "MLB101763",
      name: "Portas",
      fullPath: "Acessórios para Veículos > Carroceria > Portas",
    },
  },
  {
    id: "alias-amortecedor",
    tokens: "amortecedor,amortecedores",
    synonyms: "",
    brandModelPatterns: JSON.stringify({
      brand: "Chevrolet",
      model: "Onix",
      years: ["2014"],
    }),
    marketplaceCategory: {
      externalId: "MLB22709",
      name: "Amortecedores",
      fullPath: "Acessórios para Veículos > Suspensão > Amortecedores",
    },
  },
];

const MLB_CATEGORIES = [
  {
    id: "cat-portas",
    externalId: "MLB101763",
    name: "Portas",
    fullPath: "Acessórios para Veículos > Carroceria > Portas",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "cat-amort",
    externalId: "MLB22709",
    name: "Amortecedores",
    fullPath: "Acessórios para Veículos > Suspensão > Amortecedores",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "cat-farois",
    externalId: "MLB7863",
    name: "Faróis Dianteiros",
    fullPath: "Acessórios para Veículos > Iluminação > Faróis Dianteiros",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "cat-beleza",
    externalId: "MLB999BELEZA",
    name: "Pentes",
    fullPath: "Beleza e Cuidado Pessoal > Cabelo > Pentes",
    parentExternalId: null,
    siteId: "MLB",
  },
];

const SHP_CATEGORIES = [
  {
    id: "shp-farois",
    externalId: "SHP_102297",
    name: "Faróis e Kit Frontal",
    fullPath:
      "Peças e Acessórios para Veículos > Iluminação > Faróis e Kit Frontal",
    parentExternalId: null,
    siteId: "SHP",
  },
];

function clearCaches() {
  const svc = CategorySuggestionService as any;
  svc.aliasCacheMap = new Map();
  svc.categoryCacheMap = new Map();
  svc.parentMapCache = new Map();
  svc.tokenFreqCache = new Map();
  svc.catTokenCache = new Map();
  svc.aliasTokenCache = new Map();
  svc.suggestResultCache?.clear?.();
}

const vote = (
  externalId: string,
  strength: number,
  signal = "part-type-map",
) => ({
  externalId,
  strength,
  signal,
  reason: `voto de teste (${signal})`,
});

const noVotes = { votes: [], pieceType: null };

describe("CategorySuggestionService — fusão da inferência", () => {
  beforeEach(() => {
    clearCaches();
    vi.clearAllMocks();
    mockListWithCategory.mockResolvedValue(MLB_ALIASES);
    mockListWithParents.mockImplementation(async (siteId: string) =>
      siteId === "SHP" ? SHP_CATEGORIES : MLB_CATEGORIES,
    );
    mockCollectVotes.mockResolvedValue(noVotes);
  });

  afterEach(() => {
    delete process.env.CATEGORY_INFERENCE_DISABLED;
  });

  it("(a) kill-switch reproduz o comportamento antigo byte a byte", async () => {
    // Baseline: engine ativo mas sem votos (fluxo antigo).
    const baseline = await CategorySuggestionService.suggestFromTitle(
      "Porta Palio 2010",
      "MLB",
    );

    clearCaches();
    mockCollectVotes.mockResolvedValue({
      votes: [vote("MLB101763", 0.9)],
      pieceType: "porta",
    });
    process.env.CATEGORY_INFERENCE_DISABLED = "1";
    const disabled = await CategorySuggestionService.suggestFromTitle(
      "Porta Palio 2010",
      "MLB",
    );

    expect(disabled).toEqual(baseline);
    expect(mockCollectVotes).toHaveBeenCalledTimes(1); // só no baseline
  });

  it("(b) engine explodindo → resultado igual ao baseline (fail-open)", async () => {
    const baseline = await CategorySuggestionService.suggestFromTitle(
      "Porta Palio 2010",
      "MLB",
    );

    clearCaches();
    mockCollectVotes.mockRejectedValue(new Error("db caiu"));
    const failed = await CategorySuggestionService.suggestFromTitle(
      "Porta Palio 2010",
      "MLB",
    );

    expect(failed).toEqual(baseline);
  });

  it("(c) 'Farol' (1 token, SHP) passa a sugerir com voto; sem voto segue vazio", async () => {
    // Sem voto: guard antigo (vazio).
    const semVoto = await CategorySuggestionService.suggestFromTitle(
      "Farol",
      "SHP",
    );
    expect(semVoto.suggestions).toEqual([]);

    clearCaches();
    mockCollectVotes.mockResolvedValue({
      votes: [vote("SHP_102297", 0.9)],
      pieceType: "farol",
    });
    const comVoto = await CategorySuggestionService.suggestFromTitle(
      "Farol",
      "SHP",
    );
    // O soft-fallback automotivo pré-cria a entrada (keyword@0.1); a fusão a
    // ENRIQUECE — o que importa ao front: top-1, confiança alta, autoApply.
    expect(comVoto.suggestions[0]).toMatchObject({
      categoryId: "SHP_102297",
      autoApply: true,
      pieceType: "farol",
    });
    expect(comVoto.suggestions[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("(d) alias forte que hoje auto-aplica continua auto-aplicando", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "Amortecedor Chevrolet Onix 2014",
      "MLB",
    );
    const top = result.suggestions[0];
    expect(top.categoryId).toBe("MLB22709");
    expect(top.source).toBe("alias");
    expect(top.autoApply).toBe(true);
  });

  it("(e) voto para categoria de domínio incompatível é bloqueado", async () => {
    mockCollectVotes.mockResolvedValue({
      votes: [vote("MLB999BELEZA", 0.9)],
      pieceType: "farol",
    });
    const result = await CategorySuggestionService.suggestFromTitle(
      "Farol Gol G5 2010",
      "MLB",
    );
    expect(
      result.suggestions.find((s) => s.categoryId === "MLB999BELEZA"),
    ).toBeUndefined();
  });

  it("(f) shape aditivo: as chaves do resultado não mudam com a fusão", async () => {
    mockCollectVotes.mockResolvedValue({
      votes: [vote("MLB7863", 0.9)],
      pieceType: "farol",
    });
    const result = await CategorySuggestionService.suggestFromTitle(
      "Farol Gol G5 2010",
      "MLB",
    );
    expect(Object.keys(result).sort()).toEqual([
      "normalizedTitle",
      "suggestions",
      "tokens",
    ]);
    const top = result.suggestions.find((s) => s.categoryId === "MLB7863")!;
    // Todas as chaves da sugestão nova já existem no tipo atual.
    const allowed = new Set([
      "categoryId",
      "fullPath",
      "score",
      "source",
      "attributes",
      "measurements",
      "title",
      "confidence",
      "autoApply",
      "reasons",
      "pieceType",
      // Aditivo (04/08/2026): quantos sinais DISTINTOS sustentam a sugestão.
      // A recalibragem do auto-aplicar consulta este campo em vez de contar
      // `reasons`. O invariante que esta spec protege continua o mesmo: a
      // resposta só GANHA chaves, nunca perde.
      "signalCount",
    ]);
    for (const key of Object.keys(top)) {
      expect(allowed.has(key), `chave inesperada: ${key}`).toBe(true);
    }
  });

  it("(g) concordância alias+mapa eleva a confiança e liga autoApply (caso 'porta')", async () => {
    // Baseline sem voto: alias de token único = confiança baixa, sem autoApply.
    const antes = await CategorySuggestionService.suggestFromTitle(
      "porta",
      "MLB",
    );
    const aliasOnly = antes.suggestions[0];
    expect(aliasOnly.categoryId).toBe("MLB101763");
    expect(aliasOnly.autoApply).toBe(false);

    clearCaches();
    mockCollectVotes.mockResolvedValue({
      votes: [vote("MLB101763", 0.9)],
      pieceType: "porta",
    });
    const depois = await CategorySuggestionService.suggestFromTitle(
      "porta",
      "MLB",
    );
    const fused = depois.suggestions[0];
    expect(fused.categoryId).toBe("MLB101763");
    // Nunca piora; com concordância, sobe e auto-aplica.
    expect(fused.confidence!).toBeGreaterThanOrEqual(aliasOnly.confidence!);
    expect(fused.confidence!).toBeGreaterThanOrEqual(0.9);
    expect(fused.autoApply).toBe(true);
    expect(fused.source).toBe("alias"); // entrada existente é ENRIQUECIDA, não substituída
  });

  it("(h) voto para OUTRA categoria não rebaixa as sugestões existentes", async () => {
    const antes = await CategorySuggestionService.suggestFromTitle(
      "porta",
      "MLB",
    );
    const aliasAntes = antes.suggestions.find(
      (s) => s.categoryId === "MLB101763",
    )!;

    clearCaches();
    mockCollectVotes.mockResolvedValue({
      votes: [vote("MLB7863", 0.9)],
      pieceType: "farol",
    });
    const depois = await CategorySuggestionService.suggestFromTitle(
      "porta",
      "MLB",
    );

    const aliasDepois = depois.suggestions.find(
      (s) => s.categoryId === "MLB101763",
    )!;
    expect(aliasDepois.confidence).toBe(aliasAntes.confidence);
    expect(aliasDepois.score).toBe(aliasAntes.score);
    expect(aliasDepois.autoApply).toBe(aliasAntes.autoApply);
    // E a categoria votada entra como sugestão nova.
    expect(
      depois.suggestions.find((s) => s.categoryId === "MLB7863"),
    ).toMatchObject({ source: "curated" });
  });
});

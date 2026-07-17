import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Bloco B — restrição de nicho na SUGESTÃO MLB.
 * Prova: (a) título ambíguo (sem sinal automotivo) tem candidato fora da raiz
 * veicular DROPADO quando há candidato dentro; (b) fail-open "nunca zera": se o
 * filtro derrubaria todas, mantém as originais; (c) fail-open set vazio.
 *
 * `getVehicleRootSet` é mockado para controlar o conjunto veicular de forma
 * independente da árvore de categorias (que alimenta as sugestões-base).
 */

const {
  mockListWithCategory,
  mockListWithParents,
  mockCollectVotes,
  mockGetVehicleRootSet,
} = vi.hoisted(() => ({
  mockListWithCategory: vi.fn(),
  mockListWithParents: vi.fn(),
  mockCollectVotes: vi.fn(),
  mockGetVehicleRootSet: vi.fn(),
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
  getVehicleRootSet: mockGetVehicleRootSet,
  __resetCategoryGuardCacheForTests: () => {},
}));

import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";

// Árvore que alimenta as sugestões-base (não define o conjunto veicular aqui).
const MLB_TREE = [
  {
    id: "c2",
    externalId: "MLB7863",
    parentExternalId: "MLB1743",
    name: "Faróis",
    fullPath: "Acessórios para Veículos > Peças de Carros > Faróis",
    siteId: "MLB",
  },
  {
    id: "c3",
    externalId: "MLB_ELETRO",
    parentExternalId: "MLB_ELETRO_ROOT",
    name: "Cabos",
    fullPath: "Eletronicos > Audio > Cabos",
    siteId: "MLB",
  },
];

// Tokens NÃO-automotivos → detectDomain=null (título ambíguo): só o filtro de
// nicho atua (o blocklist de domínio nem roda).
const ALIASES = [
  {
    id: "a-alfa",
    tokens: "alfacomp,alfacomps",
    synonyms: "",
    brandModelPatterns: null,
    marketplaceCategory: {
      externalId: "MLB7863",
      name: "Faróis",
      fullPath: "Acessórios para Veículos > Peças de Carros > Faróis",
    },
  },
  {
    id: "a-beta",
    tokens: "betacomp,betacomps",
    synonyms: "",
    brandModelPatterns: null,
    marketplaceCategory: {
      externalId: "MLB_ELETRO",
      name: "Cabos",
      fullPath: "Eletronicos > Audio > Cabos",
    },
  },
];

// Conjunto veicular: MLB7863 dentro, MLB_ELETRO fora.
const VEHICLE_SET = new Set(["MLB5672", "MLB1743", "MLB7863"]);

function clearSuggestionCaches() {
  const svc = CategorySuggestionService as any;
  svc.aliasCacheMap = new Map();
  svc.categoryCacheMap = new Map();
  svc.parentMapCache = new Map();
  svc.tokenFreqCache = new Map();
  svc.catTokenCache = new Map();
  svc.aliasTokenCache = new Map();
  svc.suggestResultCache?.clear?.();
}

const idsOf = (r: { suggestions: Array<{ categoryId: string }> }) =>
  r.suggestions.map((s) => s.categoryId);

describe("CategorySuggestionService — restrição de nicho MLB", () => {
  beforeEach(() => {
    clearSuggestionCaches();
    vi.clearAllMocks();
    mockListWithCategory.mockResolvedValue(ALIASES);
    mockListWithParents.mockResolvedValue(MLB_TREE);
    mockCollectVotes.mockResolvedValue({ votes: [], pieceType: null });
    mockGetVehicleRootSet.mockResolvedValue(VEHICLE_SET);
  });

  it("dropa candidato fora da raiz veicular quando há candidato dentro", async () => {
    const res = await CategorySuggestionService.suggestFromTitle(
      "alfacomp betacomp",
      "MLB",
    );
    const ids = idsOf(res);
    expect(ids).toContain("MLB7863");
    expect(ids).not.toContain("MLB_ELETRO");
  });

  it("nunca zera: se o filtro derrubaria TODAS, mantém as originais (fail-open)", async () => {
    const res = await CategorySuggestionService.suggestFromTitle(
      "betacomp",
      "MLB",
    );
    // Único candidato é fora da raiz → fail-open o mantém (não some tudo).
    expect(idsOf(res)).toContain("MLB_ELETRO");
  });

  it("fail-open com conjunto veicular vazio (árvore não sincronizada): não filtra", async () => {
    mockGetVehicleRootSet.mockResolvedValue(new Set());
    const res = await CategorySuggestionService.suggestFromTitle(
      "alfacomp betacomp",
      "MLB",
    );
    const ids = idsOf(res);
    expect(ids).toContain("MLB7863");
    expect(ids).toContain("MLB_ELETRO");
  });

  it("não filtra Shopee pela raiz veicular do ML (siteId SHP intacto)", async () => {
    const res = await CategorySuggestionService.suggestFromTitle(
      "alfacomp betacomp",
      "SHP",
    );
    // getVehicleRootSet nem é consultado para SHP.
    expect(mockGetVehicleRootSet).not.toHaveBeenCalled();
    expect(idsOf(res)).toContain("MLB_ELETRO");
  });
});

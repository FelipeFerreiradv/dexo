import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for enriched CategorySuggestionService output:
 * - confidence scoring (0-1)
 * - autoApply flag (only when multiple signals converge)
 * - reasons array (human-readable explanation)
 * - pieceType detection
 * - SHP (Shopee) guards: domain blocking, min-token, IDF weighting
 */

// ── Shared test data ──

const MLB_ALIASES = [
  {
    id: "alias-1",
    tokens: "amortecedor,amortecedores",
    synonyms: "absorvedor,shock",
    brandModelPatterns: JSON.stringify({
      brand: "Chevrolet",
      model: "Onix",
      years: ["2014", "2015"],
      measurements: { heightCm: 50, widthCm: 15, lengthCm: 15, weightKg: 2 },
    }),
    marketplaceCategory: {
      externalId: "MLB22648",
      name: "Suspensão > Amortecedores",
      fullPath: "Acessórios > Peças > Suspensão > Amortecedores",
    },
  },
  {
    id: "alias-2",
    tokens: "porta,portas",
    synonyms: "door",
    brandModelPatterns: JSON.stringify({ brand: "Fiat" }),
    marketplaceCategory: {
      externalId: "MLB101763",
      name: "Carroceria > Portas",
      fullPath: "Acessórios > Peças > Carroceria > Portas",
    },
  },
];

const MLB_CATEGORIES = [
  {
    id: "cat-1",
    externalId: "MLB22648",
    name: "Suspensão > Amortecedores",
    fullPath: "Acessórios > Peças > Suspensão > Amortecedores",
    parentExternalId: "MLB1748",
    siteId: "MLB",
  },
  {
    id: "cat-1p",
    externalId: "MLB1748",
    name: "Suspensão",
    fullPath: "Acessórios > Peças > Suspensão",
    parentExternalId: null,
    siteId: "MLB",
  },
  {
    id: "cat-2",
    externalId: "MLB101763",
    name: "Carroceria > Portas",
    fullPath: "Acessórios > Peças > Carroceria > Portas",
    parentExternalId: "MLB1754",
    siteId: "MLB",
  },
  {
    id: "cat-2p",
    externalId: "MLB1754",
    name: "Carroceria",
    fullPath: "Acessórios > Peças > Carroceria",
    parentExternalId: null,
    siteId: "MLB",
  },
];

const SHP_CATEGORIES = [
  {
    id: "shp-1",
    externalId: "SHP_100001",
    name: "Peças Automotivas",
    fullPath: "Automotivo > Peças Automotivas",
    parentExternalId: null,
    siteId: "SHP",
  },
  {
    id: "shp-2",
    externalId: "SHP_100002",
    name: "Grades e Para-choques",
    fullPath: "Automotivo > Peças Automotivas > Grades e Para-choques",
    parentExternalId: "SHP_100001",
    siteId: "SHP",
  },
  {
    id: "shp-3",
    externalId: "SHP_200001",
    name: "Frisbee e Discos",
    fullPath: "Esporte > Frisbee e Discos",
    parentExternalId: null,
    siteId: "SHP",
  },
  {
    id: "shp-4",
    externalId: "SHP_300001",
    name: "Beleza e Cuidados",
    fullPath: "Beleza > Cabelo > Pentes e Grades",
    parentExternalId: null,
    siteId: "SHP",
  },
  {
    id: "shp-5",
    externalId: "SHP_100003",
    name: "Filtros Automotivos",
    fullPath: "Automotivo > Peças Automotivas > Filtros Automotivos",
    parentExternalId: "SHP_100001",
    siteId: "SHP",
  },
];

// ── Single mock for both repos (vi.mock is hoisted — only one per module) ──
// vi.hoisted() ensures the fns are available when the hoisted vi.mock runs

const { mockListWithCategory, mockListWithParents } = vi.hoisted(() => ({
  mockListWithCategory: vi.fn(),
  mockListWithParents: vi.fn(),
}));

vi.mock("../app/marketplaces/repositories/category-alias.repository", () => ({
  default: { listWithCategory: mockListWithCategory },
  CategoryAliasRepository: { listWithCategory: mockListWithCategory },
}));

vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  default: { listWithParents: mockListWithParents },
}));

import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";

function clearCaches() {
  (CategorySuggestionService as any).aliasCacheMap = new Map();
  (CategorySuggestionService as any).categoryCacheMap = new Map();
  (CategorySuggestionService as any).parentMapCache = new Map();
  (CategorySuggestionService as any).tokenFreqCache = new Map();
  (CategorySuggestionService as any).catTokenCache = new Map();
  (CategorySuggestionService as any).aliasTokenCache = new Map();
}

// ────────────────────────────────────────────────────────────────────────
// MLB tests (alias-based matching)
// ────────────────────────────────────────────────────────────────────────

describe("CategorySuggestionService enriched output", () => {
  beforeEach(() => {
    clearCaches();
    mockListWithCategory.mockResolvedValue(MLB_ALIASES);
    mockListWithParents.mockResolvedValue(MLB_CATEGORIES);
  });

  it("returns confidence, autoApply, reasons and pieceType for a strong multi-signal match", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "Amortecedor Chevrolet Onix 2014",
      "MLB",
    );

    expect(result.suggestions.length).toBeGreaterThan(0);

    const top = result.suggestions[0];
    expect(top.categoryId).toBe("MLB22648");
    expect(top.confidence).toBeDefined();
    expect(top.confidence).toBeGreaterThan(0.5);
    expect(top.autoApply).toBe(true); // multiple signals: token + brand + year
    expect(top.reasons).toBeDefined();
    expect(top.reasons!.length).toBeGreaterThan(0);
    expect(top.pieceType).toBe("amortecedor");
    expect(top.measurements).toBeDefined();
    expect(top.measurements!.heightCm).toBe(50);
  });

  it("does NOT autoApply for a weak single-signal match", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "porta",
      "MLB",
    );

    expect(result.suggestions.length).toBeGreaterThan(0);

    const top = result.suggestions[0];
    expect(top.categoryId).toBe("MLB101763");
    // Single token match = low confidence, should not autoApply
    expect(top.autoApply).toBe(false);
    expect(top.confidence).toBeDefined();
    expect(top.confidence).toBeLessThan(0.65);
  });

  it("returns reasons explaining the score components", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "Amortecedor Chevrolet Onix 2015",
      "MLB",
    );

    const top = result.suggestions[0];
    expect(top.reasons).toBeDefined();
    // Should mention direct tokens and brand at minimum
    const reasonsStr = top.reasons!.join(" ");
    expect(reasonsStr).toContain("amortecedor");
    expect(reasonsStr).toContain("Chevrolet");
  });

  it("does not autoApply keyword-only fallback matches", async () => {
    clearCaches();
    // Mock empty aliases to force keyword fallback
    mockListWithCategory.mockResolvedValueOnce([]);

    const result = await CategorySuggestionService.suggestFromTitle(
      "Suspensão genérica",
      "MLB",
    );

    if (result.suggestions.length > 0) {
      const top = result.suggestions[0];
      expect(top.source).toBe("keyword");
      expect(top.autoApply).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// SHP tests — no aliases, keyword-only path with new guards
// ────────────────────────────────────────────────────────────────────────

describe("CategorySuggestionService — SHP (Shopee) guards", () => {
  beforeEach(() => {
    clearCaches();
    // SHP has no aliases; MLB has aliases
    mockListWithCategory.mockImplementation((siteId?: string) => {
      if (siteId === "SHP") return Promise.resolve([]);
      return Promise.resolve(MLB_ALIASES);
    });
    mockListWithParents.mockImplementation((siteId?: string) => {
      if (siteId === "SHP") return Promise.resolve(SHP_CATEGORIES);
      return Promise.resolve(MLB_CATEGORIES);
    });
  });

  it("returns empty suggestions for single-token SHP titles", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "porta",
      "SHP",
    );
    expect(result.suggestions).toHaveLength(0);
  });

  it("never suggests beauty/sport categories for automotive products (SHP)", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "grade traseira automotivo",
      "SHP",
    );

    for (const s of result.suggestions) {
      const pathLower = s.fullPath.toLowerCase();
      expect(pathLower).not.toContain("beleza");
      expect(pathLower).not.toContain("frisbee");
      expect(pathLower).not.toContain("esporte");
      expect(pathLower).not.toContain("cabelo");
    }
  });

  it("keyword-only suggestions never have autoApply=true (SHP)", async () => {
    const result = await CategorySuggestionService.suggestFromTitle(
      "filtro oleo automotivo",
      "SHP",
    );

    for (const s of result.suggestions) {
      expect(s.autoApply).toBe(false);
    }
  });

  it("MLB alias-based matching still works correctly after SHP changes", async () => {
    clearCaches();

    const result = await CategorySuggestionService.suggestFromTitle(
      "Amortecedor Chevrolet Onix 2014",
      "MLB",
    );

    expect(result.suggestions.length).toBeGreaterThan(0);
    const top = result.suggestions[0];
    expect(top.categoryId).toBe("MLB22648");
    expect(top.autoApply).toBe(true);
    expect(top.confidence).toBeGreaterThan(0.5);
  });
});

import { describe, it, expect, vi } from "vitest";

/**
 * Tests for enriched CategorySuggestionService output:
 * - confidence scoring (0-1)
 * - autoApply flag (only when multiple signals converge)
 * - reasons array (human-readable explanation)
 * - pieceType detection
 */

// Mock DB dependencies
vi.mock("../app/marketplaces/repositories/category-alias.repository", () => ({
  default: {
    listWithCategory: vi.fn().mockResolvedValue([
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
        brandModelPatterns: JSON.stringify({
          brand: "Fiat",
        }),
        marketplaceCategory: {
          externalId: "MLB101763",
          name: "Carroceria > Portas",
          fullPath: "Acessórios > Peças > Carroceria > Portas",
        },
      },
    ]),
  },
}));

vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  default: {
    listWithParents: vi.fn().mockResolvedValue([
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
    ]),
  },
}));

import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";

describe("CategorySuggestionService enriched output", () => {
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
    // Clear alias cache to force reload
    (CategorySuggestionService as any).aliasCacheMap = new Map();
    (CategorySuggestionService as any).categoryCacheMap = new Map();

    // Mock empty aliases to force keyword fallback
    const aliasRepo = await import(
      "../app/marketplaces/repositories/category-alias.repository"
    );
    (aliasRepo.default.listWithCategory as any).mockResolvedValueOnce([]);

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

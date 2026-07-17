import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PR "famílias partType-only": o job stats:catalog passa a emitir linhas
 * partType|*|*|* (Sinal B do motor de inferência para produtos sem
 * marca/modelo). Duas garantias aqui:
 *  1. a agregação produz a linha com matchKey/colunas "*" corretos;
 *  2. o /internal/suggest NUNCA casa essas linhas (guard ANY → INSUFFICIENT,
 *     sem sequer consultar o banco).
 */

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/app/lib/prisma", () => ({
  default: { catalogStat: { findFirst } },
}));

// parseTitleToParts real não produz brand="*" — sobrescrevemos só essa função
// para exercitar o guard de cinto-e-suspensório.
const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@/app/marketplaces/lib/title-parse", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseTitleToParts: mockParse };
});

import { InternalSuggestionUseCase } from "@/app/marketplaces/usecases/internal-suggestion.usecase";
import {
  finalizeFamily,
  type FamilyInput,
} from "@/app/marketplaces/lib/catalog-stats-aggregation";

function familyInput(over: Partial<FamilyInput> = {}): FamilyInput {
  return {
    partType: "farol",
    brand: "*",
    model: "*",
    version: "*",
    memberCount: 12,
    prices: [100, 120, 130, 110, 90, 105, 115, 100, 125, 95, 108, 112],
    weights: [],
    heights: [],
    widths: [],
    lengths: [],
    years: [2010, 2015],
    qualities: [],
    partNumbers: [],
    versions: [],
    sourceVehicles: [],
    mlCategoryIds: ["cuid-farois", "cuid-farois", "cuid-farois", "cuid-outra"],
    shopeeCategoryIds: [],
    attributesList: [],
    compatibilities: [],
    ...over,
  };
}

describe("família partType-only na agregação", () => {
  it("emite linha com colunas e matchKey em '*' e moda de categoria", () => {
    const row = finalizeFamily(familyInput());
    expect(row).not.toBeNull();
    expect(row!.matchKey).toBe("farol|*|*|*|2010-2015");
    expect(row!.brand).toBe("*");
    expect(row!.model).toBe("*");
    expect(row!.version).toBe("*");
    expect(row!.mlCategoryIdMode).toBe("cuid-farois");
    expect(row!.mlCategoryIdModeCount).toBe(3);
  });

  it("gate de amostra continua valendo (< 5 membros → null)", () => {
    expect(finalizeFamily(familyInput({ memberCount: 4 }))).toBeNull();
  });
});

describe("guard ANY no /internal/suggest", () => {
  beforeEach(() => {
    findFirst.mockReset();
    InternalSuggestionUseCase.__clearCache();
  });

  it("cols com '*' → INSUFFICIENT sem consultar o banco", async () => {
    mockParse.mockReturnValue({
      partType: "farol",
      position: null,
      brand: "*",
      model: "*",
      version: null,
      year: null,
    });
    const res = await InternalSuggestionUseCase.suggestFromTitle("qualquer");
    expect(res).toEqual({ suggestion: null, reason: "insufficient_sample" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("entidades reais seguem funcionando (regressão da cascata)", async () => {
    mockParse.mockReturnValue({
      partType: "farol",
      position: null,
      brand: "Fiat",
      model: "Palio",
      version: null,
      year: null,
    });
    findFirst.mockResolvedValue(null);
    const res = await InternalSuggestionUseCase.suggestFromTitle(
      "Farol Fiat Palio",
    );
    expect(res).toEqual({ suggestion: null, reason: "insufficient_sample" });
    // Chegou a consultar (nível 3) — o guard não bloqueou entidades reais.
    expect(findFirst).toHaveBeenCalled();
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      partType: "farol",
      brand: "fiat",
      model: "palio",
      version: "*",
    });
  });
});

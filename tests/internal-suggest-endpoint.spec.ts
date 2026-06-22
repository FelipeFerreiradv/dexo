import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock do prisma ANTES de importar o usecase (default export). vi.mock é
// içado ao topo, então o mock fn precisa vir de vi.hoisted.
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/app/lib/prisma", () => ({
  default: { catalogStat: { findFirst } },
}));

import { InternalSuggestionUseCase } from "@/app/marketplaces/usecases/internal-suggestion.usecase";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "cs1",
    matchKey: "cubo-de-roda|fiat|uno|*|2008-2014",
    partType: "cubo-de-roda",
    brand: "fiat",
    model: "uno",
    version: "*",
    yearFrom: 2008,
    yearTo: 2014,
    sampleSize: 23,
    priceSampleSize: 21,
    priceMedian: "89.90",
    weightKgMedian: "1.20",
    heightCmMedian: 12,
    widthCmMedian: 12,
    lengthCmMedian: 14,
    qualityMode: "SEMINOVO",
    qualityModeCount: 12,
    partNumberMode: "51234567",
    partNumberModeCount: 9,
    versionMode: null,
    versionModeCount: null,
    sourceVehicleMode: "Fiat Uno 1.0",
    sourceVehicleModeCount: 7,
    mlCategoryIdMode: "MLB1765-01",
    mlCategoryIdModeCount: 10,
    shopeeCategoryIdMode: null,
    shopeeCategoryIdModeCount: null,
    attributes: { MATERIAL: { value_name: "Aço", freq: 8 } },
    compatibilities: [
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: 2008,
        yearTo: 2014,
        version: null,
        freq: 12,
      },
    ],
    computedAt: new Date("2026-06-22T03:00:00Z"),
    ...over,
  };
}

const hasYearClause = (where: any) =>
  where?.yearFrom !== undefined || where?.yearTo !== undefined;

beforeEach(() => {
  findFirst.mockReset();
  InternalSuggestionUseCase.__clearCache();
});

describe("InternalSuggestionUseCase — cascata", () => {
  it("alta: ano dentro da faixa casa a linha version-agnóstica", async () => {
    findFirst.mockImplementation(async ({ where }: any) =>
      hasYearClause(where) ? row() : null,
    );
    const res = await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno 2010",
    );
    expect(res.suggestion).not.toBeNull();
    expect(res.suggestion!.confidence).toBe("alta");
    expect(res.suggestion!.sampleSize).toBe(23);
    expect(res.suggestion!.fields.priceMedian).toBe(89.9);
    expect(res.suggestion!.fields.brand).toBe("Fiat");
    expect(res.suggestion!.fields.year).toBe("2010");
  });

  it("baixa: ano fora da faixa cai na linha sem ano", async () => {
    findFirst.mockImplementation(async ({ where }: any) =>
      hasYearClause(where) ? null : row(),
    );
    const res = await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno 2024",
    );
    expect(res.suggestion!.confidence).toBe("baixa");
  });

  it("media: sem ano no título usa a linha agnóstica", async () => {
    findFirst.mockImplementation(async ({ where }: any) =>
      hasYearClause(where) ? null : row(),
    );
    const res = await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno",
    );
    expect(res.suggestion!.confidence).toBe("media");
  });

  it("insufficient_sample quando nenhuma linha casa", async () => {
    findFirst.mockResolvedValue(null);
    const res = await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno 2010",
    );
    expect(res.suggestion).toBeNull();
    expect((res as any).reason).toBe("insufficient_sample");
  });

  it("insufficient_sample quando faltam partType/brand/model (sem ir ao banco)", async () => {
    const res =
      await InternalSuggestionUseCase.suggestFromTitle("coisa qualquer");
    expect(res.suggestion).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("InternalSuggestionUseCase — contrato e privacidade", () => {
  it("strip de freq em attributes/compatibilities e zero campos de custo", async () => {
    findFirst.mockImplementation(async ({ where }: any) =>
      hasYearClause(where) ? row() : null,
    );
    const res = await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno 2010",
    );
    const s = res.suggestion!;
    expect(s.source).toBe("internal");
    // freq removido
    expect((s.attributes!.MATERIAL as any).freq).toBeUndefined();
    expect(s.attributes!.MATERIAL.value_name).toBe("Aço");
    expect((s.compatibilities![0] as any).freq).toBeUndefined();
    expect(s.compatibilities![0].brand).toBe("Fiat");
    // privacidade: serialização não contém custo/margem/userId
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/costPrice|markup|userId/i);
  });

  it("usa cache (uma ida ao banco para o mesmo título)", async () => {
    findFirst.mockImplementation(async ({ where }: any) =>
      hasYearClause(where) ? row() : null,
    );
    await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno 2010",
    );
    const callsAfterFirst = findFirst.mock.calls.length;
    await InternalSuggestionUseCase.suggestFromTitle(
      "Cubo de Roda Fiat Uno 2010",
    );
    expect(findFirst.mock.calls.length).toBe(callsAfterFirst);
  });
});

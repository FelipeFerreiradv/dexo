import { describe, it, expect } from "vitest";
import { OlxCategoryResolutionService } from "../olx-category-resolution.service";
import { OLX_AUTOPARTS_CATEGORY } from "../../olx/olx-category-map";

describe("OlxCategoryResolutionService.resolveCategoryId", () => {
  it("prioriza olxCategoryId explícito do produto", () => {
    expect(
      OlxCategoryResolutionService.resolveCategoryId({
        olxCategoryId: 999,
        name: "Farol Moto Honda",
      }),
    ).toBe(999);
  });

  it("cai no default (carros) quando não casa nenhum veículo", () => {
    // A Jotabê é majoritariamente peça de carro → sem match, categoria 2101.
    expect(
      OlxCategoryResolutionService.resolveCategoryId({ name: "Farol Gol G4" }),
    ).toBe(OLX_AUTOPARTS_CATEGORY.CARS);
  });

  it("resolve a categoria pelo veículo citado no nome", () => {
    expect(
      OlxCategoryResolutionService.resolveCategoryId({
        name: "Retrovisor Moto Honda CG",
      }),
    ).toBe(OLX_AUTOPARTS_CATEGORY.MOTORCYCLES);
    expect(
      OlxCategoryResolutionService.resolveCategoryId({
        name: "Farol Caminhão Mercedes",
      }),
    ).toBe(OLX_AUTOPARTS_CATEGORY.TRUCKS);
    expect(
      OlxCategoryResolutionService.resolveCategoryId({
        name: "Hélice Barco Mercury",
      }),
    ).toBe(OLX_AUTOPARTS_CATEGORY.BOATS);
  });

  it("word-boundary: 'motor' não é confundido com 'moto'", () => {
    expect(
      OlxCategoryResolutionService.resolveCategoryId({
        name: "Suporte do Motor Gol",
      }),
    ).toBe(OLX_AUTOPARTS_CATEGORY.CARS);
  });
});

describe("OlxCategoryResolutionService.buildAdParams", () => {
  it("condition é sempre preenchido: NOVO → '1', resto → '2'", () => {
    expect(
      OlxCategoryResolutionService.buildAdParams({ quality: "NOVO" }, 2101)
        .condition,
    ).toBe("1");
    expect(
      OlxCategoryResolutionService.buildAdParams({ quality: "SUCATA" }, 2101)
        .condition,
    ).toBe("2");
  });

  it("carros/caminhões/ônibus usam parts_name_cars=4 (Peças automotivas)", () => {
    for (const cat of [2101, 2102, 2105]) {
      const params = OlxCategoryResolutionService.buildAdParams({}, cat);
      expect(params.parts_name_cars).toBe("4");
    }
  });

  it("motos usam parts_name_motos, barcos usam parts_name_boats", () => {
    expect(
      OlxCategoryResolutionService.buildAdParams({}, 2103).parts_name_motos,
    ).toBe("10");
    expect(
      OlxCategoryResolutionService.buildAdParams({}, 2104).parts_name_boats,
    ).toBe("11");
  });

  it("não emite chaves inválidas (marca/modelo/lado) — só as reais da OLX", () => {
    const params = OlxCategoryResolutionService.buildAdParams(
      { brand: "Volkswagen", model: "Gol", name: "Farol Direito Gol" },
      2101,
    );
    expect(params.marca).toBeUndefined();
    expect(params.modelo).toBeUndefined();
    expect(params.lado).toBeUndefined();
    expect(Object.keys(params).sort()).toEqual([
      "condition",
      "parts_name_cars",
    ]);
  });
});

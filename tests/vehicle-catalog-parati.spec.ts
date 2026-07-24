import { describe, it, expect } from "vitest";
import {
  getVehicleBrands,
  getModelsForBrand,
  getYearsForModel,
  getVersionsForModel,
  matchesVehicleQuery,
  normalizeVehicleTerm,
  VEHICLE_SEARCH_ALIASES,
} from "../app/lib/vehicle-catalog";

/**
 * A VW Parati faltava no VEHICLE_CATALOG, então não aparecia nem na aba de
 * compatibilidade do produto nem no cadastro de sucata — apesar de o modelo já
 * ser conhecido em title-parse.ts e category-suggestion.service.ts.
 *
 * O catálogo é fonte única para os dois usos, então uma entrada resolve os dois.
 * O alias de busca existe porque a vendedora escreve "Pareti"; ele NÃO pode
 * virar um segundo modelo no catálogo (isso publicaria compat de um veículo que
 * não existe).
 */
describe("VEHICLE_CATALOG — VW Parati", () => {
  it("expõe Parati entre os modelos da Volkswagen, sem duplicar", () => {
    const models = getModelsForBrand("Volkswagen");
    expect(models).toContain("Parati");
    expect(models.filter((m) => m === "Parati")).toHaveLength(1);
  });

  it("não remove nenhum modelo VW existente", () => {
    const models = getModelsForBrand("Volkswagen");
    for (const esperado of ["Gol", "Golf", "Nivus", "Passat", "Saveiro", "Voyage"]) {
      expect(models).toContain(esperado);
    }
  });

  it("fica ordenada entre Nivus e Passat", () => {
    const models = getModelsForBrand("Volkswagen");
    const i = models.indexOf("Parati");
    expect(models[i - 1]).toBe("Nivus");
    expect(models[i + 1]).toBe("Passat");
  });

  it("cobre 1982 a 2012 sem buraco no intervalo", () => {
    const anos = getYearsForModel("Volkswagen", "Parati");
    expect(anos[0]).toBe(1982);
    expect(anos.at(-1)).toBe(2012);
    expect(anos).toHaveLength(31);
    for (let i = 1; i < anos.length; i++) {
      expect(anos[i]).toBe(anos[i - 1] + 1);
    }
  });

  it("devolve versões reais, ordenadas e sem entrada vazia", () => {
    const versoes = getVersionsForModel("Volkswagen", "Parati");
    expect(versoes.length).toBeGreaterThan(0);
    expect(versoes).not.toContain("");
    expect(versoes).toContain("Surf");
    expect(versoes).toContain("Track & Field");
    expect(versoes).toContain("CL");
    const ordenadas = [...versoes].sort((a, b) => a.localeCompare(b, "pt-BR"));
    expect(versoes).toEqual(ordenadas);
  });

  it("resolve marca e modelo sem depender de caixa", () => {
    expect(getYearsForModel("volkswagen", "parati")).toEqual(
      getYearsForModel("Volkswagen", "Parati"),
    );
    expect(getVersionsForModel("VOLKSWAGEN", "PARATI")).toEqual(
      getVersionsForModel("Volkswagen", "Parati"),
    );
  });

  it("não adiciona marca nova ao catálogo", () => {
    const marcas = getVehicleBrands();
    expect(marcas).toContain("Volkswagen");
    expect(marcas).not.toContain("Parati");
  });
});

describe("matchesVehicleQuery — alias de busca", () => {
  it("acha Parati pelo termo canônico, em qualquer caixa", () => {
    expect(matchesVehicleQuery("Parati", "parati")).toBe(true);
    expect(matchesVehicleQuery("Parati", "PARATI")).toBe(true);
    expect(matchesVehicleQuery("Parati", "Para")).toBe(true);
  });

  it('acha Parati quando o operador digita "Pareti"', () => {
    expect(matchesVehicleQuery("Parati", "Pareti")).toBe(true);
    expect(matchesVehicleQuery("Parati", "pareti")).toBe(true);
    expect(matchesVehicleQuery("Parati", "paratti")).toBe(true);
  });

  it("filtra enquanto o operador ainda está digitando o termo errado", () => {
    expect(matchesVehicleQuery("Parati", "paret")).toBe(true);
    expect(matchesVehicleQuery("Parati", "pare")).toBe(true);
  });

  it("não faz o alias vazar para outros modelos", () => {
    expect(matchesVehicleQuery("Passat", "pareti")).toBe(false);
    expect(matchesVehicleQuery("Gol", "pareti")).toBe(false);
    expect(matchesVehicleQuery("Polo", "paret")).toBe(false);
  });

  it("ignora acento nos dois lados da comparação", () => {
    expect(matchesVehicleQuery("Citroën C3", "citroen")).toBe(true);
    expect(matchesVehicleQuery("Citroen C3", "citroën")).toBe(true);
  });

  it("query vazia ou só espaço não filtra nada", () => {
    expect(matchesVehicleQuery("Parati", "")).toBe(true);
    expect(matchesVehicleQuery("Parati", "   ")).toBe(true);
  });

  it("não casa termo sem relação", () => {
    expect(matchesVehicleQuery("Parati", "civic")).toBe(false);
  });

  it("o alias não vira modelo do catálogo", () => {
    expect(getModelsForBrand("Volkswagen")).not.toContain("Pareti");
    expect(getYearsForModel("Volkswagen", "Pareti")).toEqual([]);
    expect(getVersionsForModel("Volkswagen", "Pareti")).toEqual([]);
  });

  it("mantém chaves e valores do mapa de alias normalizados", () => {
    for (const [errado, certo] of Object.entries(VEHICLE_SEARCH_ALIASES)) {
      expect(errado).toBe(normalizeVehicleTerm(errado));
      expect(certo).toBe(normalizeVehicleTerm(certo));
    }
  });
});

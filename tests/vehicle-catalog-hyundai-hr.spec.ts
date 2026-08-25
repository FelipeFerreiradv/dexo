import { describe, it, expect } from "vitest";
import {
  getVehicleBrands,
  getModelsForBrand,
  getYearsForModel,
  getVersionsForModel,
  matchesVehicleQuery,
} from "../app/lib/vehicle-catalog";
import { detectBrandAndModel } from "../app/marketplaces/lib/title-parse";

/**
 * O Hyundai HR — o utilitario leve 2.5 turbodiesel, concorrente do Kia Bongo —
 * faltava no VEHICLE_CATALOG, entao nao aparecia nem na aba de compatibilidade
 * do produto nem no cadastro de sucata. O catalogo e fonte unica para os dois
 * usos, entao uma entrada resolve os dois.
 *
 * O risco deste bloco NAO e o HR: e o Honda HR-V, que ja existia e tem nome
 * parecido. Os testes de nao-regressao no fim deste arquivo existem para que
 * ninguem "melhore" a busca ou o parser de titulo e passe a classificar peca de
 * Honda como Hyundai em silencio.
 */
const VERSOES_HR = [
  "2.5 TCI",
  "2.5 CRDi",
  "HD",
  "HD Cabine Curta",
  "HD Longo com Caçamba",
  "HD Longo sem Caçamba",
  "Baú",
  "Chassi",
  "4x4",
  "GL",
];

describe("VEHICLE_CATALOG — Hyundai HR", () => {
  it("expõe HR entre os modelos da Hyundai, sem duplicar", () => {
    const models = getModelsForBrand("Hyundai");
    expect(models).toContain("HR");
    expect(models.filter((m) => m === "HR")).toHaveLength(1);
  });

  it("fica ordenado entre HB20X e i30", () => {
    const models = getModelsForBrand("Hyundai");
    const i = models.indexOf("HR");
    expect(models[i - 1]).toBe("HB20X");
    expect(models[i + 1]).toBe("i30");
  });

  it("não remove nenhum modelo Hyundai existente", () => {
    const models = getModelsForBrand("Hyundai");
    for (const esperado of [
      "Azera",
      "Creta",
      "Elantra",
      "HB20",
      "HB20S",
      "HB20X",
      "i30",
      "ix35",
      "Kona",
      "New Tucson",
      "Santa Fe",
      "Tucson",
      "Veloster",
    ]) {
      expect(models).toContain(esperado);
    }
  });

  it("cobre 2005 a 2025 sem buraco no intervalo", () => {
    const anos = getYearsForModel("Hyundai", "HR");
    expect(anos[0]).toBe(2005);
    expect(anos.at(-1)).toBe(2025);
    expect(anos).toHaveLength(21);
    for (let i = 1; i < anos.length; i++) {
      expect(anos[i]).toBe(anos[i - 1] + 1);
    }
  });

  it("devolve exatamente as versões aprovadas, ordenadas e sem entrada vazia", () => {
    const versoes = getVersionsForModel("Hyundai", "HR");
    expect(versoes).toEqual(
      [...VERSOES_HR].sort((a, b) => a.localeCompare(b, "pt-BR")),
    );
    expect(versoes).not.toContain("");
    expect(new Set(versoes).size).toBe(versoes.length);
  });

  it("resolve marca e modelo sem depender de caixa", () => {
    expect(getYearsForModel("hyundai", "hr")).toEqual(
      getYearsForModel("Hyundai", "HR"),
    );
    expect(getVersionsForModel("HYUNDAI", "HR")).toEqual(
      getVersionsForModel("Hyundai", "HR"),
    );
  });

  it("a lista de modelos Hyundai segue ordenada e sem duplicata", () => {
    const modelos = getModelsForBrand("Hyundai");
    expect(modelos).toEqual(
      [...modelos].sort((a, b) => a.localeCompare(b, "pt-BR")),
    );
    expect(new Set(modelos).size).toBe(modelos.length);
  });

  it("não adiciona marca nova ao catálogo", () => {
    const marcas = getVehicleBrands();
    expect(marcas).toContain("Hyundai");
    expect(marcas).not.toContain("HR");
  });

  it('digitar "hr" já acha o HR — o alias de busca é desnecessário', () => {
    expect(matchesVehicleQuery("HR", "hr")).toBe(true);
    expect(matchesVehicleQuery("HR", "HR")).toBe(true);
    expect(matchesVehicleQuery("HR", "h")).toBe(true);
  });
});

/**
 * Nao-regressao do Honda HR-V. "HR" e substring de "HR-V", e a marca e escolhida
 * antes do modelo nos dois consumidores do catalogo — entao os dois convivem.
 * Estes testes travam esse fato.
 */
describe("VEHICLE_CATALOG — Honda HR-V não pode ser afetado pelo HR", () => {
  it("HR-V continua na Honda, com anos e versões intactos", () => {
    const models = getModelsForBrand("Honda");
    expect(models).toContain("HR-V");
    const anos = getYearsForModel("Honda", "HR-V");
    expect(anos[0]).toBe(2015);
    expect(anos.at(-1)).toBe(2025);
    expect(getVersionsForModel("Honda", "HR-V")).toContain("EXL");
  });

  it('buscar "hr" na Honda continua achando o HR-V', () => {
    expect(matchesVehicleQuery("HR-V", "hr")).toBe(true);
    expect(matchesVehicleQuery("HR-V", "hr-v")).toBe(true);
  });

  it("o HR não vaza para a Honda, nem o HR-V para a Hyundai", () => {
    expect(getModelsForBrand("Honda")).not.toContain("HR");
    expect(getModelsForBrand("Hyundai")).not.toContain("HR-V");
    expect(getYearsForModel("Honda", "HR")).toEqual([]);
    expect(getYearsForModel("Hyundai", "HR-V")).toEqual([]);
  });

  it("título de peça de HR-V continua sendo detectado como Honda", () => {
    expect(detectBrandAndModel("parachoque honda hr-v 2020").brand).toBe(
      "Honda",
    );
    expect(detectBrandAndModel("Farol Honda HR-V 2018").brand).toBe("Honda");
    expect(detectBrandAndModel("retrovisor HONDA HRV 2019").brand).toBe(
      "Honda",
    );
  });

  it("título sem marca escrita não passa a ser inferido como Hyundai", () => {
    // Se "hr" entrasse em MODEL_BRAND, este titulo viraria Hyundai/HR — uma
    // peca de Honda classificada como Hyundai, em silencio, em producao.
    expect(detectBrandAndModel("Parachoque HR-V 2020").brand).not.toBe(
      "Hyundai",
    );
  });
});

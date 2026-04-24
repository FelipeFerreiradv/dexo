import { describe, it, expect } from "vitest";
import {
  applyMlCatalogSuggestion,
  CatalogApplyFormValues,
} from "../app/produtos/lib/apply-ml-catalog-suggestion";
import type { CatalogProductDetail } from "../app/marketplaces/usecases/ml-catalog-suggestion.usecase";

function buildDetail(
  overrides: Partial<CatalogProductDetail> = {},
): CatalogProductDetail {
  return {
    catalogProductId: "MLB19765739",
    siteId: "MLB",
    domainId: "MLB-AUTOMOTIVE_WHEEL_HUBS",
    categoryId: "MLB1765-01",
    name: "Cubo de Roda Dianteiro Fiat Uno 2008-2018",
    familyName: "Cubo de Roda",
    permalink: null,
    pictures: [],
    attributes: {
      BRAND: { value_id: "1000", value_name: "Fiat" },
      MODEL: { value_name: "Uno" },
      VEHICLE_YEAR: { value_name: "2008-2018" },
      MATERIAL: { value_name: "Aço" },
    },
    brand: "Fiat",
    model: "Uno",
    year: "2008",
    partNumber: "HUB-2008-FIAT",
    compatibilities: [
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: 2008,
        yearTo: 2018,
        version: null,
      },
    ],
    raw: {} as any,
    ...overrides,
  };
}

describe("applyMlCatalogSuggestion — preenche apenas campos vazios", () => {
  it("preenche brand/model/year quando vazios", () => {
    const current: CatalogApplyFormValues = {};
    const { next, applied, conflicts } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(next.brand).toBe("Fiat");
    expect(next.model).toBe("Uno");
    expect(next.year).toBe("2008");
    expect(applied).toContain("brand");
    expect(applied).toContain("model");
    expect(applied).toContain("year");
    expect(
      conflicts.filter((c) =>
        ["brand", "model", "year"].includes(String(c.field)),
      ),
    ).toHaveLength(0);
  });

  it("preserva brand já preenchido pelo usuário e registra conflito", () => {
    const current: CatalogApplyFormValues = { brand: "Honda" };
    const { next, conflicts } = applyMlCatalogSuggestion(current, buildDetail());
    expect(next.brand).toBe("Honda");
    expect(conflicts.some((c) => c.field === "brand")).toBe(true);
  });

  it("não registra conflito quando o valor atual é exatamente igual ao do catálogo", () => {
    const current: CatalogApplyFormValues = { brand: "Fiat" };
    const { conflicts, applied } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(conflicts.some((c) => c.field === "brand")).toBe(false);
    expect(applied).not.toContain("brand");
  });
});

describe("applyMlCatalogSuggestion — categoria", () => {
  it("preenche mlCategoryId e mlCategory quando vazios, com source auto", () => {
    const current: CatalogApplyFormValues = {};
    const { next, applied } = applyMlCatalogSuggestion(current, buildDetail());
    expect(next.mlCategoryId).toBe("MLB1765-01");
    expect(next.mlCategory).toBe("MLB1765-01");
    expect(next.mlCategorySource).toBe("auto");
    expect(applied).toContain("mlCategoryId");
    expect(applied).toContain("mlCategorySource");
  });

  it("não sobrescreve mlCategoryId já escolhido explicitamente", () => {
    const current: CatalogApplyFormValues = {
      mlCategoryId: "MLB1234",
      mlCategorySource: "manual",
    };
    const { next, conflicts } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(next.mlCategoryId).toBe("MLB1234");
    expect(next.mlCategorySource).toBe("manual");
    expect(conflicts.some((c) => c.field === "mlCategoryId")).toBe(true);
  });
});

describe("applyMlCatalogSuggestion — attributes merge", () => {
  it("adiciona atributos novos mantendo os já preenchidos", () => {
    const current: CatalogApplyFormValues = {
      attributes: {
        COR: { value_name: "Preto" },
      },
    };
    const { next, applied } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(next.attributes?.COR).toEqual({ value_name: "Preto" });
    expect(next.attributes?.MATERIAL).toEqual({ value_name: "Aço" });
    expect(applied).toContain("attributes");
  });

  it("não sobrescreve um atributo já digitado mesmo se catálogo divergir", () => {
    const current: CatalogApplyFormValues = {
      attributes: {
        MATERIAL: { value_name: "Alumínio" },
      },
    };
    const { next, conflicts } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(next.attributes?.MATERIAL).toEqual({ value_name: "Alumínio" });
    expect(conflicts.some((c) => c.field === "attributes.MATERIAL")).toBe(true);
  });
});

describe("applyMlCatalogSuggestion — compatibilidades merge por chave", () => {
  it("adiciona compat do catálogo quando form está vazio", () => {
    const current: CatalogApplyFormValues = {};
    const { next } = applyMlCatalogSuggestion(current, buildDetail());
    expect(next.compatibilities).toHaveLength(1);
    expect(next.compatibilities?.[0].brand).toBe("Fiat");
  });

  it("não duplica compat existente com mesma chave", () => {
    const current: CatalogApplyFormValues = {
      compatibilities: [
        {
          brand: "Fiat",
          model: "Uno",
          yearFrom: 2008,
          yearTo: 2018,
          version: null,
        },
      ],
    };
    const { next, applied } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(next.compatibilities).toHaveLength(1);
    expect(applied).not.toContain("compatibilities");
  });

  it("preserva compat manuais e acrescenta novas", () => {
    const current: CatalogApplyFormValues = {
      compatibilities: [
        {
          brand: "VW",
          model: "Gol",
          yearFrom: 2015,
          yearTo: 2015,
          version: null,
        },
      ],
    };
    const { next } = applyMlCatalogSuggestion(current, buildDetail());
    expect(next.compatibilities).toHaveLength(2);
    expect(next.compatibilities?.map((c) => c.brand).sort()).toEqual([
      "Fiat",
      "VW",
    ]);
  });
});

describe("applyMlCatalogSuggestion — partNumber", () => {
  it("preenche partNumber quando form está vazio", () => {
    const { next, applied } = applyMlCatalogSuggestion({}, buildDetail());
    expect(next.partNumber).toBe("HUB-2008-FIAT");
    expect(applied).toContain("partNumber");
  });

  it("não sobrescreve partNumber já digitado pelo usuário", () => {
    const { next, conflicts } = applyMlCatalogSuggestion(
      { partNumber: "CODIGO-MANUAL-123" },
      buildDetail(),
    );
    expect(next.partNumber).toBe("CODIGO-MANUAL-123");
    expect(conflicts.some((c) => c.field === "partNumber")).toBe(true);
  });

  it("não gera conflito quando catálogo não tem partNumber", () => {
    const { applied, conflicts } = applyMlCatalogSuggestion(
      {},
      buildDetail({ partNumber: null }),
    );
    expect(applied).not.toContain("partNumber");
    expect(conflicts.some((c) => c.field === "partNumber")).toBe(false);
  });
});

describe("applyMlCatalogSuggestion — vínculo mlCatalogProductId", () => {
  it("sempre grava mlCatalogProductId, mesmo sem demais mudanças", () => {
    const current: CatalogApplyFormValues = {
      brand: "Fiat",
      model: "Uno",
      year: "2008",
      mlCategoryId: "MLB1765-01",
      attributes: {
        BRAND: { value_id: "1000", value_name: "Fiat" },
        MODEL: { value_name: "Uno" },
        VEHICLE_YEAR: { value_name: "2008-2018" },
        MATERIAL: { value_name: "Aço" },
      },
      compatibilities: [
        {
          brand: "Fiat",
          model: "Uno",
          yearFrom: 2008,
          yearTo: 2018,
          version: null,
        },
      ],
    };
    const { next, applied } = applyMlCatalogSuggestion(
      current,
      buildDetail(),
    );
    expect(next.mlCatalogProductId).toBe("MLB19765739");
    expect(applied).toContain("mlCatalogProductId");
  });
});

import { describe, it, expect } from "vitest";
import {
  applyInternalSuggestion,
  type InternalApplyFormValues,
  type InternalSuggestion,
} from "@/app/produtos/lib/apply-internal-suggestion";

function buildSuggestion(
  overrides: Partial<InternalSuggestion> = {},
): InternalSuggestion {
  return {
    matchKey: "cubo-de-roda|fiat|uno|*|2008-2014",
    sampleSize: 23,
    confidence: "alta",
    source: "internal",
    fields: {
      brand: "Fiat",
      model: "Uno",
      year: "2012",
      version: null,
      quality: "SEMINOVO",
      sourceVehicle: "Fiat Uno 1.0",
      partNumber: "51234567",
      priceMedian: 89.9,
      weightKg: 1.2,
      heightCm: 12,
      widthCm: 12,
      lengthCm: 14,
      mlCategoryId: "MLB1765-01",
      shopeeCategoryId: null,
      ...(overrides.fields ?? {}),
    },
    compatibilities: [
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: 2008,
        yearTo: 2014,
        version: null,
      },
    ],
    attributes: { MATERIAL: { value_name: "Aço" } },
    ...overrides,
  };
}

describe("applyInternalSuggestion — preenche só campos vazios", () => {
  it("preenche todos os campos do MVP quando o form está vazio", () => {
    const current: InternalApplyFormValues = { price: 0 };
    const { next, applied, conflicts } = applyInternalSuggestion(
      current,
      buildSuggestion(),
    );
    expect(next.brand).toBe("Fiat");
    expect(next.model).toBe("Uno");
    expect(next.year).toBe("2012");
    expect(next.quality).toBe("SEMINOVO");
    expect(next.sourceVehicle).toBe("Fiat Uno 1.0");
    expect(next.partNumber).toBe("51234567");
    expect(next.price).toBe(89.9);
    expect(next.weightKg).toBe(1.2);
    expect(next.heightCm).toBe(12);
    expect(next.widthCm).toBe(12);
    expect(next.lengthCm).toBe(14);
    expect(next.mlCategory).toBe("MLB1765-01");
    expect(applied).toEqual(
      expect.arrayContaining(["brand", "price", "mlCategory"]),
    );
    expect(conflicts).toHaveLength(0);
  });

  it("trata price=0 e medidas undefined como vazias (preenche)", () => {
    const current: InternalApplyFormValues = {
      price: 0,
      weightKg: undefined,
      heightCm: 0,
    };
    const { next, applied } = applyInternalSuggestion(
      current,
      buildSuggestion(),
    );
    expect(next.price).toBe(89.9);
    expect(next.weightKg).toBe(1.2);
    expect(next.heightCm).toBe(12);
    expect(applied).toEqual(
      expect.arrayContaining(["price", "weightKg", "heightCm"]),
    );
  });

  it("preserva campos já preenchidos e registra conflito", () => {
    const current: InternalApplyFormValues = {
      brand: "Volkswagen",
      price: 150,
      partNumber: "ABC",
    };
    const { next, applied, conflicts } = applyInternalSuggestion(
      current,
      buildSuggestion(),
    );
    expect(next.brand).toBe("Volkswagen");
    expect(next.price).toBe(150);
    expect(next.partNumber).toBe("ABC");
    expect(applied).not.toEqual(
      expect.arrayContaining(["brand", "price", "partNumber"]),
    );
    expect(conflicts.map((c) => c.field)).toEqual(
      expect.arrayContaining(["brand", "price", "partNumber"]),
    );
  });

  it("não gera conflito quando o valor atual é igual ao sugerido", () => {
    const current: InternalApplyFormValues = { brand: "Fiat", model: "Uno" };
    const { applied, conflicts } = applyInternalSuggestion(
      current,
      buildSuggestion(),
    );
    expect(conflicts.find((c) => c.field === "brand")).toBeUndefined();
    expect(applied).not.toContain("brand");
  });
});

describe("applyInternalSuggestion — categorias (quirk de nome de campo)", () => {
  it("grava mlCategoryId em mlCategory e shopeeCategoryId em shopeeCategory", () => {
    const current: InternalApplyFormValues = {};
    const { next, applied } = applyInternalSuggestion(
      current,
      buildSuggestion({
        fields: { mlCategoryId: "MLB123", shopeeCategoryId: "SHP9" } as any,
      }),
    );
    expect(next.mlCategory).toBe("MLB123");
    expect(next.shopeeCategory).toBe("SHP9");
    expect(applied).toEqual(
      expect.arrayContaining(["mlCategory", "shopeeCategory"]),
    );
  });

  it("não sobrescreve categoria já escolhida", () => {
    const current: InternalApplyFormValues = { mlCategory: "MLB999" };
    const { next, applied } = applyInternalSuggestion(
      current,
      buildSuggestion({ fields: { mlCategoryId: "MLB123" } as any }),
    );
    expect(next.mlCategory).toBe("MLB999");
    expect(applied).not.toContain("mlCategory");
  });
});

describe("applyInternalSuggestion — attributes e compatibilidades", () => {
  it("merge não destrutivo de attributes", () => {
    const current: InternalApplyFormValues = {
      attributes: {
        MATERIAL: { value_name: "Plástico" },
        COR: { value_name: "Preto" },
      },
    };
    const { next, applied, conflicts } = applyInternalSuggestion(
      current,
      buildSuggestion({
        attributes: {
          MATERIAL: { value_name: "Aço" },
          PESO: { value_name: "1kg" },
        },
      }),
    );
    expect(next.attributes?.MATERIAL.value_name).toBe("Plástico"); // não sobrescreve
    expect(next.attributes?.PESO.value_name).toBe("1kg"); // novo entra
    expect(applied).toContain("attributes");
    expect(
      conflicts.find((c) => c.field === "attributes.MATERIAL"),
    ).toBeTruthy();
  });

  it("união de compatibilidades sem duplicar e preservando manuais", () => {
    const current: InternalApplyFormValues = {
      compatibilities: [
        {
          brand: "Fiat",
          model: "Uno",
          yearFrom: 2008,
          yearTo: 2014,
          version: null,
        },
        {
          brand: "VW",
          model: "Gol",
          yearFrom: 2010,
          yearTo: 2016,
          version: null,
        },
      ],
    };
    const { next, applied } = applyInternalSuggestion(
      current,
      buildSuggestion({
        compatibilities: [
          {
            brand: "Fiat",
            model: "Uno",
            yearFrom: 2008,
            yearTo: 2014,
            version: null,
          }, // dup
          {
            brand: "Fiat",
            model: "Palio",
            yearFrom: 2009,
            yearTo: 2015,
            version: null,
          }, // nova
        ],
      }),
    );
    expect(next.compatibilities).toHaveLength(3);
    expect(applied).toContain("compatibilities");
  });

  it("compatibilidade que difere só na versão é considerada nova (includeVersion)", () => {
    const current: InternalApplyFormValues = {
      compatibilities: [
        {
          brand: "Fiat",
          model: "Uno",
          yearFrom: 2008,
          yearTo: 2014,
          version: "1.0",
        },
      ],
    };
    const { next } = applyInternalSuggestion(
      current,
      buildSuggestion({
        compatibilities: [
          {
            brand: "Fiat",
            model: "Uno",
            yearFrom: 2008,
            yearTo: 2014,
            version: "1.4",
          },
        ],
      }),
    );
    expect(next.compatibilities).toHaveLength(2);
  });
});

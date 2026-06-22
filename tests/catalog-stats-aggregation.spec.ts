import { describe, it, expect } from "vitest";
import {
  median,
  quantile,
  iqrSurvivors,
  modeOf,
  rankCompatibilities,
  topAttributes,
  finalizeFamily,
  isValidPrice,
  isValidWeight,
  isValidDim,
  MIN_SAMPLE,
  type FamilyInput,
} from "@/app/marketplaces/lib/catalog-stats-aggregation";

describe("aggregation — median", () => {
  it("ímpar pega o meio, par a média dos centrais", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("aggregation — quantile (tipo-7)", () => {
  it("interpola linearmente", () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantile(s, 0.25)).toBe(2);
    expect(quantile(s, 0.75)).toBe(4);
  });
});

describe("aggregation — IQR", () => {
  it("remove outlier claro e mantém cluster apertado", () => {
    const vals = [10, 11, 12, 11, 10, 12, 1000]; // 1000 é outlier
    const surv = iqrSurvivors(vals);
    expect(surv).not.toContain(1000);
    expect(surv.length).toBe(6);
  });

  it("listas pequenas (<4) passam sem corte", () => {
    expect(iqrSurvivors([1, 1000, 2]).sort((a, b) => a - b)).toEqual([
      1, 2, 1000,
    ]);
  });
});

describe("aggregation — modeOf", () => {
  it("pega o valor mais frequente preservando display", () => {
    const r = modeOf(["NOVO", "novo", "SEMINOVO"], (s) =>
      s.trim().toUpperCase(),
    );
    expect(r?.value).toBe("NOVO");
    expect(r?.count).toBe(2);
  });

  it("empate → menor chave (determinístico)", () => {
    const r = modeOf(["b", "a"], (s) => s);
    expect(r?.value).toBe("a");
    expect(r?.count).toBe(1);
  });
});

describe("aggregation — sanity bounds", () => {
  it("descarta absurdos sem converter", () => {
    expect(isValidPrice(0)).toBe(false);
    expect(isValidPrice(50)).toBe(true);
    expect(isValidWeight(0)).toBe(false);
    expect(isValidWeight(1500)).toBe(false); // não vira 1.5
    expect(isValidWeight(1.5)).toBe(true);
    expect(isValidDim(0)).toBe(false);
    expect(isValidDim(5000)).toBe(false); // não vira 50
    expect(isValidDim(40)).toBe(true);
  });
});

describe("aggregation — compatibilidades", () => {
  it("dedup por (brand,model,yearFrom,yearTo,version) e rankeia por freq", () => {
    const ranked = rankCompatibilities([
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: 2008,
        yearTo: 2014,
        version: null,
      },
      {
        brand: "fiat",
        model: "uno",
        yearFrom: 2008,
        yearTo: 2014,
        version: null,
      }, // dup
      {
        brand: "VW",
        model: "Gol",
        yearFrom: 2010,
        yearTo: 2016,
        version: null,
      },
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].brand).toBe("Fiat");
    expect(ranked[0].freq).toBe(2);
  });
});

describe("aggregation — topAttributes", () => {
  it("valor mais frequente por chave; pula freq < 2", () => {
    const top = topAttributes([
      { MATERIAL: { value_name: "Aço" } },
      { MATERIAL: { value_name: "Aço" } },
      { MATERIAL: { value_name: "Ferro" } },
      { COR: { value_name: "Preto" } }, // freq 1 → pulado
    ]);
    expect(top.MATERIAL.value_name).toBe("Aço");
    expect(top.MATERIAL.freq).toBe(2);
    expect(top.COR).toBeUndefined();
  });
});

describe("aggregation — finalizeFamily", () => {
  const baseFamily = (over: Partial<FamilyInput> = {}): FamilyInput => ({
    partType: "cubo-de-roda",
    brand: "fiat",
    model: "uno",
    version: "*",
    memberCount: 6,
    prices: [80, 85, 90, 95, 100, 88],
    weights: [1.1, 1.2, 1.2, 1.3, 1.2, 1.1],
    heights: [12, 12, 13, 12, 12, 11],
    widths: [12, 12, 12, 12, 12, 12],
    lengths: [14, 14, 15, 14, 14, 13],
    years: [2008, 2010, 2012, 2014, 2009, 2011],
    qualities: ["NOVO", "NOVO", "NOVO", "SEMINOVO", "NOVO", "NOVO"],
    partNumbers: [
      "51234567",
      "51234567",
      "51234567",
      "x",
      "51234567",
      "51234567",
    ],
    versions: [],
    sourceVehicles: ["Fiat Uno 1.0", "Fiat Uno 1.0", "Fiat Uno"],
    mlCategoryIds: ["MLB1765-01", "MLB1765-01", "MLB1765-01"],
    shopeeCategoryIds: [],
    attributesList: [
      { MATERIAL: { value_name: "Aço" } },
      { MATERIAL: { value_name: "Aço" } },
    ],
    compatibilities: [
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: 2008,
        yearTo: 2014,
        version: null,
      },
    ],
    ...over,
  });

  it("agrega família válida (gate >= 5)", () => {
    const row = finalizeFamily(baseFamily());
    expect(row).not.toBeNull();
    expect(row!.sampleSize).toBe(6);
    expect(row!.priceMedian).toBeGreaterThan(0);
    expect(row!.yearFrom).toBe(2008);
    expect(row!.yearTo).toBe(2014);
    expect(row!.qualityMode).toBe("NOVO");
    expect(row!.qualityModeCount).toBe(5);
    expect(row!.partNumberMode).toBe("51234567");
    expect(row!.mlCategoryIdMode).toBe("MLB1765-01");
    expect(row!.attributes?.MATERIAL.value_name).toBe("Aço");
    expect(row!.matchKey).toBe("cubo-de-roda|fiat|uno|*|2008-2014");
  });

  it("família com < 5 membros é descartada (null)", () => {
    expect(
      finalizeFamily(baseFamily({ memberCount: MIN_SAMPLE - 1 })),
    ).toBeNull();
  });

  it("descarta preços/medidas absurdos antes da mediana", () => {
    const row = finalizeFamily(
      baseFamily({ prices: [90, 90, 90, 90, 90, 9_999_999, -5, 0] }),
    );
    expect(row!.priceMedian).toBe(90);
    // priceSampleSize só conta os preços válidos pós-IQR (descarta 9.999.999/-5/0)
    expect(row!.priceSampleSize).toBeLessThanOrEqual(6);
  });

  it("moda com freq < 2 não é gravada", () => {
    const row = finalizeFamily(
      baseFamily({ sourceVehicles: ["A", "B", "C", "D", "E"] }),
    );
    expect(row!.sourceVehicleMode).toBeNull();
    expect(row!.sourceVehicleModeCount).toBeNull();
  });

  it("sem anos válidos → faixa null e matchKey com '*'", () => {
    const row = finalizeFamily(baseFamily({ years: [] }));
    expect(row!.yearFrom).toBeNull();
    expect(row!.yearTo).toBeNull();
    expect(row!.matchKey).toBe("cubo-de-roda|fiat|uno|*|*");
  });
});

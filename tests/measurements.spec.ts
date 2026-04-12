import { describe, it, expect } from "vitest";
import {
  getMeasurementsForCategory,
  ML_MEASUREMENTS_MAP,
  isSafeForAutoFill,
  ML_SAFE_MAX_DIM_CM,
  ML_SAFE_MAX_WEIGHT_KG,
  ML_SAFE_MAX_SUM_CM,
} from "../app/lib/ml-measurements";

describe("ML measurements lookup", () => {
  it("exposes measurement entries parsed from CSV", () => {
    const key = Object.keys(ML_MEASUREMENTS_MAP).find((k) =>
      k.includes("calotas"),
    );
    expect(key).toBeDefined();
    const calotas = ML_MEASUREMENTS_MAP["calotas"];
    expect(calotas).toBeDefined();
    expect(calotas?.heightCm).toBe(35);
    expect(calotas?.widthCm).toBe(35);
    expect(calotas?.lengthCm).toBe(35);
    expect(calotas?.weightKg).toBe(2);
  });

  it("returns measurements for an exact category name", () => {
    const m = getMeasurementsForCategory("Calotas");
    expect(m).toBeDefined();
    expect(m?.heightCm).toBe(35);
    expect(m?.weightKg).toBe(2);
  });

  it("blocks Frete próprio categories from auto-fill (ex: Carroceria)", () => {
    // "Carroceria" exists in the map but is marked as "Frete próprio" (75x150x300cm, 120kg)
    // It must NOT be returned by getMeasurementsForCategory to avoid publishing invalid dimensions
    const raw = ML_MEASUREMENTS_MAP["carroceria"];
    expect(raw).toBeDefined();
    expect(raw?.mercadoEnvios).toBe("Frete próprio");

    const m = getMeasurementsForCategory(
      "Carroceria e Lataria",
      "Carroceria e Lataria > Portas",
    );
    expect(m).toBeUndefined();
  });

  it("returns undefined for unknown categories", () => {
    const m = getMeasurementsForCategory(
      "Categoria Inexistente",
      "Categoria Inexistente > Sub",
    );
    expect(m).toBeUndefined();
  });

  it('matches singular tokens (ex: "roda" → "rodas") and is tolerant to pluralization', () => {
    // "rodas" is "Limitado" but within safe limits (25x25x45, 10kg)
    const m = getMeasurementsForCategory("roda");
    expect(m).toBeDefined();
    expect(m?.heightCm).toBe(25);
    expect(m?.weightKg).toBe(10);
  });
});

describe("ML measurements safety", () => {
  it("no auto-fillable category exceeds safe Correios limits", () => {
    const violations: string[] = [];

    for (const [cat, m] of Object.entries(ML_MEASUREMENTS_MAP)) {
      if (!isSafeForAutoFill(m)) continue;

      const h = m.heightCm || 0;
      const w = m.widthCm || 0;
      const l = m.lengthCm || 0;
      const wt = m.weightKg || 0;
      const maxSide = Math.max(h, w, l);
      const dimSum = h + w + l;

      if (maxSide > ML_SAFE_MAX_DIM_CM)
        violations.push(`${cat}: lado ${maxSide}cm > ${ML_SAFE_MAX_DIM_CM}cm`);
      if (dimSum > ML_SAFE_MAX_SUM_CM)
        violations.push(`${cat}: soma ${dimSum}cm > ${ML_SAFE_MAX_SUM_CM}cm`);
      if (wt > ML_SAFE_MAX_WEIGHT_KG)
        violations.push(`${cat}: peso ${wt}kg > ${ML_SAFE_MAX_WEIGHT_KG}kg`);
    }

    expect(violations).toEqual([]);
  });

  it("Frete próprio categories are never returned by getMeasurementsForCategory", () => {
    const freteProprio = Object.entries(ML_MEASUREMENTS_MAP)
      .filter(([, m]) => m.mercadoEnvios === "Frete próprio")
      .map(([k]) => k);

    expect(freteProprio.length).toBeGreaterThan(0);

    for (const cat of freteProprio) {
      const m = getMeasurementsForCategory(cat);
      expect(m).toBeUndefined();
    }
  });

  it("categories with oversized dimensions are blocked from auto-fill", () => {
    // Motor: 70x60x100, 150kg — Frete próprio, peso excede
    expect(getMeasurementsForCategory("Motor")).toBeUndefined();
    // Reboques: 155x205x305, 300kg
    expect(getMeasurementsForCategory("Reboques")).toBeUndefined();
    // Transmissão: 50x60x120, 100kg
    expect(getMeasurementsForCategory("Transmissão")).toBeUndefined();
  });

  it("safe categories ARE returned by getMeasurementsForCategory", () => {
    // Calotas: 35x35x35, 2kg — well within limits
    expect(getMeasurementsForCategory("Calotas")).toBeDefined();
    // Filtros: 10x10x20, 1kg
    expect(getMeasurementsForCategory("Filtros")).toBeDefined();
    // Fechaduras e Chaves: 10x15x25, 1kg
    expect(getMeasurementsForCategory("Fechaduras e Chaves")).toBeDefined();
  });
});

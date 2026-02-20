import { describe, it, expect } from "vitest";
import {
  getMeasurementsForCategory,
  ML_MEASUREMENTS_MAP,
} from "../app/lib/ml-measurements";

describe("ML measurements lookup", () => {
  it("exposes measurement entries parsed from CSV", () => {
    // basic sanity: map contains known key
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

  it("matches by top-level + detailed value (partial matching)", () => {
    // "Carroceria e Lataria > Portas" should match the top-level "Carroceria" row via partial match
    const m = getMeasurementsForCategory(
      "Carroceria e Lataria",
      "Carroceria e Lataria > Portas",
    );
    expect(m).toBeDefined();
    expect(m?.heightCm).toBeGreaterThan(0);
  });

  it("returns undefined for unknown categories", () => {
    const m = getMeasurementsForCategory(
      "Categoria Inexistente",
      "Categoria Inexistente > Sub",
    );
    expect(m).toBeUndefined();
  });

  it('matches singular tokens (ex: "roda" → "rodas") and is tolerant to pluralization', () => {
    const m = getMeasurementsForCategory("roda");
    expect(m).toBeDefined();
    expect(m?.heightCm).toBe(25);
    expect(m?.weightKg).toBe(10);
  });
});

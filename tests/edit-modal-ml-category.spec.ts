import { describe, it, expect } from "vitest";
import {
  isProductVehicular,
  isCategoryUnderVehicleRoot,
  sanityCheckInitialMlCategory,
} from "../app/produtos/components/edit-product-dialog.helpers";

const MOCK_OPTIONS = [
  { id: "MLB22648", value: "Acessórios para Veículos > Peças de Carros > Suspensão" },
  { id: "MLB191703", value: "Acessórios para Veículos > Peças de Carros > Mangueiras" },
  { id: "MLB269510", value: "Alimentos e Bebidas > Bebidas > Bebidas Brancas e Licores > Gin" },
];

describe("isProductVehicular", () => {
  it("true when brand+model+year present", () => {
    expect(isProductVehicular({ brand: "ford", model: "ka", year: "2017" })).toBe(true);
  });
  it("false when any signal missing", () => {
    expect(isProductVehicular({ brand: "ford", model: "ka" })).toBe(false);
    expect(isProductVehicular({})).toBe(false);
  });
});

describe("isCategoryUnderVehicleRoot", () => {
  it("returns true for categories under Acessórios para Veículos", () => {
    expect(isCategoryUnderVehicleRoot("MLB22648", MOCK_OPTIONS)).toBe(true);
    expect(isCategoryUnderVehicleRoot("MLB191703", MOCK_OPTIONS)).toBe(true);
  });
  it("returns false for clearly off-domain categories like Gin", () => {
    expect(isCategoryUnderVehicleRoot("MLB269510", MOCK_OPTIONS)).toBe(false);
  });
  it("returns unknown when id is missing from list", () => {
    expect(isCategoryUnderVehicleRoot("MLB999", MOCK_OPTIONS)).toBe("unknown");
  });
  it("returns unknown when list is empty (data not loaded)", () => {
    expect(isCategoryUnderVehicleRoot("MLB22648", [])).toBe("unknown");
  });
});

describe("sanityCheckInitialMlCategory — reset across products", () => {
  it("clears persisted mlCategory when product A (vehicular) has Gin", () => {
    const r = sanityCheckInitialMlCategory(
      { brand: "ford", model: "ka", year: "2017" },
      "MLB269510",
      MOCK_OPTIONS,
    );
    expect(r.clear).toBe(true);
    expect(r.warning).toMatch(/autopeças|autopecas/i);
  });

  it("does not clear when product B (vehicular) has valid suspension category", () => {
    const r = sanityCheckInitialMlCategory(
      { brand: "vw", model: "gol", year: "2015" },
      "MLB22648",
      MOCK_OPTIONS,
    );
    expect(r.clear).toBe(false);
  });

  it("does not clear for non-vehicular product even with off-domain category", () => {
    const r = sanityCheckInitialMlCategory(
      {},
      "MLB269510",
      MOCK_OPTIONS,
    );
    expect(r.clear).toBe(false);
  });

  it("does not clear when options haven't loaded (unknown)", () => {
    const r = sanityCheckInitialMlCategory(
      { brand: "ford", model: "ka", year: "2017" },
      "MLB269510",
      [],
    );
    expect(r.clear).toBe(false);
  });

  it("simulates open product A with invalid then product B with valid — B is kept", () => {
    const resultA = sanityCheckInitialMlCategory(
      { brand: "ford", model: "ka", year: "2017" },
      "MLB269510",
      MOCK_OPTIONS,
    );
    const resultB = sanityCheckInitialMlCategory(
      { brand: "vw", model: "gol", year: "2015" },
      "MLB22648",
      MOCK_OPTIONS,
    );
    expect(resultA.clear).toBe(true);
    expect(resultB.clear).toBe(false);
  });
});

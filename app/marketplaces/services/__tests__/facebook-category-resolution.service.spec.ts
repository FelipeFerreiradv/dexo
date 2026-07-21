import { describe, it, expect } from "vitest";
import { FacebookCategoryResolutionService } from "../facebook-category-resolution.service";
import { FACEBOOK_DEFAULT_CATEGORY } from "../../facebook/facebook-category-map";

describe("FacebookCategoryResolutionService", () => {
  it("sem match de veículo → default (Motor Vehicle Parts)", () => {
    expect(
      FacebookCategoryResolutionService.resolveCategory({ name: "Parafuso" }),
    ).toBe(FACEBOOK_DEFAULT_CATEGORY);
  });

  it("casa 'moto' por palavra → Motorcycle Parts", () => {
    expect(
      FacebookCategoryResolutionService.resolveCategory({
        name: "Retrovisor Moto Honda",
      }),
    ).toContain("Motorcycle Parts");
  });

  it("word-boundary: 'motor' NÃO casa 'moto' → fica no default", () => {
    expect(
      FacebookCategoryResolutionService.resolveCategory({
        name: "Suporte do Motor Gol",
      }),
    ).toBe(FACEBOOK_DEFAULT_CATEGORY);
  });

  it("casa 'barco' → Watercraft Parts", () => {
    expect(
      FacebookCategoryResolutionService.resolveCategory({
        name: "Hélice de Barco",
      }),
    ).toContain("Watercraft Parts");
  });

  it("categoria explícita vence tudo", () => {
    expect(
      FacebookCategoryResolutionService.resolveCategory({
        name: "Retrovisor Moto",
        fbCategory: "Custom > Category",
      }),
    ).toBe("Custom > Category");
  });
});

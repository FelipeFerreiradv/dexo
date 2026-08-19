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

  it("word-boundary: 'motor' NÃO casa 'moto'", () => {
    // ⚠️ Este caso afirmava `toBe(FACEBOOK_DEFAULT_CATEGORY)`. Era um PROXY: o
    // que ele existe para provar é que "Suporte do Motor" não vira peça de
    // MOTO, e naquele momento "não ser moto" e "ser o default" davam no mesmo,
    // porque só existiam três categorias.
    //
    // Com as 21 cestas por sistema, "Suporte do Motor Gol" passa a resolver
    // para Peças de motor — mais específico, e a invariante do word-boundary
    // segue intacta. O proxy quebrou; a propriedade, não. Agora o caso afirma a
    // propriedade diretamente.
    const cat = FacebookCategoryResolutionService.resolveCategory({
      name: "Suporte do Motor Gol",
    });
    expect(cat).not.toContain("Motorcycle Parts");
    expect(cat).toContain("Motor Vehicle Engine Parts");
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

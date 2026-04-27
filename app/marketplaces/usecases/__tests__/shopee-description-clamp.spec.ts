import { describe, expect, it } from "vitest";
import { ListingUseCase as ListingUseCaseClass } from "../listing.usercase";

const LU: any = ListingUseCaseClass;

function makeProduct(compatCount: number) {
  const compatibilities = Array.from({ length: compatCount }, (_, i) => ({
    brand: "AUDI",
    model: "A7",
    yearFrom: 2010 + (i % 15),
    yearTo: 2010 + (i % 15),
    version: `Variante ${i + 1} de descrição extensa para forçar limite`,
  }));
  return {
    sku: "TEST-1",
    name: "Peça de Teste",
    description: "Descrição base do produto",
    brand: "AUDI",
    model: "A7",
    year: "2015",
    version: "3.0 TFSI",
    partNumber: "ABC123",
    quality: "USED",
    compatibilities,
  };
}

describe("buildShopeeDescription — limite 5000 chars", () => {
  it("descrição curta passa intacta", () => {
    const out: string = LU.buildShopeeDescription(makeProduct(2));
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("AUDI A7");
    expect(out).toContain("SKU: TEST-1");
  });

  it("trunca compatibilidades quando excede 5000", () => {
    const out: string = LU.buildShopeeDescription(makeProduct(200));
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out).toContain("SKU: TEST-1"); // SKU sempre preservado
    expect(out).toContain("Compatível com:");
    expect(out).toMatch(/\(\+\d+ versões\)/); // marcador de truncamento
  });

  it("descrição base gigante ainda é truncada com salvaguarda", () => {
    const p = makeProduct(0);
    p.description = "X".repeat(10000);
    const out: string = LU.buildShopeeDescription(p);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out).toContain("SKU: TEST-1");
  });

  it("sem compatibilidades não adiciona seção", () => {
    const out: string = LU.buildShopeeDescription(makeProduct(0));
    expect(out).not.toContain("Compatível com:");
  });
});

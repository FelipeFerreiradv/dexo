import { describe, it, expect } from "vitest";

// Stub do prisma client para evitar conexão real ao DB durante import.
import { vi } from "vitest";
vi.mock("@/app/lib/prisma", () => ({
  default: {},
}));

import { ListingUseCase as ListingUseCaseClass } from "../app/marketplaces/usecases/listing.usercase";

// Helpers privados acessados via cast — padrão usado em listing.family-name.spec.ts.
const ListingUseCase: any = ListingUseCaseClass;

const baseProduct = {
  sku: "SKU-001",
  name: "Cubo de roda dianteiro Palio",
  brand: "Fiat",
  model: "Palio",
  year: "2010",
  partNumber: "PN-123",
};

describe("buildMLAttributes — ficha técnica secundária", () => {
  it("mantém comportamento atual quando product.attributes está ausente", () => {
    const out = ListingUseCase.buildMLAttributes(baseProduct, "MLB193419");
    const ids = out.map((a: any) => a.id).sort();
    expect(ids).toContain("BRAND");
    expect(ids).toContain("MODEL");
    expect(ids).toContain("YEAR");
    expect(ids).toContain("SELLER_SKU");
    expect(ids).toContain("PART_NUMBER");
    // Nenhum extra: tamanho previsível
    expect(out.length).toBe(5);
  });

  it("adiciona atributos extras de product.attributes preservando os fixos", () => {
    const product = {
      ...baseProduct,
      attributes: {
        OCM: { value_name: "X-9999" },
        VOLTAGE: { value_id: "VID-12V", value_name: "12V" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, "MLB193419");
    const byId = new Map<string, any>(out.map((a: any) => [a.id, a]));
    expect(byId.get("BRAND")?.value_name).toBe("Fiat");
    expect(byId.get("OCM")?.value_name).toBe("X-9999");
    expect(byId.get("VOLTAGE")?.value_id).toBe("VID-12V");
    expect(byId.get("VOLTAGE")?.value_name).toBe("12V");
  });

  it("não sobrescreve atributos fixos quando product.attributes contém o mesmo id", () => {
    const product = {
      ...baseProduct,
      attributes: {
        BRAND: { value_name: "FAKE-BRAND" },
        PART_NUMBER: { value_name: "FAKE-PN" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, "MLB193419");
    const byId = new Map<string, any>(out.map((a: any) => [a.id, a]));
    // Os fixos vencem
    expect(byId.get("BRAND")?.value_name).toBe("Fiat");
    expect(byId.get("PART_NUMBER")?.value_name).toBe("PN-123");
    // Nenhuma duplicação por id
    const brandCount = out.filter((a: any) => a.id === "BRAND").length;
    expect(brandCount).toBe(1);
  });

  it("ignora entradas vazias em product.attributes", () => {
    const product = {
      ...baseProduct,
      attributes: {
        EMPTY: { value_name: "" },
        NULL_THING: { value_id: "  " },
        VALID: { value_name: "ok" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, "MLB193419");
    const ids = out.map((a: any) => a.id);
    expect(ids).not.toContain("EMPTY");
    expect(ids).not.toContain("NULL_THING");
    expect(ids).toContain("VALID");
  });

  it("aceita product.attributes ausente sem alterar o array fixo", () => {
    const product = { ...baseProduct, attributes: null };
    const out = ListingUseCase.buildMLAttributes(product, "MLB193419");
    expect(out.length).toBe(5);
  });
});

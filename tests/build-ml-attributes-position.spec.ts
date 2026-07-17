import { describe, it, expect, vi } from "vitest";

// Stub do prisma client para evitar conexão real ao DB durante import.
vi.mock("@/app/lib/prisma", () => ({
  default: {},
}));

import { ListingUseCase as ListingUseCaseClass } from "../app/marketplaces/usecases/listing.usercase";

// Helpers privados acessados via cast — padrão de ml-build-attributes.spec.ts.
const ListingUseCase: any = ListingUseCaseClass;

// Categoria com inferência de posição embutida (portas) vs. uma fora dela.
const DOOR_CATEGORY = "MLB101763";
const NON_DOOR_CATEGORY = "MLB193419";

const baseProduct = {
  sku: "SKU-POS",
  name: "Porta dianteira esquerda Palio",
  brand: "Fiat",
  model: "Palio",
  year: "2012",
  partNumber: "PN-POS",
};

const positions = (out: any[]) => out.filter((a: any) => a.id === "POSITION");

describe("buildMLAttributes — lado/posição (POSITION)", () => {
  it("valor do operador VENCE a inferência em categoria-porta (preserva value_id)", () => {
    const product = {
      ...baseProduct,
      attributes: {
        POSITION: {
          value_id: "VID-DIANT-ESQ",
          value_name: "Dianteira esquerda",
        },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, DOOR_CATEGORY);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_id).toBe("VID-DIANT-ESQ");
    expect(pos[0].value_name).toBe("Dianteira esquerda");
  });

  it("fallback: infere Dianteira do nome quando o operador não informou POSITION", () => {
    const out = ListingUseCase.buildMLAttributes({ ...baseProduct }, DOOR_CATEGORY);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_name).toBe("Dianteira");
    expect(pos[0].value_id).toBeUndefined();
  });

  it("POSITION vazio ({}) conta como ausente: o fallback ainda dispara", () => {
    const product = { ...baseProduct, attributes: { POSITION: {} } };
    const out = ListingUseCase.buildMLAttributes(product, DOOR_CATEGORY);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_name).toBe("Dianteira");
  });

  it("fora das 2 categorias-porta, POSITION do operador flui pelo merge (value_id ok)", () => {
    const product = {
      ...baseProduct,
      attributes: {
        POSITION: { value_id: "VID-TRAS-DIR", value_name: "Traseira direita" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, NON_DOOR_CATEGORY);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_id).toBe("VID-TRAS-DIR");
    expect(pos[0].value_name).toBe("Traseira direita");
  });

  it("sem POSITION e fora das portas: nenhum POSITION é adicionado (inalterado)", () => {
    const out = ListingUseCase.buildMLAttributes(
      { ...baseProduct },
      NON_DOOR_CATEGORY,
    );
    expect(positions(out)).toHaveLength(0);
  });

  it("nunca duplica POSITION: exatamente 1 entrada mesmo com operador + porta", () => {
    const product = {
      ...baseProduct,
      attributes: {
        POSITION: { value_id: "X", value_name: "Dianteira esquerda" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, DOOR_CATEGORY);
    expect(positions(out)).toHaveLength(1);
  });

  it("não regride os atributos fixos (BRAND/SELLER_SKU/PART_NUMBER pass-through)", () => {
    const product = {
      ...baseProduct,
      attributes: {
        POSITION: { value_id: "X", value_name: "Dianteira esquerda" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, DOOR_CATEGORY);
    const byId = new Map<string, any>(out.map((a: any) => [a.id, a]));
    expect(byId.get("BRAND")?.value_name).toBe("Fiat");
    expect(byId.get("SELLER_SKU")?.value_name).toBe("SKU-POS");
    expect(byId.get("PART_NUMBER")?.value_name).toBe("PN-POS");
    // MODEL/YEAR seguem presentes (valores derivados por cleanModel/cleanYear).
    expect(byId.has("MODEL")).toBe(true);
    expect(byId.has("YEAR")).toBe(true);
  });
});

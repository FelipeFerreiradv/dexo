import { describe, it, expect, vi } from "vitest";

// Stub do prisma client para evitar conexão real ao DB durante import.
vi.mock("@/app/lib/prisma", () => ({
  default: {},
}));

import {
  inferPositionFromName,
  resolvePositionValue,
} from "../app/marketplaces/lib/ml-position.logic";
import { ListingUseCase as ListingUseCaseClass } from "../app/marketplaces/usecases/listing.usercase";
import type { NormalizedMLAttribute } from "../app/marketplaces/services/ml-attribute-catalog.service";

// Helpers privados acessados via cast — padrão de build-ml-attributes-position.
const ListingUseCase: any = ListingUseCaseClass;

const DOOR_CATEGORY = "MLB101763";
const OTHER_CATEGORY = "MLB193419";

const baseProduct = {
  sku: "SKU-POS",
  name: "Farol dianteiro esquerdo Gol",
  brand: "Volkswagen",
  model: "Gol",
  year: "2012",
  partNumber: "PN-POS",
};

const attr = (
  over: Partial<NormalizedMLAttribute> & { id: string },
): NormalizedMLAttribute => ({
  id: over.id,
  name: over.name ?? over.id,
  valueType: over.valueType ?? "list",
  required: over.required ?? false,
  variationRequired: over.variationRequired ?? false,
  allowedValues: over.allowedValues,
  valueMaxLength: over.valueMaxLength,
  hidden: over.hidden,
});

const POSITION_ATTR = attr({
  id: "POSITION",
  name: "Posição",
  allowedValues: [
    { id: "DE", name: "Dianteira Esquerda" },
    { id: "DD", name: "Dianteira Direita" },
    { id: "TE", name: "Traseira Esquerda" },
    { id: "TD", name: "Traseira Direita" },
    { id: "D", name: "Dianteira" },
    { id: "T", name: "Traseira" },
  ],
});

const positions = (out: any[]) =>
  out.filter((a: any) => a.id === "POSITION" || a.id === "SIDE");

describe("inferPositionFromName", () => {
  it("combina eixo e lado, o específico antes do genérico", () => {
    expect(inferPositionFromName("Farol dianteiro esquerdo Gol")).toBe(
      "Dianteira esquerda",
    );
    expect(inferPositionFromName("Lanterna traseira direita Palio")).toBe(
      "Traseira direita",
    );
    expect(inferPositionFromName("Porta dianteira direita")).toBe(
      "Dianteira direita",
    );
    expect(inferPositionFromName("Porta traseira esquerda")).toBe(
      "Traseira esquerda",
    );
  });

  it("nunca para no eixo quando o lado está no nome", () => {
    // Sem isso o comprador perde o filtro de lado, que é o que ele busca.
    expect(inferPositionFromName("Farol dianteiro esquerdo")).not.toBe(
      "Dianteira",
    );
    expect(inferPositionFromName("Retrovisor traseiro direito")).not.toBe(
      "Traseira",
    );
  });

  it("mantém os dois rótulos que o sistema já inferia", () => {
    expect(inferPositionFromName("Porta dianteira Palio")).toBe("Dianteira");
    expect(inferPositionFromName("Parachoque traseiro Uno")).toBe("Traseira");
    expect(inferPositionFromName("Grade da frente")).toBe("Dianteira");
  });

  it("reconhece lado isolado, inclusive abreviado", () => {
    expect(inferPositionFromName("Retrovisor esquerdo")).toBe("Esquerda");
    expect(inferPositionFromName("Retrovisor direito")).toBe("Direita");
    expect(inferPositionFromName("Coluna LE")).toBe("Esquerda");
    expect(inferPositionFromName("Coluna LD")).toBe("Direita");
  });

  it("ignora acento", () => {
    expect(inferPositionFromName("Parachoque trás")).toBe("Traseira");
    expect(inferPositionFromName("Porta dianteira ESQUERDA")).toBe(
      "Dianteira esquerda",
    );
  });

  it("devolve null quando o nome não diz nada sobre posição", () => {
    expect(inferPositionFromName("Bomba d'água Gol 1.0")).toBeNull();
    expect(inferPositionFromName("")).toBeNull();
    expect(inferPositionFromName("Radiador")).toBeNull();
  });

  it("devolve null quando o nome é ambíguo, em vez de chutar", () => {
    expect(inferPositionFromName("Kit porta dianteira e traseira")).toBeNull();
    expect(inferPositionFromName("Par de faróis esquerdo e direito")).toBeNull();
  });
});

describe("resolvePositionValue", () => {
  it("resolve o value_id oficial ignorando caixa e acento", () => {
    const r = resolvePositionValue("Dianteira esquerda", [
      { id: "DE", name: "Dianteira Esquerda" },
    ]);
    expect(r).toEqual({ valueId: "DE", valueName: "Dianteira Esquerda" });
  });

  it("tolera separador diferente no nome oficial", () => {
    const r = resolvePositionValue("Traseira direita", [
      { id: "TD", name: "Traseira/Direita" },
    ]);
    expect(r?.valueId).toBe("TD");
  });

  it("sem lista de valores, devolve texto livre", () => {
    const r = resolvePositionValue("Dianteira", undefined);
    expect(r).toEqual({ valueName: "Dianteira" });
    expect(resolvePositionValue("Dianteira", [])).toEqual({
      valueName: "Dianteira",
    });
  });

  it("lista fechada sem match devolve null (não inventa value_name)", () => {
    const r = resolvePositionValue("Dianteira esquerda", [
      { id: "T", name: "Traseira" },
    ]);
    expect(r).toBeNull();
  });
});

describe("buildMLAttributes — posição dirigida pelo catálogo da categoria", () => {
  it("emite POSITION com value_id oficial quando a categoria expõe o atributo", () => {
    const out = ListingUseCase.buildMLAttributes(baseProduct, OTHER_CATEGORY, [
      POSITION_ATTR,
      attr({ id: "COLOR", allowedValues: [{ id: "1", name: "Preto" }] }),
    ]);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_id).toBe("DE");
    expect(pos[0].value_name).toBe("Dianteira Esquerda");
  });

  it("NÃO emite nada quando a categoria não expõe atributo de posição", () => {
    // Aposenta a lista hardcoded: fora do catálogo, não há palpite.
    const out = ListingUseCase.buildMLAttributes(baseProduct, DOOR_CATEGORY, [
      attr({ id: "COLOR", allowedValues: [{ id: "1", name: "Preto" }] }),
    ]);
    expect(positions(out)).toHaveLength(0);
  });

  it("reconhece o atributo de lado sob outro id (SIDE)", () => {
    const out = ListingUseCase.buildMLAttributes(baseProduct, OTHER_CATEGORY, [
      attr({
        id: "SIDE",
        name: "Lado",
        allowedValues: [{ id: "ESQ", name: "Esquerdo" }],
      }),
    ]);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].id).toBe("SIDE");
  });

  it("não emite quando a lista da categoria não cobre o lado inferido", () => {
    const out = ListingUseCase.buildMLAttributes(baseProduct, OTHER_CATEGORY, [
      attr({
        id: "POSITION",
        allowedValues: [{ id: "T", name: "Traseira" }],
      }),
    ]);
    expect(positions(out)).toHaveLength(0);
  });

  it("valor do operador vence a inferência mesmo com catálogo presente", () => {
    const product = {
      ...baseProduct,
      name: "Farol dianteiro esquerdo Gol",
      attributes: {
        POSITION: { value_id: "TD", value_name: "Traseira Direita" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, OTHER_CATEGORY, [
      POSITION_ATTR,
    ]);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_id).toBe("TD");
    expect(pos[0].value_name).toBe("Traseira Direita");
  });

  it("catálogo vazio ou ausente cai no fallback legado, byte-idêntico", () => {
    // Mesmo contrato dos 7 casos de build-ml-attributes-position.spec.ts.
    const product = { ...baseProduct, name: "Porta dianteira Palio" };
    const out = ListingUseCase.buildMLAttributes(product, DOOR_CATEGORY);
    const pos = positions(out);
    expect(pos).toHaveLength(1);
    expect(pos[0].value_name).toBe("Dianteira");
    expect(pos[0].value_id).toBeUndefined();
  });

  it("não duplica POSITION quando o operador informou e o merge genérico roda", () => {
    const product = {
      ...baseProduct,
      attributes: { POSITION: { value_id: "DE", value_name: "Dianteira Esquerda" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, OTHER_CATEGORY, [
      POSITION_ATTR,
    ]);
    expect(positions(out)).toHaveLength(1);
  });

  it("não interfere nos atributos fixos", () => {
    const out = ListingUseCase.buildMLAttributes(baseProduct, OTHER_CATEGORY, [
      POSITION_ATTR,
    ]);
    const byId = new Map<string, { id: string; value_name?: string }>(
      out.map((a: any) => [a.id as string, a]),
    );
    expect(byId.get("BRAND")?.value_name).toBe("Volkswagen");
    expect(byId.get("SELLER_SKU")?.value_name).toBe("SKU-POS");
    expect(byId.get("PART_NUMBER")?.value_name).toBe("PN-POS");
    expect(byId.has("MODEL")).toBe(true);
    expect(byId.has("YEAR")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { MagaluPayloadBuilderService } from "../magalu-payload-builder.service";

const OPTS = { groupId: "grp-1", channelId: "chan-1" };

describe("MagaluPayloadBuilderService.build", () => {
  const baseProduct = {
    name: "Farol Dianteiro Gol G5",
    description: "Peça usada em bom estado",
    sku: "SKU-123",
    brand: "Volkswagen",
    quality: "SUCATA",
    stock: 3,
    price: 199.9,
    imageUrl: "https://img/1.jpg",
    imageUrls: ["https://img/1.jpg", "https://img/2.jpg"],
    weightKg: 1.2,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
  };

  it("mapeia campos básicos no shape do create-SKU (sem price/quantity)", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct, OPTS);
    expect(p.title).toBe("Farol Dianteiro Gol G5");
    expect(p.sku).toBe("SKU-123");
    expect(p.brand).toBe("Volkswagen");
    expect(p.type).toBe("product");
    expect(p.active).toBe(true);
    expect(p).not.toHaveProperty("price");
    expect(p).not.toHaveProperty("quantity");
  });

  it("group (obrigatório, main_variation) e channels (exatamente 1) vêm das opts", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct, OPTS);
    expect(p.group).toEqual({ id: "grp-1", main_variation: true });
    expect(p.channels).toEqual([{ id: "chan-1" }]);
  });

  it("dimensions: exatamente 2 (product + package) com peso em gramas", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct, OPTS);
    expect(p.dimensions).toHaveLength(2);
    expect(p.dimensions.map((d) => d.name)).toEqual(["product", "package"]);
    expect(p.dimensions[0].weight).toEqual({ unit: "g", value: 1200 });
    expect(p.dimensions[0].height).toEqual({ unit: "cm", value: 10 });
  });

  it("ITEM SEM EAN: has_ean false e identifiers vazio", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct, OPTS);
    expect(p.has_ean).toBe(false);
    expect(p.identifiers).toEqual([]);
  });

  it("COM EAN: has_ean true e identifiers com type ean", () => {
    const p = MagaluPayloadBuilderService.build(
      { ...baseProduct, ean: "7891234567890" },
      OPTS,
    );
    expect(p.has_ean).toBe(true);
    expect(p.identifiers).toEqual([{ type: "ean", value: "7891234567890" }]);
  });

  it("images: >=1, dedup, type image/jpeg", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct, OPTS);
    expect(p.images).toEqual([
      { reference: "https://img/1.jpg", type: "image/jpeg" },
      { reference: "https://img/2.jpg", type: "image/jpeg" },
    ]);
  });

  it("condition: USED para desmonte/sucata; NEW só quando quality=NOVO", () => {
    expect(MagaluPayloadBuilderService.build(baseProduct, OPTS).condition).toBe(
      "USED",
    );
    expect(
      MagaluPayloadBuilderService.build(
        { ...baseProduct, quality: "NOVO" },
        OPTS,
      ).condition,
    ).toBe("NEW");
  });

  it("brand: usa o do produto; fallback 'Genérico' quando ausente", () => {
    expect(
      MagaluPayloadBuilderService.build({ ...baseProduct, brand: "" }, OPTS)
        .brand,
    ).toBe("Genérico");
  });

  it("category só entra quando opts.categoryId é passado", () => {
    expect(
      MagaluPayloadBuilderService.build(baseProduct, OPTS),
    ).not.toHaveProperty("category");
    expect(
      MagaluPayloadBuilderService.build(baseProduct, {
        ...OPTS,
        categoryId: "cat-9",
      }).category,
    ).toEqual({ id: "cat-9" });
  });

  it("faz clamp do título em 150 e do sku em 32", () => {
    const p = MagaluPayloadBuilderService.build(
      { ...baseProduct, name: "A".repeat(500), sku: "S".repeat(50) },
      OPTS,
    );
    expect(p.title.length).toBe(150);
    expect(p.sku.length).toBe(32);
  });
});

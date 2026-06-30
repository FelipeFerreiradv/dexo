import { describe, it, expect } from "vitest";
import { MagaluPayloadBuilderService } from "../magalu-payload-builder.service";

describe("MagaluPayloadBuilderService.build", () => {
  const baseProduct = {
    name: "Farol Dianteiro Gol G5",
    description: "Peça usada em bom estado",
    sku: "SKU-123",
    price: 199.9,
    stock: 3,
    imageUrl: "https://img/1.jpg",
    imageUrls: ["https://img/1.jpg", "https://img/2.jpg"],
    weightKg: 1.2,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
  };

  it("mapeia os campos básicos do Product", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct);
    expect(p.title).toBe("Farol Dianteiro Gol G5");
    expect(p.sku).toBe("SKU-123");
    expect(p.price).toBe(199.9);
    expect(p.quantity).toBe(3);
    expect(p.dimensions).toEqual({
      weight: 1.2,
      height: 10,
      width: 20,
      length: 30,
    });
  });

  it("ITEM SEM EAN: não inclui a chave `ean` no payload", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct);
    expect("ean" in p).toBe(false);
  });

  it("inclui `ean` quando o produto tem EAN/GTIN", () => {
    const p = MagaluPayloadBuilderService.build({
      ...baseProduct,
      ean: "7891234567890",
    });
    expect(p.ean).toBe("7891234567890");
  });

  it("brand: usa o do produto; fallback 'Genérico' quando ausente (obrigatório p/ Magalu)", () => {
    expect(
      MagaluPayloadBuilderService.build({ ...baseProduct, brand: "Renault" })
        .brand,
    ).toBe("Renault");
    expect(MagaluPayloadBuilderService.build(baseProduct).brand).toBe(
      "Genérico",
    );
  });

  it("deduplica imagens preservando a ordem", () => {
    const p = MagaluPayloadBuilderService.build(baseProduct);
    expect(p.images).toEqual(["https://img/1.jpg", "https://img/2.jpg"]);
  });

  it("usa categoryId do parâmetro; senão magaluCategoryId do produto", () => {
    expect(
      MagaluPayloadBuilderService.build(baseProduct, "CAT-9").category_id,
    ).toBe("CAT-9");
    expect(
      MagaluPayloadBuilderService.build({
        ...baseProduct,
        magaluCategoryId: "CAT-P",
      }).category_id,
    ).toBe("CAT-P");
  });

  it("faz clamp do título no limite máximo", () => {
    const longName = "A".repeat(500);
    const p = MagaluPayloadBuilderService.build({
      ...baseProduct,
      name: longName,
    });
    expect(p.title.length).toBeLessThanOrEqual(150);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FacebookPayloadBuilderService } from "../facebook-payload-builder.service";

const OPTS = {
  googleProductCategory: "Vehicles & Parts > Vehicle Parts & Accessories",
};

describe("FacebookPayloadBuilderService", () => {
  beforeEach(() => {
    process.env.FB_PRODUCT_URL_BASE = "https://loja.example.com/produto";
  });
  afterEach(() => {
    delete process.env.FB_PRODUCT_URL_BASE;
  });

  it("build monta o item com campos do catálogo", () => {
    const product = {
      sku: "ABC-123",
      name: "Retrovisor Gol",
      description: "Retrovisor esquerdo",
      price: 199.9,
      brand: "VW",
      itemCondition: "USADO",
      imageUrl: "https://img/1.jpg",
      imageUrls: ["https://img/2.jpg"],
    };
    const data = FacebookPayloadBuilderService.build(product, OPTS);
    expect(data.name).toBe("Retrovisor Gol");
    expect(data.availability).toBe("in stock");
    expect(data.condition).toBe("used");
    expect(data.price).toBe("199.90 BRL");
    expect(data.currency).toBe("BRL");
    expect(data.link).toBe("https://loja.example.com/produto/ABC-123");
    expect(data.image_url).toBe("https://img/1.jpg");
    expect(data.additional_image_urls).toEqual(["https://img/2.jpg"]);
    expect(data.brand).toBe("VW");
    expect(data.google_product_category).toBe(OPTS.googleProductCategory);
  });

  it("availability e quantity respeitam as opts", () => {
    const data = FacebookPayloadBuilderService.build(
      { sku: "S1", name: "Peça", price: 10 },
      { ...OPTS, availability: "out of stock", quantity: 0 },
    );
    expect(data.availability).toBe("out of stock");
    expect(data.quantity_to_sell_on_facebook).toBe(0);
  });

  it("buildRetailerId sanitiza e trunca ≤100", () => {
    expect(
      FacebookPayloadBuilderService.buildRetailerId({ sku: "A B/C" }),
    ).toBe("A_B_C");
    const long = "x".repeat(150);
    expect(
      FacebookPayloadBuilderService.buildRetailerId({ sku: long }).length,
    ).toBe(100);
  });

  it("buildLink lança erro claro sem FB_PRODUCT_URL_BASE", () => {
    delete process.env.FB_PRODUCT_URL_BASE;
    expect(() =>
      FacebookPayloadBuilderService.buildLink({ sku: "S1" }),
    ).toThrow(/FB_PRODUCT_URL_BASE/);
  });

  it("mapCondition: NOVO→new, RECONDICIONADO→refurbished, resto→used", () => {
    const cat = OPTS.googleProductCategory;
    expect(
      FacebookPayloadBuilderService.build(
        { sku: "a", name: "n", itemCondition: "NOVO" },
        { googleProductCategory: cat },
      ).condition,
    ).toBe("new");
    expect(
      FacebookPayloadBuilderService.build(
        { sku: "b", name: "n", itemCondition: "RECONDICIONADO" },
        { googleProductCategory: cat },
      ).condition,
    ).toBe("refurbished");
    expect(
      FacebookPayloadBuilderService.build(
        { sku: "c", name: "n", quality: "SUCATA" },
        { googleProductCategory: cat },
      ).condition,
    ).toBe("used");
  });
});

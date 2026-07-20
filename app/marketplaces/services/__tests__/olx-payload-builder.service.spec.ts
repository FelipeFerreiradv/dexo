import { describe, it, expect } from "vitest";
import { OlxPayloadBuilderService } from "../olx-payload-builder.service";

const baseOpts = {
  categoryId: 123,
  phone: "(21) 99999-8888",
  zipcode: "20000-000",
};

describe("OlxPayloadBuilderService.build", () => {
  it("mapeia campos básicos do produto para o ad OLX", () => {
    const ad = OlxPayloadBuilderService.build(
      {
        sku: "ABC123",
        name: "Farol Direito Gol 2012",
        description: "Farol em bom estado",
        price: 249.9,
        imageUrl: "https://x/1.jpg",
        imageUrls: ["https://x/2.jpg"],
      },
      baseOpts,
    );

    expect(ad.id).toBe("ABC123");
    expect(ad.operation).toBe("insert");
    expect(ad.category).toBe(123);
    expect(ad.Subject).toBe("Farol Direito Gol 2012");
    expect(ad.Body).toBe("Farol em bom estado");
    expect(ad.type).toBe("u");
    // price INTEIRO, sem decimais
    expect(ad.price).toBe(250);
    // telefone/cep só dígitos
    expect(ad.Phone).toBe("21999998888");
    expect(ad.zipcode).toBe("20000000");
    // 1ª imagem = principal, dedup
    expect(ad.images).toEqual(["https://x/1.jpg", "https://x/2.jpg"]);
  });

  it("sanitiza SKU inválido e trunca em 19 chars no id", () => {
    const ad = OlxPayloadBuilderService.build(
      { sku: "SK U/2024#COM-MUITOS-CARACTERES", name: "Peça", price: 10 },
      baseOpts,
    );
    expect(ad.id.length).toBeLessThanOrEqual(19);
    expect(ad.id).toMatch(/^[A-Za-z0-9_{}-]{1,19}$/);
  });

  it("respeita título máximo de 90 e mínimo de 2", () => {
    const adLong = OlxPayloadBuilderService.build(
      {
        sku: "S1",
        name: "x".repeat(200),
        description: "y".repeat(7000),
        price: 5,
      },
      baseOpts,
    );
    expect(adLong.Subject.length).toBe(90);
    expect(adLong.Body.length).toBe(6000);

    const adShort = OlxPayloadBuilderService.build(
      { sku: "S2", name: "", description: "", price: 5 },
      baseOpts,
    );
    expect(adShort.Subject.length).toBeGreaterThanOrEqual(2);
    expect(adShort.Body.length).toBeGreaterThanOrEqual(2);
  });

  it("preço inválido/zerado vira 0", () => {
    const ad = OlxPayloadBuilderService.build(
      { sku: "S3", name: "Peça", price: undefined },
      baseOpts,
    );
    expect(ad.price).toBe(0);
  });
});

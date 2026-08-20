import { describe, expect, it } from "vitest";
import {
  listingFieldOriginLabel,
  resolveListingCategory,
  resolveListingField,
} from "../app/produtos/lib/listing-field-origin";

/**
 * A regra que o modal de edição precisa acertar:
 *
 *   override do anúncio  ??  valor real do anúncio  ??  valor do produto
 *
 * O caso que motivou tudo é o do meio: anúncio publicado numa categoria e
 * produto em outra, SEM override. A leitura ingênua ("override é null, então é
 * igual ao produto") mostra a categoria errada e o operador edita às cegas.
 */

describe("resolveListingField — precedência", () => {
  it("override ganha de todo mundo", () => {
    expect(
      resolveListingField({
        override: "MLB999",
        listingReal: "MLB1747",
        product: "MLB101763",
      }),
    ).toEqual({ value: "MLB999", origin: "override" });
  });

  it("sem override, o valor REAL do anúncio ganha do produto", () => {
    expect(
      resolveListingField({
        override: null,
        listingReal: "MLB1747",
        product: "MLB101763",
      }),
    ).toEqual({ value: "MLB1747", origin: "listing" });
  });

  it("sem override e sem valor real, herda do produto", () => {
    expect(
      resolveListingField({
        override: null,
        listingReal: null,
        product: "MLB101763",
      }),
    ).toEqual({ value: "MLB101763", origin: "product" });
  });

  it("nenhuma das três fontes: value null, origin product", () => {
    expect(resolveListingField({})).toEqual({ value: null, origin: "product" });
  });

  it("string vazia é ausência, não valor", () => {
    expect(
      resolveListingField({ override: "", listingReal: "MLB1747" }),
    ).toEqual({ value: "MLB1747", origin: "listing" });
    expect(
      resolveListingField({ override: "   ", listingReal: "MLB1747" }),
    ).toEqual({ value: "MLB1747", origin: "listing" });
  });

  it("0 e false SÃO valores — não podem cair para o produto", () => {
    expect(resolveListingField({ override: 0, product: 30 })).toEqual({
      value: 0,
      origin: "override",
    });
    expect(resolveListingField({ override: false, product: true })).toEqual({
      value: false,
      origin: "override",
    });
  });

  it("undefined é tratado como ausente, igual a null", () => {
    expect(
      resolveListingField({ override: undefined, product: "MLB101763" }),
    ).toEqual({ value: "MLB101763", origin: "product" });
  });

  it("array e objeto passam sem serem interpretados", () => {
    const attrs = { OEM: { value_name: "ABC" } };
    expect(resolveListingField({ override: attrs, product: null })).toEqual({
      value: attrs,
      origin: "override",
    });
    expect(resolveListingField({ override: [], product: ["x"] })).toEqual({
      value: [],
      origin: "override",
    });
  });
});

describe("listingFieldOriginLabel", () => {
  it("dá ao operador o vocabulário da convenção do PUT", () => {
    expect(listingFieldOriginLabel("override")).toBe(
      "personalizado neste anúncio",
    );
    expect(listingFieldOriginLabel("listing")).toBe("do anúncio publicado");
    expect(listingFieldOriginLabel("product")).toBe("herdado do produto");
  });
});

describe("resolveListingCategory", () => {
  it("O CASO DO PEDIDO: sem override, mostra a categoria do ANÚNCIO com nome", () => {
    expect(
      resolveListingCategory({
        override: null,
        requestedCategoryId: "MLB1747",
        requestedCategoryPath: "Acessórios para Veículos > Fechaduras",
        productCategoryId: "MLB101763",
      }),
    ).toEqual({
      id: "MLB1747",
      label: "Acessórios para Veículos > Fechaduras",
      origin: "listing",
    });
  });

  it("o path do backend descreve requestedCategoryId — não vaza para o override", () => {
    const r = resolveListingCategory({
      override: "MLB999",
      requestedCategoryId: "MLB1747",
      requestedCategoryPath: "Acessórios para Veículos > Fechaduras",
      productCategoryId: "MLB101763",
    });
    expect(r.id).toBe("MLB999");
    expect(r.origin).toBe("override");
    // Rotular MLB999 com o nome de MLB1747 seria mentira com cara de verdade.
    expect(r.label).toBe("MLB999");
  });

  it("com a lista de categorias carregada, o override também ganha nome", () => {
    const r = resolveListingCategory({
      override: "MLB999",
      requestedCategoryId: "MLB1747",
      requestedCategoryPath: "Acessórios para Veículos > Fechaduras",
      labelById: new Map([["MLB999", "Acessórios > Espelhos"]]),
    });
    expect(r.label).toBe("Acessórios > Espelhos");
    expect(r.origin).toBe("override");
  });

  it("labelById também aceita objeto simples", () => {
    const r = resolveListingCategory({
      override: "MLB999",
      labelById: { MLB999: "Acessórios > Espelhos" },
    });
    expect(r.label).toBe("Acessórios > Espelhos");
  });

  it("sem rótulo conhecido, o id vira o rótulo (melhor que a categoria errada)", () => {
    expect(
      resolveListingCategory({
        requestedCategoryId: "SHP_101710",
        requestedCategoryPath: null,
        productCategoryId: "SHP_999",
      }),
    ).toEqual({ id: "SHP_101710", label: "SHP_101710", origin: "listing" });
  });

  it("anúncio antigo sem requestedCategoryId cai no produto, marcado como herdado", () => {
    expect(
      resolveListingCategory({
        override: null,
        requestedCategoryId: null,
        productCategoryId: "MLB101763",
        labelById: { MLB101763: "Acessórios > Fechaduras" },
      }),
    ).toEqual({
      id: "MLB101763",
      label: "Acessórios > Fechaduras",
      origin: "product",
    });
  });

  it("sem categoria em lugar nenhum devolve id e label nulos", () => {
    expect(resolveListingCategory({})).toEqual({
      id: null,
      label: null,
      origin: "product",
    });
  });

  it("path só de espaços não conta como rótulo", () => {
    const r = resolveListingCategory({
      requestedCategoryId: "MLB1747",
      requestedCategoryPath: "   ",
    });
    expect(r.label).toBe("MLB1747");
  });
});

import { describe, it, expect } from "vitest";
import {
  isCategoryShapedCause,
  isUserProductSeller,
  maySuggestAnotherCategory,
  shouldRetryWithTitle,
} from "../app/marketplaces/lib/ml-publish-ladder.logic";

describe("isUserProductSeller", () => {
  it("só com a tag user_product_seller", () => {
    expect(isUserProductSeller(["normal", "user_product_seller"])).toBe(true);
    expect(isUserProductSeller(["normal"])).toBe(false);
    expect(isUserProductSeller(undefined)).toBe(false);
    expect(isUserProductSeller("user_product_seller")).toBe(false);
  });
});

describe("isCategoryShapedCause — lista fechada de códigos", () => {
  it.each([
    "item.category_id.invalid",
    "item.category_id.not_leaf",
    "item.domain_id.invalid",
    "item.condition.invalid",
  ])("%s é erro de categoria", (code) => {
    expect(isCategoryShapedCause({ code })).toBe(true);
  });

  it.each([
    "item.attribute.product_identifier.invalid_by_domain_catalog", // 7712 = GTIN errado
    "item.attribute.invalid_sanitary_registry_value", // 3702 INMETRO
    "item.attribute.number_invalid_format", // 3708
    "invalid.item.attribute.values", // 3510
    "body.required_fields", // 369
    "item.title.minimum_length",
    "",
  ])("%s NÃO é erro de categoria", (code) => {
    expect(isCategoryShapedCause({ code })).toBe(false);
  });
});

describe("maySuggestAnotherCategory", () => {
  it("erro de dado em todas as tentativas ⇒ não tenta outra categoria", () => {
    expect(
      maySuggestAnotherCategory({
        requestedCategoryCauses: [
          [{ code: "body.required_fields" }],
          [{ code: "item.attribute.invalid_sanitary_registry_value" }],
        ],
      }),
    ).toBe(false);
  });

  it("algum erro de categoria ⇒ tenta", () => {
    expect(
      maySuggestAnotherCategory({
        requestedCategoryCauses: [undefined, [{ code: "item.category_id.invalid" }]],
      }),
    ).toBe(true);
  });

  it("kill-switch ⇒ qualquer erro (comportamento anterior)", () => {
    expect(
      maySuggestAnotherCategory({ requestedCategoryCauses: [], anyErrorOverride: true }),
    ).toBe(true);
  });
});

describe("shouldRetryWithTitle (degrau reverso do family_name de primeira)", () => {
  it("ML pediu title ⇒ sim", () => {
    expect(
      shouldRetryWithTitle([
        {
          type: "error",
          code: "body.required_fields",
          message: "The body does not contains some or none of the following properties [title]",
        },
      ]),
    ).toBe(true);
    expect(shouldRetryWithTitle([{ code: "item.title.required" }])).toBe(true);
  });

  it("ML recusou o family_name ⇒ sim", () => {
    expect(
      shouldRetryWithTitle([{ type: "error", code: "body.invalid_fields", message: "[family_name]" }]),
    ).toBe(true);
  });

  it("erro de dado da ficha ⇒ não (reenviar com título só repete a recusa)", () => {
    expect(
      shouldRetryWithTitle([
        { type: "error", code: "item.attribute.invalid_sanitary_registry_value", message: "INMETRO" },
      ]),
    ).toBe(false);
  });

  it("aviso que cita title não conta; mensagem solta que pede title conta", () => {
    expect(
      shouldRetryWithTitle([{ type: "warning", code: "item.title.required", message: "title" }]),
    ).toBe(false);
    expect(shouldRetryWithTitle([], "body.required_fields [title]")).toBe(true);
    expect(shouldRetryWithTitle(undefined, "Validation error")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  FIXED_FIELD_ATTRS,
  getVisibleAttributes,
  isListAttribute,
  positionNeedsInput,
  type MLDynamicAttribute,
} from "../app/produtos/components/ml-dynamic-attributes.logic";

const attr = (
  over: Partial<MLDynamicAttribute> & { id: string },
): MLDynamicAttribute => ({
  id: over.id,
  name: over.name ?? over.id,
  valueType: over.valueType ?? "string",
  required: over.required ?? false,
  variationRequired: over.variationRequired,
  allowedValues: over.allowedValues,
  valueMaxLength: over.valueMaxLength,
});

const OTHER_FIXED = [
  "BRAND",
  "MODEL",
  "YEAR",
  "VEHICLE_YEAR",
  "PART_NUMBER",
  "MPN",
  "OEM",
  "SELLER_SKU",
  "ITEM_CONDITION",
  "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH",
  "SELLER_PACKAGE_LENGTH",
  "SELLER_PACKAGE_WEIGHT",
];

describe("ficha técnica — POSITION visível e capturável", () => {
  it("POSITION não está mais entre os campos fixos ocultos", () => {
    expect(FIXED_FIELD_ATTRS.has("POSITION")).toBe(false);
  });

  it("os demais campos fixos continuam ocultos (sem regressão)", () => {
    for (const id of OTHER_FIXED) {
      expect(FIXED_FIELD_ATTRS.has(id)).toBe(true);
    }
  });

  it("getVisibleAttributes inclui POSITION e exclui os fixos", () => {
    const attrs = [
      attr({ id: "BRAND" }),
      attr({
        id: "POSITION",
        valueType: "list",
        allowedValues: [{ id: "DE", name: "Dianteira esquerda" }],
      }),
      attr({ id: "COLOR" }),
    ];
    const visible = getVisibleAttributes(attrs).map((a) => a.id);
    expect(visible).toContain("POSITION");
    expect(visible).toContain("COLOR");
    expect(visible).not.toContain("BRAND");
  });

  it("POSITION com allowedValues renderiza como Select (isListAttribute)", () => {
    const posList = attr({
      id: "POSITION",
      valueType: "list",
      allowedValues: [
        { id: "DE", name: "Dianteira esquerda" },
        { id: "DD", name: "Dianteira direita" },
      ],
    });
    expect(isListAttribute(posList)).toBe(true);
    const posText = attr({ id: "POSITION", valueType: "string" });
    expect(isListAttribute(posText)).toBe(false);
  });

  it("positionNeedsInput: true quando exposto+vazio; false quando preenchido ou ausente", () => {
    const posList = attr({
      id: "POSITION",
      valueType: "list",
      allowedValues: [{ id: "DE", name: "Dianteira esquerda" }],
    });
    expect(positionNeedsInput([posList], {})).toBe(true);
    expect(
      positionNeedsInput([posList], {
        POSITION: { value_id: "DE", value_name: "Dianteira esquerda" },
      }),
    ).toBe(false);
    // POSITION não exposto pela categoria → não pede input.
    expect(positionNeedsInput([attr({ id: "COLOR" })], {})).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  getVisibleAttributes,
  type MLDynamicAttribute,
} from "../app/produtos/components/ml-dynamic-attributes.logic";

const attr = (
  o: Partial<MLDynamicAttribute> & { id: string },
): MLDynamicAttribute => ({
  id: o.id,
  name: o.name ?? o.id,
  valueType: o.valueType ?? "string",
  required: o.required ?? false,
  hidden: o.hidden,
  allowedValues: o.allowedValues,
});

describe("getVisibleAttributes — respeita tags.hidden do ML", () => {
  it("esconde hidden opcional; mantém não-hidden e hidden OBRIGATÓRIO", () => {
    const attrs = [
      attr({ id: "NORMAL" }),
      attr({ id: "HID_OPT", hidden: true }),
      attr({ id: "HID_REQ", hidden: true, required: true }),
      attr({
        id: "POSITION",
        valueType: "list",
        allowedValues: [{ id: "DE", name: "Dianteira esquerda" }],
      }),
    ];
    const ids = getVisibleAttributes(attrs).map((a) => a.id);
    expect(ids).toContain("NORMAL");
    expect(ids).not.toContain("HID_OPT");
    // Invariante crítica: obrigatório NUNCA some, mesmo marcado hidden.
    expect(ids).toContain("HID_REQ");
    expect(ids).toContain("POSITION");
  });

  it("retrocompat: atributo sem campo hidden (undefined) permanece visível", () => {
    const attrs = [attr({ id: "OLD_SHAPE" })];
    expect(getVisibleAttributes(attrs).map((a) => a.id)).toContain("OLD_SHAPE");
  });
});

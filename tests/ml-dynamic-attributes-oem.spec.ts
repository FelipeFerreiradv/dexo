import { describe, expect, it } from "vitest";

import {
  FIXED_FIELD_ATTRS,
  OEM_FIELD_ATTR_ID,
  OEM_MAX_LENGTH,
  getVisibleAttributes,
  positionNeedsInput,
  sectionFieldCount,
  shouldRenderSection,
  type MLDynamicAttribute,
} from "../app/produtos/components/ml-dynamic-attributes.logic";

const attr = (
  id: string,
  extra: Partial<MLDynamicAttribute> = {},
): MLDynamicAttribute => ({
  id,
  name: id,
  valueType: "string",
  required: false,
  ...extra,
});

describe("campo fixo Código OEM — visibilidade da seção", () => {
  it("categoria SEM atributo extra: a seção existe por causa do OEM", () => {
    expect(shouldRenderSection(0, true)).toBe(true);
  });

  it("com a flag desligada, categoria sem atributo extra volta a sumir", () => {
    expect(shouldRenderSection(0, false)).toBe(false);
  });

  it("categoria COM atributos extras renderiza nos dois casos", () => {
    expect(shouldRenderSection(3, true)).toBe(true);
    expect(shouldRenderSection(3, false)).toBe(true);
  });
});

describe("contador do cabeçalho", () => {
  it("soma o campo OEM quando ele está visível", () => {
    expect(sectionFieldCount(0, true)).toBe(1);
    expect(sectionFieldCount(4, true)).toBe(5);
  });

  it("com a flag desligada, o contador é o de antes", () => {
    expect(sectionFieldCount(0, false)).toBe(0);
    expect(sectionFieldCount(4, false)).toBe(4);
  });
});

describe("não-regressão da lista dinâmica", () => {
  // O campo OEM é FIXO. Se `OEM` saísse de FIXED_FIELD_ATTRS ele apareceria
  // TAMBÉM na lista dinâmica (campo duplicado) e só nas categorias que expõem
  // o id — o oposto do pedido.
  it("OEM continua em FIXED_FIELD_ATTRS", () => {
    expect(FIXED_FIELD_ATTRS.has(OEM_FIELD_ATTR_ID)).toBe(true);
  });

  it("getVisibleAttributes NUNCA devolve OEM (sem campo duplicado)", () => {
    const visible = getVisibleAttributes([
      attr("OEM"),
      attr("POSITION"),
      attr("MATERIAL"),
    ]);
    expect(visible.map((a) => a.id)).toEqual(["POSITION", "MATERIAL"]);
  });

  it("os demais campos fixos seguem fora da lista", () => {
    const visible = getVisibleAttributes([
      attr("BRAND"),
      attr("MODEL"),
      attr("PART_NUMBER"),
      attr("MPN"),
      attr("COLOR"),
    ]);
    expect(visible.map((a) => a.id)).toEqual(["COLOR"]);
  });

  it("hidden do ML continua respeitado, e required vence hidden", () => {
    const visible = getVisibleAttributes([
      attr("ESCONDIDO", { hidden: true }),
      attr("ESCONDIDO_OBRIGATORIO", { hidden: true, required: true }),
    ]);
    expect(visible.map((a) => a.id)).toEqual(["ESCONDIDO_OBRIGATORIO"]);
  });
});

describe("positionNeedsInput — sem regressão", () => {
  it("true quando a categoria expõe POSITION e o operador não informou", () => {
    expect(positionNeedsInput([attr("POSITION")], {})).toBe(true);
  });

  it("false quando já informado", () => {
    expect(
      positionNeedsInput([attr("POSITION")], {
        POSITION: { value_name: "Dianteira" },
      }),
    ).toBe(false);
  });

  it("whitespace conta como vazio", () => {
    expect(
      positionNeedsInput([attr("POSITION")], { POSITION: { value_name: "  " } }),
    ).toBe(true);
  });

  it("o OEM preenchido não interfere no cálculo de POSITION", () => {
    expect(
      positionNeedsInput([attr("POSITION")], {
        [OEM_FIELD_ATTR_ID]: { value_name: "5U0121049" },
      }),
    ).toBe(true);
  });

  it("false quando a categoria não expõe POSITION", () => {
    expect(positionNeedsInput([attr("MATERIAL")], {})).toBe(false);
  });
});

describe("limite do campo", () => {
  it("usa o value_max_length real do atributo OEM no ML", () => {
    expect(OEM_MAX_LENGTH).toBe(255);
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  INMETRO_ATTR_ID,
  isListAttribute,
  isPictureAttribute,
  joinNumberUnit,
  splitNumberUnit,
  usesUnitSelector,
  type MLDynamicAttribute,
} from "../app/produtos/components/ml-dynamic-attributes.logic";

/**
 * Ficha técnica (PR-3): número com unidade, campo de imagem travado e dica do
 * INMETRO. Os três campos respondem pelas recusas 3708, 422 e 3702 dos logs.
 */

const base = (over: Partial<MLDynamicAttribute>): MLDynamicAttribute => ({
  id: "X",
  name: "X",
  valueType: "string",
  required: false,
  ...over,
});

const LARGURA = base({
  id: "WIDTH",
  name: "Largura",
  valueType: "number_unit",
  allowedUnits: ["mm", "cm", "m", '"'],
  defaultUnit: "cm",
});

describe("usesUnitSelector / isPictureAttribute", () => {
  it("seletor de unidade só com number_unit E unidades conhecidas", () => {
    expect(usesUnitSelector(LARGURA)).toBe(true);
    expect(usesUnitSelector({ ...LARGURA, allowedUnits: undefined })).toBe(false);
    expect(usesUnitSelector({ ...LARGURA, allowedUnits: [] })).toBe(false);
    expect(usesUnitSelector(base({ valueType: "number", allowedUnits: ["cm"] }))).toBe(false);
  });

  it("campo de imagem = picture_id", () => {
    expect(isPictureAttribute(base({ valueType: "picture_id" }))).toBe(true);
    expect(isPictureAttribute(base({ valueType: "string" }))).toBe(false);
  });

  it("number_unit com valores sugeridos continua lista (precedência de antes)", () => {
    const comValores = { ...LARGURA, allowedValues: [{ id: "1", name: "10 cm" }] };
    expect(isListAttribute(comValores)).toBe(true);
  });
});

describe("splitNumberUnit", () => {
  it.each([
    ["30 cm", { number: "30", unit: "cm" }],
    ["30cm", { number: "30", unit: "cm" }],
    ["30 CM", { number: "30", unit: "cm" }],
    ["10,5 m", { number: "10.5", unit: "m" }],
    ['12 "', { number: "12", unit: '"' }],
    ["30", { number: "30", unit: null }],
    ["", { number: "", unit: null }],
  ])("'%s'", (raw, esperado) => {
    expect(splitNumberUnit(raw, LARGURA.allowedUnits!)).toEqual(esperado);
  });

  it("unidade fora da lista volta como inválida (a tela pede a unidade)", () => {
    expect(splitNumberUnit("30 kg", LARGURA.allowedUnits!)).toEqual({
      number: "30",
      unit: null,
      invalidUnit: "kg",
    });
  });

  it("texto que não é número", () => {
    expect(splitNumberUnit("abc", LARGURA.allowedUnits!)).toEqual({
      number: "",
      unit: null,
      invalidUnit: "abc",
    });
  });
});

describe("joinNumberUnit (formato gravado = o que o ML aceita)", () => {
  it("número + unidade", () => expect(joinNumberUnit("30", "cm")).toBe("30 cm"));
  it("sem unidade grava só o número", () => expect(joinNumberUnit("30", null)).toBe("30"));
  it("sem número = limpar", () => expect(joinNumberUnit("  ", "cm")).toBeNull());
  it("ida e volta", () => {
    const p = splitNumberUnit(joinNumberUnit("2.5", "m"), LARGURA.allowedUnits!);
    expect(p).toEqual({ number: "2.5", unit: "m" });
  });
});

describe("fiação no componente (sem jsdom: lê o fonte)", () => {
  const fonte = fs.readFileSync(
    path.resolve(__dirname, "../app/produtos/components/ml-dynamic-attributes-section.tsx"),
    "utf8",
  );

  it("usa os helpers e grava via joinNumberUnit", () => {
    expect(fonte).toMatch(/usesUnitSelector\(attr\)/);
    expect(fonte).toMatch(/splitNumberUnit\(current\.value_name, unidades\)/);
    expect(fonte).toMatch(/joinNumberUnit\(numero, unidade \|\| null\)/);
  });

  it("campo de imagem não tem input editável; só o botão de remover", () => {
    const bloco = fonte.slice(
      fonte.indexOf("if (isPictureAttribute(attr))"),
      fonte.indexOf("if (usesUnitSelector(attr))"),
    );
    expect(bloco).not.toMatch(/<Input/);
    expect(bloco).toMatch(/updateAttr\(attr\.id, null\)/);
    expect(bloco).toMatch(/Remover valor inválido/);
  });

  it("dica do INMETRO no campo certo", () => {
    expect(INMETRO_ATTR_ID).toBe("INMETRO_CERTIFICATION_REGISTRATION_NUMBER");
    expect(fonte).toMatch(/attr\.id === INMETRO_ATTR_ID/);
  });

  it("imagem e unidade vêm DEPOIS da lista (lista continua com precedência)", () => {
    expect(fonte.indexOf("if (isList)")).toBeLessThan(
      fonte.indexOf("if (isPictureAttribute(attr))"),
    );
  });
});

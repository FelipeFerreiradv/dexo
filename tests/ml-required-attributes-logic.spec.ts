import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// O catálogo importa o prisma; a normalização é pura.
vi.mock("@/app/lib/prisma", () => ({ default: {} }));

import {
  normalizeMLCategoryAttribute,
  type NormalizedMLAttribute,
} from "../app/marketplaces/services/ml-attribute-catalog.service";
import {
  evaluateMLRequiredAttributes,
  isMlRequiredAttrsBlockEnabled,
  issuesFromMissingAttributeIds,
  mlAttributeFormField,
  attributeHasValue,
  attributeValueIsAllowed,
  normalizeAttributeValueName,
  isClosedListAttribute,
  summarizeMLRequiredAttributeIssues,
  shouldSkipMlRequiredBlockForCatalog,
  ML_SOFT_REQUIRED_ATTRIBUTE_IDS,
  ML_PAYLOAD_MANAGED_ATTRIBUTE_IDS,
  ML_REQUIRED_ATTRS_GENERIC_MESSAGE,
  type MLPayloadAttribute,
} from "../app/marketplaces/lib/ml-required-attributes.logic";

/**
 * A regra nova de obrigatórios contra o JSON CRU de
 * GET /categories/{id}/attributes (capturado com curl público, sem token) —
 * passado pelo MESMO normalize do cache. É isto que prova que a régua estrita
 * libera MOUNT_TYPE (só catalog_required) e VEHICLE_TYPE (required+fixed), os
 * dois que tornavam o preflight `strict` impossível de ligar.
 */

const FIXTURES = path.resolve(__dirname, "fixtures", "ml-category-attributes");

function catalogo(arquivo: string): NormalizedMLAttribute[] {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, arquivo), "utf8"));
  return (raw.attributes as any[]).map((a) => normalizeMLCategoryAttribute(a));
}

const M1 =
  "Esta categoria do Mercado Livre exige o preenchimento do Part Number. Preencha esse campo antes de continuar.";
const M2 =
  "Esta categoria exige o lado da peça. Selecione Direito ou Esquerdo antes de publicar o anúncio.";
const M3 =
  "Esta categoria exige a posição da peça. Selecione a posição antes de publicar o anúncio.";
const M6 =
  "O lado da peça informado não é aceito por esta categoria. Selecione Direito ou Esquerdo antes de publicar o anúncio.";

const avaliar = (
  cat: NormalizedMLAttribute[] | undefined | null,
  payload: MLPayloadAttribute[],
  catalogListing = false,
) =>
  evaluateMLRequiredAttributes({
    categoryAttributes: cat,
    payloadAttributes: payload,
    catalogListing,
  });

const BRAND: MLPayloadAttribute = { id: "BRAND", value_name: "Volkswagen" };
const PN: MLPayloadAttribute = { id: "PART_NUMBER", value_name: "5U0807217" };

describe("evaluateMLRequiredAttributes — fixtures reais", () => {
  it.each(["MLB46723", "MLB63822", "MLB458756"])(
    "A1: PART_NUMBER (required+catalog_required) ausente bloqueia com M1 em %s",
    (id) => {
      const r = avaliar(catalogo(`${id}.raw.json`), [BRAND]);
      expect(r.status).toBe("blocked");
      expect(r.blocking.map((b) => b.attributeId)).toEqual(["PART_NUMBER"]);
      expect(r.blocking[0].reason).toBe("missing");
      expect(r.message).toBe(M1);
    },
  );

  it("A2: MOUNT_TYPE só catalog_required (MLB2221) ausente NÃO bloqueia fora do catálogo", () => {
    const cat = catalogo("MLB2221.raw.json");
    expect(cat.find((a) => a.id === "MOUNT_TYPE")?.required).toBe(true); // régua larga
    const r = avaliar(cat, [BRAND, PN]);
    expect(r.status).toBe("ok");
    expect(r.blocking).toEqual([]);
  });

  it("A3: o mesmo MOUNT_TYPE bloqueia quando catalogListing=true", () => {
    const r = avaliar(catalogo("MLB2221.raw.json"), [BRAND, PN], true);
    expect(r.status).toBe("blocked");
    expect(r.blocking.map((b) => b.attributeId)).toEqual(["MOUNT_TYPE"]);
  });

  it("A4: VEHICLE_TYPE required+fixed (MLB456395) ausente NÃO bloqueia", () => {
    const cat = catalogo("MLB456395.raw.json");
    const vt = cat.find((a) => a.id === "VEHICLE_TYPE");
    expect(vt?.requiredTag).toBe(true);
    expect(vt?.fixedTag).toBe(true);
    const r = avaliar(cat, [BRAND, PN]);
    expect(r.status).toBe("ok");
  });

  it("SIDE obrigatório (MLB431271) ausente bloqueia com M2", () => {
    const r = avaliar(catalogo("MLB431271.raw.json"), [BRAND, PN]);
    expect(r.blocking.map((b) => b.attributeId)).toEqual(["SIDE"]);
    expect(r.message).toBe(M2);
  });

  it("FUEL_TYPE (MLB47115) ausente usa o rótulo com artigo (M4)", () => {
    const r = avaliar(catalogo("MLB47115.raw.json"), [BRAND, PN]);
    expect(r.message).toBe(
      "Esta categoria do Mercado Livre exige o preenchimento do Tipo de combustível. Preencha esse campo antes de continuar.",
    );
  });

  it("POSITION (MLB243555) ausente usa a mensagem de posição (M3)", () => {
    const r = avaliar(catalogo("MLB243555.raw.json"), [BRAND, PN]);
    expect(r.blocking.map((b) => b.attributeId)).toEqual(["POSITION"]);
    expect(r.message).toBe(M3);
  });

  it("A11: BRAND é string com valores SUGERIDOS — texto livre fora da lista passa", () => {
    const cat = catalogo("MLB46723.raw.json");
    const brand = cat.find((a) => a.id === "BRAND")!;
    expect(brand.allowedValues?.length).toBeGreaterThan(0);
    expect(isClosedListAttribute(brand)).toBe(false);
    const r = avaliar(cat, [{ id: "BRAND", value_name: "Marca Inventada" }, PN]);
    expect(r.status).toBe("ok");
  });

  it("A18: atributo do payload fora do catálogo não afeta", () => {
    const r = avaliar(catalogo("MLB46723.raw.json"), [
      BRAND,
      PN,
      { id: "NAO_EXISTE_NA_CATEGORIA", value_name: "x" },
    ]);
    expect(r.status).toBe("ok");
    expect(r.warnings.find((w) => w.attributeId === "NAO_EXISTE_NA_CATEGORIA")).toBeUndefined();
  });

  it("M9: dois bloqueios juntam as mensagens na ordem do catálogo", () => {
    const r = avaliar(catalogo("MLB431271.raw.json"), []);
    const ids = r.blocking.map((b) => b.attributeId);
    expect(ids).toEqual(["BRAND", "SIDE", "PART_NUMBER"]);
    expect(r.message).toBe(r.blocking.map((b) => b.message).join(" "));
    expect(r.message).toContain(M2);
    expect(r.message).toContain(M1);
  });
});

describe("evaluateMLRequiredAttributes — fixture sintética", () => {
  const sint = () => catalogo("synthetic-conditional.synthetic.json");
  const completo: MLPayloadAttribute[] = [
    BRAND,
    PN,
    { id: "VEHICLE_SIDE", value_id: "ESQ", value_name: "Esquerdo" },
    { id: "IS_KIT", value_id: "242084", value_name: "Não" },
  ];

  it("A5: conditional_required ausente vira aviso M8 e status ok", () => {
    const r = avaliar(sint(), completo);
    expect(r.status).toBe("ok");
    const gtin = r.warnings.find((w) => w.attributeId === "GTIN");
    expect(gtin?.message).toBe(
      'Esta categoria do Mercado Livre pode exigir o campo "Código universal de produto", dependendo das outras informações do anúncio.',
    );
  });

  it("A8: lista fechada — value_id fora de allowedValues bloqueia com invalid_value (M6)", () => {
    const payload = completo.map((a) =>
      a.id === "VEHICLE_SIDE" ? { id: "VEHICLE_SIDE", value_id: "XX" } : a,
    );
    const r = avaliar(sint(), payload);
    expect(r.status).toBe("blocked");
    expect(r.blocking).toEqual([
      expect.objectContaining({ attributeId: "VEHICLE_SIDE", reason: "invalid_value" }),
    ]);
    expect(r.message).toBe(M6);
  });

  it("A9: value_name casa pelo nome normalizado (caixa, acento, espaços)", () => {
    const payload = completo.map((a) =>
      a.id === "VEHICLE_SIDE" ? { id: "VEHICLE_SIDE", value_name: "  esquerdo " } : a,
    );
    expect(avaliar(sint(), payload).status).toBe("ok");
    const posicao = {
      id: "POSITION",
      name: "Posição",
      valueType: "list",
      requiredTag: true,
      fixedTag: false,
      allowedValues: [{ id: "T", name: "Traseira" }],
    };
    expect(
      avaliar([posicao as any], [{ id: "POSITION", value_name: "TRÁSEIRA" }]).status,
    ).toBe("ok");
    expect(normalizeAttributeValueName("  Dianteira   Esquérda ")).toBe(
      "dianteira esquerda",
    );
  });

  it("A10: value_name fora da lista, em obrigatório de lista fechada, bloqueia", () => {
    const payload = completo.map((a) =>
      a.id === "VEHICLE_SIDE" ? { id: "VEHICLE_SIDE", value_name: "Central" } : a,
    );
    const r = avaliar(sint(), payload);
    expect(r.blocking.map((b) => `${b.attributeId}:${b.reason}`)).toEqual([
      "VEHICLE_SIDE:invalid_value",
    ]);
  });

  it("valor fora da lista em boolean obrigatório usa M7 com o nome", () => {
    const payload = completo.map((a) =>
      a.id === "IS_KIT" ? { id: "IS_KIT", value_id: "999" } : a,
    );
    expect(avaliar(sint(), payload).message).toBe(
      'O valor informado em "É kit" não é aceito por esta categoria do Mercado Livre. Escolha uma das opções da lista antes de continuar.',
    );
  });

  it("A14: SELLER_PACKAGE_*, ITEM_CONDITION e SELLER_SKU obrigatórios ausentes não bloqueiam", () => {
    const r = avaliar(sint(), completo);
    const ids = [...r.blocking, ...r.warnings].map((i) => i.attributeId);
    for (const id of ML_PAYLOAD_MANAGED_ATTRIBUTE_IDS) {
      expect(ids).not.toContain(id);
    }
    expect(r.status).toBe("ok");
  });

  it("A15: SOFT_REQUIRED (COLOR) obrigatório ausente vira aviso", () => {
    const r = avaliar(sint(), completo);
    expect(r.blocking.find((b) => b.attributeId === "COLOR")).toBeUndefined();
    expect(r.warnings.find((w) => w.attributeId === "COLOR")?.reason).toBe("missing");
  });

  it("A16: hidden+required ausente vira aviso", () => {
    const r = avaliar(sint(), completo);
    expect(r.blocking.find((b) => b.attributeId === "HIDDEN_REQ")).toBeUndefined();
    expect(r.warnings.find((w) => w.attributeId === "HIDDEN_REQ")).toBeDefined();
  });
});

describe("evaluateMLRequiredAttributes — valores em branco e preenchidos", () => {
  const cat = () => catalogo("MLB46723.raw.json");

  it.each([
    ["value_name em branco", { id: "PART_NUMBER", value_name: "   " }],
    ["value_id vazio", { id: "PART_NUMBER", value_id: "" }],
    ["objeto vazio", { id: "PART_NUMBER" }],
    ["values vazio", { id: "PART_NUMBER", values: [] }],
    ["values com entradas em branco", { id: "PART_NUMBER", values: [{ name: " " }] }],
  ])("A6: %s conta como ausente", (_, pn) => {
    const r = avaliar(cat(), [BRAND, pn as MLPayloadAttribute]);
    expect(r.status).toBe("blocked");
    expect(r.blocking[0].attributeId).toBe("PART_NUMBER");
  });

  it.each([
    ["value_id sozinho", { id: "PART_NUMBER", value_id: "123" }],
    ["value_name sozinho", { id: "PART_NUMBER", value_name: "ABC123" }],
    ["values[{name}]", { id: "PART_NUMBER", values: [{ name: "ABC123" }] }],
  ])("A7: %s conta como preenchido", (_, pn) => {
    expect(avaliar(cat(), [BRAND, pn as MLPayloadAttribute]).status).toBe("ok");
  });

  it("usa o PRIMEIRO atributo do payload para cada id", () => {
    const r = avaliar(cat(), [
      BRAND,
      { id: "PART_NUMBER", value_name: " " },
      { id: "PART_NUMBER", value_name: "DEPOIS" },
    ]);
    expect(r.status).toBe("blocked");
  });
});

describe("evaluateMLRequiredAttributes — quando NÃO dá para afirmar", () => {
  it("A12: basta UM atributo sem requiredTag booleano (cache antigo) para tags_unknown, mesmo com required:true", () => {
    const cat = catalogo("MLB46723.raw.json");
    const antigo = cat.map((a, i) => {
      if (i !== 3) return a;
      const { requiredTag, catalogRequiredTag, conditionalRequiredTag, fixedTag, ...resto } = a;
      void requiredTag;
      void catalogRequiredTag;
      void conditionalRequiredTag;
      void fixedTag;
      return { ...resto, required: true };
    });
    const r = avaliar(antigo, []);
    expect(r).toEqual({
      status: "unknown",
      unknownReason: "tags_unknown",
      blocking: [],
      warnings: [],
      message: null,
    });
  });

  it("A13: catálogo undefined, null ou [] → catalog_unavailable", () => {
    for (const cat of [undefined, null, []]) {
      const r = avaliar(cat as any, [BRAND]);
      expect(r.status).toBe("unknown");
      expect(r.unknownReason).toBe("catalog_unavailable");
      expect(r.blocking).toEqual([]);
    }
  });
});

describe("helpers puros", () => {
  it("A17: textos exatos de M1, M2, M6 e da genérica M10", () => {
    const [pn] = issuesFromMissingAttributeIds(["PART_NUMBER"]);
    expect(pn.message).toBe(M1);
    const [mpn] = issuesFromMissingAttributeIds(["MPN"]);
    expect(mpn.message).toBe(M1);
    const [side] = issuesFromMissingAttributeIds(["VEHICLE_SIDE"]);
    expect(side.message).toBe(M2);
    expect(ML_REQUIRED_ATTRS_GENERIC_MESSAGE).toBe(
      "Esta categoria do Mercado Livre exige campos obrigatórios que não foram preenchidos. Confira a ficha técnica do produto antes de publicar o anúncio.",
    );
    // Não reaproveita o rótulo antigo ("Número da Peça").
    expect(pn.message).not.toContain("Número da Peça");
  });

  it("M9: summarize — 0 → null, 1 → a mensagem, >1 → junção por espaço", () => {
    const issues = issuesFromMissingAttributeIds(["PART_NUMBER", "SIDE"]);
    expect(summarizeMLRequiredAttributeIssues([])).toBeNull();
    expect(summarizeMLRequiredAttributeIssues([issues[0]])).toBe(M1);
    expect(summarizeMLRequiredAttributeIssues(issues)).toBe(`${M1} ${M2}`);
  });

  it("A19: issuesFromMissingAttributeIds usa o nome do catálogo e cai no id quando ausente", () => {
    const cat = catalogo("MLB458756.raw.json");
    const issues = issuesFromMissingAttributeIds(
      ["MOUNT_TYPE", "INEXISTENTE", "MOUNT_TYPE"],
      cat,
    );
    expect(issues).toHaveLength(2);
    expect(issues[0].attributeName).toBe(
      cat.find((a) => a.id === "MOUNT_TYPE")!.name,
    );
    expect(issues[0].message).toContain(`"${issues[0].attributeName}"`);
    expect(issues[1]).toMatchObject({
      attributeId: "INEXISTENTE",
      attributeName: "INEXISTENTE",
      reason: "missing",
    });
  });

  it("A20: mlAttributeFormField", () => {
    expect(mlAttributeFormField("PART_NUMBER")).toBe("partNumber");
    expect(mlAttributeFormField("MPN")).toBe("partNumber");
    expect(mlAttributeFormField("BRAND")).toBe("brand");
    expect(mlAttributeFormField("MODEL")).toBe("model");
    expect(mlAttributeFormField("YEAR")).toBe("year");
    expect(mlAttributeFormField("VEHICLE_YEAR")).toBe("year");
    expect(mlAttributeFormField("SIDE")).toBe("attributes");
    expect(mlAttributeFormField("")).toBe("attributes");
  });

  it('A21: a flag só liga com "1" exato', () => {
    expect(isMlRequiredAttrsBlockEnabled({})).toBe(false);
    expect(isMlRequiredAttrsBlockEnabled({ ML_REQUIRED_ATTRS_BLOCK: "0" })).toBe(false);
    expect(isMlRequiredAttrsBlockEnabled({ ML_REQUIRED_ATTRS_BLOCK: "true" })).toBe(false);
    expect(isMlRequiredAttrsBlockEnabled({ ML_REQUIRED_ATTRS_BLOCK: " 1" })).toBe(false);
    expect(isMlRequiredAttrsBlockEnabled({ ML_REQUIRED_ATTRS_BLOCK: "1" })).toBe(true);
  });

  it("A21b: sem argumento lê process.env a cada chamada", () => {
    const antes = process.env.ML_REQUIRED_ATTRS_BLOCK;
    try {
      delete process.env.ML_REQUIRED_ATTRS_BLOCK;
      expect(isMlRequiredAttrsBlockEnabled()).toBe(false);
      process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
      expect(isMlRequiredAttrsBlockEnabled()).toBe(true);
    } finally {
      if (antes === undefined) delete process.env.ML_REQUIRED_ATTRS_BLOCK;
      else process.env.ML_REQUIRED_ATTRS_BLOCK = antes;
    }
  });

  it("A22: ML_SOFT_REQUIRED_ATTRIBUTE_IDS tem exatamente a lista do preflight", () => {
    expect([...ML_SOFT_REQUIRED_ATTRIBUTE_IDS]).toEqual([
      "UNIT_OF_LENGTH",
      "COLOR",
      "MAIN_COLOR",
      "SIZE",
      "LENGTH",
      "WIDTH",
      "HEIGHT",
      "WEIGHT",
    ]);
  });

  it("attributeHasValue e attributeValueIsAllowed com values[]", () => {
    expect(attributeHasValue(null)).toBe(false);
    expect(attributeHasValue({ values: [{ id: "1" }] })).toBe(true);
    const attr = {
      id: "X",
      valueType: "list",
      allowedValues: [
        { id: "1", name: "Um" },
        { id: "2", name: "Dois" },
      ],
    };
    expect(attributeValueIsAllowed({ values: [{ id: "1" }, { name: "dois" }] }, attr)).toBe(true);
    expect(attributeValueIsAllowed({ values: [{ id: "1" }, { name: "três" }] }, attr)).toBe(false);
    expect(attributeValueIsAllowed({ values: [] }, attr)).toBe(false);
  });

  it("D7: exceção do anúncio de catálogo só com ML_CATALOG_LISTING_ENABLED=true e produto vinculado", () => {
    expect(shouldSkipMlRequiredBlockForCatalog("MLB123", { ML_CATALOG_LISTING_ENABLED: "true" })).toBe(true);
    expect(shouldSkipMlRequiredBlockForCatalog("MLB123", {})).toBe(false);
    expect(shouldSkipMlRequiredBlockForCatalog("MLB123", { ML_CATALOG_LISTING_ENABLED: "1" })).toBe(false);
    expect(shouldSkipMlRequiredBlockForCatalog("  ", { ML_CATALOG_LISTING_ENABLED: "true" })).toBe(false);
    expect(shouldSkipMlRequiredBlockForCatalog(undefined, { ML_CATALOG_LISTING_ENABLED: "true" })).toBe(false);
  });
});

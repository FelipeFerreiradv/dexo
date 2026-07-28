import { describe, it, expect, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco A — mapper puro de atributos Shopee.
//
// Os schemas usados aqui são recortes REAIS das categorias em cache de
// produção (102298, 102416, 102532 e vizinhas), inclusive os ids e os valores
// que a Shopee publica de fato. É o que garante que o teste fala do mundo, não
// de uma categoria imaginária.
// ──────────────────────────────────────────────────────────

import {
  buildShopeeAttributeList,
  normalizeAttrText,
  parseInputType,
  acceptsFreeText,
  formatCm,
  pickWeightUnit,
  type ShopeeAttrSchema,
} from "@/app/marketplaces/lib/shopee-attribute-mapper";

/** Espelha ListingUseCase.pickSafeMandatoryShopeeValue (injetado no mapper). */
const pickSafe = vi.fn(
  (values: Array<{ value_id: number; value_name: string }>) => values[0],
);

function build(
  categoryAttrs: ShopeeAttrSchema[],
  product: any,
  options?: { legacyMandatoryFallback?: boolean },
) {
  return buildShopeeAttributeList({
    product,
    categoryAttrs,
    pickSafeMandatoryValue: pickSafe as any,
    options,
  });
}

const PRODUTO_BASE = {
  name: "Farol Dianteiro Esquerdo Fiat Argo 2018",
  sku: "12345",
  brand: "Fiat",
  model: "Argo",
  year: "2018",
  partNumber: "51234567",
  quality: "SEMINOVO",
  weightKg: 2.5,
  lengthCm: 30,
  widthCm: 20,
  heightCm: 15,
  attributes: null,
  compatibilities: [],
};

describe("helpers", () => {
  it("normalizeAttrText remove acento, pontuação e colapsa espaço", () => {
    expect(normalizeAttrText("Número da Peça")).toBe("numero da peca");
    expect(normalizeAttrText("Dimension (L x W x H)")).toBe("dimension l x w x h");
    expect(normalizeAttrText("  AUTO-PART   NUMBER ")).toBe("auto part number");
  });

  it("parseInputType lê o numérico-como-string do cache e tolera legado", () => {
    expect(parseInputType("3")).toBe(3);
    expect(parseInputType("5")).toBe(5);
    expect(parseInputType("")).toBeNull();
    expect(parseInputType(undefined)).toBeNull();
    expect(parseInputType("FREE_TEXT")).toBeNull();
    expect(parseInputType("9")).toBeNull();
  });

  it("acceptsFreeText: combo box sim, drop-down não, desconhecido não", () => {
    expect(acceptsFreeText(2)).toBe(true);
    expect(acceptsFreeText(3)).toBe(true);
    expect(acceptsFreeText(5)).toBe(true);
    expect(acceptsFreeText(1)).toBe(false);
    expect(acceptsFreeText(4)).toBe(false);
    expect(acceptsFreeText(null)).toBe(false);
  });

  it("formatCm e pickWeightUnit produzem o formato que a Shopee publica", () => {
    expect(formatCm(27.5)).toBe("27.5 cm");
    expect(formatCm(30)).toBe("30 cm");
    expect(pickWeightUnit(0.35, ["g", "kg"])).toEqual({ value: "350", unit: "g" });
    expect(pickWeightUnit(2.5, ["g", "kg"])).toEqual({ value: "2.5", unit: "kg" });
    expect(pickWeightUnit(2.5, [])).toBeNull();
  });
});

describe("Auto-Part Number (102293) — obrigatório em 85 categorias", () => {
  const schema: ShopeeAttrSchema[] = [
    {
      attribute_id: 102293,
      attribute_name: "Auto-Part Number",
      is_mandatory: true,
      input_type: "3",
      attribute_value_list: [],
    },
  ];

  it("preenche com o partNumber do produto", () => {
    const { attributeList, report } = build(schema, PRODUTO_BASE);
    expect(attributeList).toEqual([
      {
        attribute_id: 102293,
        attribute_name: "Auto-Part Number",
        attribute_value_list: [
          { value_id: 0, original_value_name: "51234567" },
        ],
      },
    ]);
    expect(report.mandatoryEmittedCount).toBe(1);
    expect(report.fallbacks).toHaveLength(0);
  });

  it("sem partNumber cai no fallback legado (brand||name) e REPORTA", () => {
    const { attributeList, report } = build(schema, {
      ...PRODUTO_BASE,
      partNumber: null,
    });
    expect(
      attributeList[0].attribute_value_list[0].original_value_name,
    ).toBe("Fiat");
    expect(report.fallbacks).toHaveLength(1);
    expect(report.fallbacks[0].reason).toBe("mandatory_free_text_no_data");
  });

  it("com legacyMandatoryFallback:false não inventa nada", () => {
    const { attributeList, report } = build(
      schema,
      { ...PRODUTO_BASE, partNumber: null },
      { legacyMandatoryFallback: false },
    );
    expect(attributeList).toHaveLength(0);
    expect(report.hasUnfilledMandatory).toBe(true);
  });

  it("casa também por NOME quando o id é desconhecido (outra locale)", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 999999,
          attribute_name: "Número da Peça",
          is_mandatory: false,
          input_type: "3",
        },
      ],
      PRODUTO_BASE,
    );
    expect(
      attributeList[0].attribute_value_list[0].original_value_name,
    ).toBe("51234567");
  });
});

describe("Model (101639) — exactEnumOnly, o risco de publicar dado errado", () => {
  it("NÃO emite quando o enum é linha de produto (MAX/PREMIUM/TOR)", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 101639,
          attribute_name: "Model",
          is_mandatory: false,
          input_type: "5",
          attribute_value_list: [
            { value_id: 1, value_name: "MAX" },
            { value_id: 2, value_name: "PREMIUM" },
            { value_id: 3, value_name: "TOR" },
            { value_id: 4, value_name: "Bandeja" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList).toHaveLength(0);
    expect(report.unmapped[0].reason).toBe("model_attr_exact_only");
  });

  it("emite quando a categoria realmente publica o modelo do veículo", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 101639,
          attribute_name: "Model",
          is_mandatory: false,
          input_type: "5",
          attribute_value_list: [
            { value_id: 77, value_name: "Argo" },
            { value_id: 78, value_name: "Uno" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 77,
      original_value_name: "Argo",
    });
  });

  it("não casa por substring — a regressão do includes() bidirecional", () => {
    // "argo".includes("a") era true no código legado e publicava "A".
    const { attributeList } = build(
      [
        {
          attribute_id: 101639,
          attribute_name: "Model",
          is_mandatory: false,
          input_type: "5",
          attribute_value_list: [{ value_id: 5, value_name: "A" }],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList).toHaveLength(0);
  });

  it("nem em combo box sem lista publicada manda texto livre", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 101639,
          attribute_name: "Model",
          is_mandatory: false,
          input_type: "5",
          attribute_value_list: [],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList).toHaveLength(0);
  });
});

describe("Car brand (102200) — marca do veículo", () => {
  const schema: ShopeeAttrSchema[] = [
    {
      attribute_id: 102200,
      attribute_name: "Car brand",
      is_mandatory: false,
      input_type: "5",
      attribute_value_list: [
        { value_id: 10, value_name: "Fiat" },
        { value_id: 11, value_name: "Honda" },
      ],
    },
  ];

  it("usa a marca da compatibilidade quando ela é única", () => {
    const { attributeList } = build(schema, {
      ...PRODUTO_BASE,
      brand: "Marca Generica",
      compatibilities: [
        { brand: "Honda", model: "Civic" },
        { brand: "Honda", model: "Fit" },
      ],
    });
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 11,
      original_value_name: "Honda",
    });
  });

  it("com marcas divergentes cai em product.brand", () => {
    const { attributeList } = build(schema, {
      ...PRODUTO_BASE,
      compatibilities: [{ brand: "Honda" }, { brand: "Toyota" }],
    });
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 10,
      original_value_name: "Fiat",
    });
  });
});

describe("Condition / Item condition — derivados de Quality", () => {
  it("SEMINOVO vira Used (en) e Usado (pt), casando no enum", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100413,
          attribute_name: "Condition",
          is_mandatory: false,
          input_type: "2",
          attribute_value_list: [
            { value_id: 1, value_name: "New" },
            { value_id: 2, value_name: "Refurbished" },
            { value_id: 3, value_name: "Used" },
          ],
        },
        {
          attribute_id: 101638,
          attribute_name: "Item condition",
          is_mandatory: false,
          input_type: "5",
          attribute_value_list: [
            { value_id: 9, value_name: "Novo" },
            { value_id: 8, value_name: "Usado" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 3,
      original_value_name: "Used",
    });
    expect(attributeList[1].attribute_value_list[0]).toEqual({
      value_id: 8,
      original_value_name: "Usado",
    });
  });

  it("NOVO vira New", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100413,
          attribute_name: "Condition",
          input_type: "2",
          attribute_value_list: [
            { value_id: 1, value_name: "New" },
            { value_id: 3, value_name: "Used" },
          ],
        },
      ],
      { ...PRODUTO_BASE, quality: "NOVO" },
    );
    expect(attributeList[0].attribute_value_list[0].value_id).toBe(1);
  });

  it("quality nula ou fora do enum cai em Used (conservador)", () => {
    for (const q of [null, "USADO"]) {
      const { attributeList } = build(
        [
          {
            attribute_id: 100413,
            attribute_name: "Condition",
            input_type: "2",
            attribute_value_list: [
              { value_id: 1, value_name: "New" },
              { value_id: 3, value_name: "Used" },
            ],
          },
        ],
        { ...PRODUTO_BASE, quality: q },
      );
      expect(attributeList[0].attribute_value_list[0].value_id).toBe(3);
    }
  });
});

describe("Side / Positions — reuso da inferência do Mercado Livre", () => {
  it('"Farol Dianteiro Esquerdo" resolve Side=Esquerdo e Positions=Dianteira', () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 101674,
          attribute_name: "Side",
          input_type: "5",
          attribute_value_list: [
            { value_id: 20, value_name: "Direito" },
            { value_id: 21, value_name: "Esquerdo" },
          ],
        },
        {
          attribute_id: 101933,
          attribute_name: "Positions",
          input_type: "5",
          attribute_value_list: [
            { value_id: 30, value_name: "Dianteira" },
            { value_id: 31, value_name: "Traseira" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 21,
      original_value_name: "Esquerdo",
    });
    expect(attributeList[1].attribute_value_list[0]).toEqual({
      value_id: 30,
      original_value_name: "Dianteira",
    });
  });

  it("nome ambíguo não emite nada (fail-closed)", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 101674,
          attribute_name: "Side",
          input_type: "5",
          attribute_value_list: [
            { value_id: 20, value_name: "Direito" },
            { value_id: 21, value_name: "Esquerdo" },
          ],
        },
      ],
      { ...PRODUTO_BASE, name: "Farol esquerdo e direito" },
    );
    expect(attributeList).toHaveLength(0);
    expect(report.unmapped[0].reason).toBe("no_source_field");
  });
});

describe("Peso e dimensões", () => {
  it("2.5 kg casa no enum publicado como '2.5 kg' (numeric_unit)", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 100095,
          attribute_name: "Weight",
          input_type: "2",
          attribute_unit: ["g", "kg"],
          attribute_value_list: [
            { value_id: 1, value_name: "1 kg" },
            { value_id: 2, value_name: "2.5 kg" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList[0].attribute_value_list[0].value_id).toBe(2);
    expect(report.entries[0].match).toBe("numeric_unit");
  });

  it("0.35 kg vira 350 g quando a categoria aceita gramas", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100095,
          attribute_name: "Weight",
          input_type: "2",
          attribute_unit: ["g", "kg"],
          attribute_value_list: [],
        },
      ],
      { ...PRODUTO_BASE, weightKg: 0.35 },
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 0,
      original_value_name: "350",
      value_unit: "g",
    });
  });

  it("não emite value_unit fora do attribute_unit da categoria", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 100095,
          attribute_name: "Weight",
          input_type: "2",
          attribute_unit: ["kg"],
          attribute_value_list: [],
        },
      ],
      { ...PRODUTO_BASE, weightKg: 0.35 },
    );
    // 0.35 kg com só "kg" disponível: emite em kg, nunca em g.
    expect(attributeList[0].attribute_value_list[0].value_unit).toBe("kg");
    expect(report.entries[0].emitted).toBe(true);
  });

  it("Dimension (L x W x H) monta o texto a partir das 3 medidas", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100942,
          attribute_name: "Dimension (L x W x H)",
          input_type: "3",
          attribute_value_list: [],
        },
      ],
      PRODUTO_BASE,
    );
    expect(
      attributeList[0].attribute_value_list[0].original_value_name,
    ).toBe("30 x 20 x 15 cm");
  });

  it("dimensão incompleta não emite", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100942,
          attribute_name: "Dimension (L x W x H)",
          input_type: "3",
          attribute_value_list: [],
        },
      ],
      { ...PRODUTO_BASE, widthCm: null },
    );
    expect(attributeList).toHaveLength(0);
  });

  it("Package height casa no enum '15 cm'", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 101648,
          attribute_name: "Package height",
          input_type: "5",
          attribute_value_list: [
            { value_id: 4, value_name: "10 cm" },
            { value_id: 5, value_name: "15 cm" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList[0].attribute_value_list[0].value_id).toBe(5);
  });
});

describe("ficha técnica do operador vence a inferência", () => {
  it("attributes[id] sobrescreve o campo derivado do produto", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 102293,
          attribute_name: "Auto-Part Number",
          is_mandatory: true,
          input_type: "3",
          attribute_value_list: [],
        },
      ],
      {
        ...PRODUTO_BASE,
        attributes: { "102293": { value_name: "OPERADOR-999" } },
      },
    );
    expect(
      attributeList[0].attribute_value_list[0].original_value_name,
    ).toBe("OPERADOR-999");
    expect(report.entries[0].strategy).toBe("operator_attributes");
  });

  it("aceita a chave por nome normalizado e valor como string crua", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100134,
          attribute_name: "Material",
          input_type: "5",
          attribute_value_list: [
            { value_id: 60, value_name: "Plastic" },
            { value_id: 61, value_name: "Steel" },
          ],
        },
      ],
      { ...PRODUTO_BASE, attributes: { material: "Steel" } },
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 61,
      original_value_name: "Steel",
    });
  });

  it("preenche atributo que o dicionário não conhece, se o operador informou", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100773,
          attribute_name: "Lighting Type",
          input_type: "2",
          attribute_value_list: [],
        },
      ],
      { ...PRODUTO_BASE, attributes: { "100773": { value_name: "Halogênio" } } },
    );
    expect(
      attributeList[0].attribute_value_list[0].original_value_name,
    ).toBe("Halogênio");
  });
});

describe("escada por tipo de campo", () => {
  it("drop-down opcional sem match não emite (não inventa valor)", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 101219,
          attribute_name: "Custom Product",
          is_mandatory: false,
          input_type: "1",
          attribute_value_list: [
            { value_id: 1, value_name: "Yes" },
            { value_id: 2, value_name: "No" },
          ],
        },
      ],
      { ...PRODUTO_BASE, attributes: { "101219": "Talvez" } },
    );
    expect(attributeList).toHaveLength(0);
    expect(report.unmapped[0].reason).toBe("closed_list_no_match");
  });

  it("drop-down OBRIGATÓRIO sem match usa valor neutro e reporta o fallback", () => {
    const { attributeList, report } = build(
      [
        {
          attribute_id: 102292,
          attribute_name: "Inmetro Certification",
          is_mandatory: true,
          input_type: "2",
          attribute_value_list: [
            { value_id: 70, value_name: "N/A – NBR not applicable" },
          ],
        },
      ],
      PRODUTO_BASE,
    );
    expect(attributeList[0].attribute_value_list[0].value_id).toBe(70);
    expect(report.fallbacks[0].reason).toBe("mandatory_dropdown_neutral");
  });

  it("combo box com lista publicada aceita valor novo do operador", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 100134,
          attribute_name: "Material",
          input_type: "5",
          attribute_value_list: [{ value_id: 60, value_name: "Plastic" }],
        },
      ],
      { ...PRODUTO_BASE, attributes: { "100134": "Fibra de carbono" } },
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 0,
      original_value_name: "Fibra de carbono",
    });
  });

  it("match exato ignora acento e caixa", () => {
    const { attributeList } = build(
      [
        {
          attribute_id: 101652,
          attribute_name: "Origin",
          input_type: "5",
          attribute_value_list: [{ value_id: 40, value_name: "Brasil" }],
        },
      ],
      { ...PRODUTO_BASE, attributes: { "101652": "brasil" } },
    );
    expect(attributeList[0].attribute_value_list[0]).toEqual({
      value_id: 40,
      original_value_name: "Brasil",
    });
  });
});

describe("relatório de cobertura", () => {
  it("mede a categoria 102298 real (12 atributos) e reporta os não mapeados", () => {
    // Recorte fiel do schema em cache de produção.
    const c102298: ShopeeAttrSchema[] = [
      { attribute_id: 102293, attribute_name: "Auto-Part Number", is_mandatory: true, input_type: "3", attribute_value_list: [] },
      { attribute_id: 100095, attribute_name: "Weight", input_type: "2", attribute_unit: ["g", "kg"], attribute_value_list: [] },
      { attribute_id: 100773, attribute_name: "Lighting Type", input_type: "2", attribute_value_list: [] },
      { attribute_id: 100853, attribute_name: "Bulb Type", input_type: "2", attribute_value_list: [] },
      { attribute_id: 100857, attribute_name: "Bulb Socket Type", input_type: "5", attribute_value_list: [] },
      { attribute_id: 100906, attribute_name: "Light Function", input_type: "2", attribute_value_list: [] },
      { attribute_id: 100942, attribute_name: "Dimension (L x W x H)", input_type: "3", attribute_value_list: [] },
      { attribute_id: 101638, attribute_name: "Item condition", input_type: "5", attribute_value_list: [{ value_id: 9, value_name: "Novo" }] },
      { attribute_id: 101645, attribute_name: "Shipping packaging", input_type: "5", attribute_value_list: [{ value_id: 1, value_name: "Flyer" }] },
      { attribute_id: 101646, attribute_name: "Product features", input_type: "5", attribute_value_list: [{ value_id: 2, value_name: "Sem validade" }] },
      { attribute_id: 101677, attribute_name: "Lamp type", input_type: "5", attribute_value_list: [{ value_id: 3, value_name: "Halogênio" }] },
      { attribute_id: 102292, attribute_name: "Inmetro Certification", input_type: "2", attribute_value_list: [{ value_id: 4, value_name: "N/A – NBR not applicable" }] },
    ];

    const { attributeList, report } = build(c102298, PRODUTO_BASE);

    // Baseline medido em produção era 1/12 (só Auto-Part Number).
    expect(report.categoryAttrCount).toBe(12);
    expect(report.emittedCount).toBeGreaterThanOrEqual(4);
    expect(attributeList.length).toBe(report.emittedCount);
    expect(report.coverage).toBeGreaterThan(0.3);
    // Nenhum obrigatório ficou de fora e nenhum valor saiu vazio.
    expect(report.hasUnfilledMandatory).toBe(false);
    for (const a of attributeList) {
      expect(a.attribute_value_list[0].original_value_name).toBeTruthy();
    }
    // Os que não têm fonte real ficam explicitamente reportados.
    const nomesNaoMapeados = report.unmapped.map((e) => e.attributeName);
    expect(nomesNaoMapeados).toContain("Bulb Type");
  });

  it("unmapped e fallbacks são subconjuntos consistentes de entries", () => {
    const { report } = build(
      [
        { attribute_id: 102293, attribute_name: "Auto-Part Number", is_mandatory: true, input_type: "3", attribute_value_list: [] },
        { attribute_id: 100853, attribute_name: "Bulb Type", input_type: "2", attribute_value_list: [] },
      ],
      PRODUTO_BASE,
    );
    expect(report.entries).toHaveLength(2);
    for (const e of [...report.unmapped, ...report.fallbacks]) {
      expect(report.entries).toContain(e);
    }
    expect(report.unmapped.every((e) => !e.emitted)).toBe(true);
  });

  it("categoria sem atributos devolve lista vazia e cobertura 0", () => {
    const { attributeList, report } = build([], PRODUTO_BASE);
    expect(attributeList).toEqual([]);
    expect(report.coverage).toBe(0);
    expect(report.hasUnfilledMandatory).toBe(false);
  });
});

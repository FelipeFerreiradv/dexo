import { describe, it, expect } from "vitest";
import {
  gtinCheckDigitOk,
  packagePlausibilityWarnings,
  summarizeValueBlocks,
  validateMLAttributeValues,
  type CatalogAttributeLite,
  type PayloadAttribute,
} from "../app/marketplaces/lib/ml-attribute-value-validation.logic";
import { normalizeMLCategoryAttribute } from "../app/marketplaces/services/ml-attribute-catalog.service";

/**
 * Validação dos VALORES da ficha técnica × catálogo da categoria (PR-3).
 * Cada caso de bloqueio reproduz uma recusa real do ML nos logs de produção
 * de 16-22/09/2026 (código entre parênteses).
 */

const VEHICLE_TYPE_FIXO: CatalogAttributeLite = {
  id: "VEHICLE_TYPE",
  name: "Tipo de veículo",
  valueType: "list",
  fixedTag: true,
  allowedValues: [{ id: "11377043", name: "Carro/Caminhonete" }],
};
const SIDE_POSITION: CatalogAttributeLite = {
  id: "SIDE_POSITION",
  name: "Lado",
  valueType: "list",
  allowedValues: [
    { id: "42758041", name: "Direito/Passageiro" },
    { id: "42758042", name: "Esquerdo/Motorista" },
  ],
};
const COR: CatalogAttributeLite = {
  id: "COLOR",
  name: "Cor",
  valueType: "list",
  allowedValues: [
    { id: "52049", name: "Preto" },
    { id: "52055", name: "Branco" },
  ],
};
const MARCA_STRING: CatalogAttributeLite = {
  id: "BRAND",
  name: "Marca",
  valueType: "string",
  allowedValues: [{ id: "9344", name: "Bosch" }],
};
const QR: CatalogAttributeLite = {
  id: "REGULATORY_INFORMATION_QR_CODE",
  name: "QR code de informação regulatória",
  valueType: "picture_id",
};
const ANGULO: CatalogAttributeLite = {
  id: "MAXIMUM_OPENING_ANGLE",
  name: "Ângulo máximo de abertura",
  valueType: "number_unit",
  allowedUnits: ["°"],
  defaultUnit: "°",
};
const LARGURA: CatalogAttributeLite = {
  id: "WIDTH",
  name: "Largura",
  valueType: "number_unit",
  allowedUnits: ["mm", "cm", "m", '"'],
  defaultUnit: "cm",
};
const LARGURA_CACHE_ANTIGO: CatalogAttributeLite = {
  id: "WIDTH",
  name: "Largura",
  valueType: "number_unit",
};
const GTIN: CatalogAttributeLite = {
  id: "GTIN",
  name: "Código universal de produto",
  valueType: "string",
};
const OEM_MULTI: CatalogAttributeLite = {
  id: "OEM",
  name: "Código OEM",
  valueType: "string",
  multivaluedTag: true,
};
const OEM_UNICO: CatalogAttributeLite = { ...OEM_MULTI, multivaluedTag: false };
const OEM_CACHE_ANTIGO: CatalogAttributeLite = {
  id: "OEM",
  name: "Código OEM",
  valueType: "string",
};

const valida = (attrs: PayloadAttribute[], cat: CatalogAttributeLite[]) =>
  validateMLAttributeValues(attrs, cat);

describe("fail-open (sem metadado não mexe em nada)", () => {
  it("sem catálogo: devolve a MESMA lista, sem issue", () => {
    const attrs = [{ id: "GTIN", value_name: "abc" }];
    for (const cat of [undefined, null, []] as any[]) {
      const r = validateMLAttributeValues(attrs, cat);
      expect(r.attributes).toBe(attrs);
      expect(r.issues).toEqual([]);
      expect(r.blocked).toBe(false);
    }
  });

  it("nada a corrigir: mesmos objetos, na mesma ordem (payload idêntico ao de antes)", () => {
    const attrs = [
      { id: "BRAND", value_name: "Bosch" },
      { id: "VEHICLE_TYPE", value_id: "11377043", value_name: "Carro/Caminhonete" },
      { id: "WIDTH", value_name: "30 cm" },
      { id: "SEM_CATALOGO", value_name: "x" },
    ];
    const r = valida(attrs, [MARCA_STRING, VEHICLE_TYPE_FIXO, LARGURA]);
    expect(r.issues).toEqual([]);
    expect(r.attributes).toHaveLength(attrs.length);
    r.attributes.forEach((a, i) => expect(a).toBe(attrs[i]));
  });

  it("atributo fora do catálogo da categoria passa intacto", () => {
    const attrs = [{ id: "GTIN", value_name: "polopositivo" }];
    const r = valida(attrs, [MARCA_STRING]);
    expect(r.blocked).toBe(false);
    expect(r.attributes[0]).toBe(attrs[0]);
  });

  it("montados pela Dexo (SELLER_PACKAGE_*, SELLER_SKU) ficam fora das regras", () => {
    const pacote: CatalogAttributeLite = {
      id: "SELLER_PACKAGE_WIDTH",
      valueType: "number_unit",
      allowedUnits: ["cm"],
    };
    const r = valida([{ id: "SELLER_PACKAGE_WIDTH", value_name: "30" }], [pacote]);
    expect(r.issues).toEqual([]);
  });

});

describe("atributo read_only (o ML ignora o valor na criação, mas confere o formato)", () => {
  // Caso real (Xaxim, 22/09): GTIN hidden+read_only com "906062426R" levou
  // 7711; "Comprimento da embalagem" levou 3708 na mesma resposta do 303.
  const GTIN_SO_LEITURA: CatalogAttributeLite = { ...GTIN, readOnlyTag: true };
  const PACOTE_SO_LEITURA: CatalogAttributeLite = {
    id: "PACKAGE_LENGTH",
    name: "Comprimento da embalagem",
    valueType: "number_unit",
    allowedUnits: ["cm"],
    readOnlyTag: true,
  };

  it("valor inválido é RETIRADO do payload, sem bloquear (a pessoa não vê o campo)", () => {
    const outro = { id: "BRAND", value_name: "Bosch" };
    const r = valida(
      [{ id: "GTIN", value_name: "906062426R" }, { id: "PACKAGE_LENGTH", value_name: "30" }, outro],
      [GTIN_SO_LEITURA, PACOTE_SO_LEITURA, MARCA_STRING],
    );
    expect(r.blocked).toBe(false);
    expect(r.attributes.map((a) => a.id)).toEqual(["BRAND"]);
    expect(r.attributes[0]).toBe(outro);
    expect(r.issues.map((i) => [i.code, i.severity, i.attributeId])).toEqual([
      ["READ_ONLY_INVALID_DROPPED", "fix", "GTIN"],
      ["READ_ONLY_INVALID_DROPPED", "fix", "PACKAGE_LENGTH"],
    ]);
  });

  it("valor válido em read_only passa intacto (payload de hoje)", () => {
    const attrs = [
      { id: "GTIN", value_name: "7891234567895" },
      { id: "PACKAGE_LENGTH", value_name: "30 cm" },
    ];
    const r = valida(attrs, [GTIN_SO_LEITURA, PACOTE_SO_LEITURA]);
    expect(r.issues).toEqual([]);
    r.attributes.forEach((a, i) => expect(a).toBe(attrs[i]));
  });
});

describe("valor FIXO da categoria (3510 VEHICLE_TYPE, 184 recusas)", () => {
  it("valor diferente vira o único que a categoria aceita", () => {
    const r = valida(
      [{ id: "VEHICLE_TYPE", value_id: "13222040", value_name: "Linha Pesada" }],
      [VEHICLE_TYPE_FIXO],
    );
    expect(r.blocked).toBe(false);
    expect(r.attributes[0]).toEqual({
      id: "VEHICLE_TYPE",
      value_id: "11377043",
      value_name: "Carro/Caminhonete",
    });
    expect(r.issues[0]).toMatchObject({ severity: "fix", code: "FIXED_VALUE_NORMALIZED" });
  });

  it("mesmo nome sem id é aceito como está", () => {
    const attrs = [{ id: "VEHICLE_TYPE", value_name: "carro/caminhonete" }];
    const r = valida(attrs, [VEHICLE_TYPE_FIXO]);
    expect(r.issues).toEqual([]);
    expect(r.attributes[0]).toBe(attrs[0]);
  });

  it("fixo com mais de um valor permitido não é tratado como fixo único", () => {
    const doisValores = {
      ...VEHICLE_TYPE_FIXO,
      valueType: "string",
      allowedValues: [
        { id: "1", name: "A" },
        { id: "2", name: "B" },
      ],
    };
    const attrs = [{ id: "VEHICLE_TYPE", value_id: "9", value_name: "Z" }];
    const r = valida(attrs, [doisValores]);
    expect(r.issues).toEqual([]);
  });
});

describe("lista fechada com id de outra categoria (3510 SIDE_POSITION)", () => {
  it("nome idêntico a um valor permitido ⇒ troca só o id", () => {
    const r = valida(
      [{ id: "COLOR", value_id: "999", value_name: "Preto" }],
      [COR],
    );
    expect(r.blocked).toBe(false);
    expect(r.attributes[0]).toEqual({ id: "COLOR", value_id: "52049", value_name: "Preto" });
    expect(r.issues[0].code).toBe("LIST_ID_REMAPPED");
  });

  it("nome que não existe na categoria ⇒ bloqueia e lista as opções (caso real 364128 'Esquerdo')", () => {
    const r = valida(
      [{ id: "SIDE_POSITION", value_id: "364128", value_name: "Esquerdo" }],
      [SIDE_POSITION],
    );
    expect(r.blocked).toBe(true);
    expect(r.issues[0]).toMatchObject({
      code: "LIST_VALUE_NOT_IN_CATEGORY",
      attributeName: "Lado",
    });
    expect(r.issues[0].message).toMatch(/"Esquerdo".*Lado.*Esquerdo\/Motorista/);
  });

  it("id que pertence à categoria passa intacto", () => {
    const attrs = [{ id: "SIDE_POSITION", value_id: "42758042", value_name: "Esquerdo/Motorista" }];
    const r = valida(attrs, [SIDE_POSITION]);
    expect(r.issues).toEqual([]);
    expect(r.attributes[0]).toBe(attrs[0]);
  });

  it("string com valores SUGERIDOS (não é lista fechada) nunca bloqueia", () => {
    const r = valida([{ id: "BRAND", value_id: "123", value_name: "Genérica" }], [MARCA_STRING]);
    expect(r.issues).toEqual([]);
  });
});

describe("atributo do tipo imagem (422 REGULATORY_INFORMATION_QR_CODE='1')", () => {
  it("texto no campo de imagem ⇒ bloqueia pedindo para apagar", () => {
    const r = valida([{ id: QR.id, value_name: "1" }], [QR]);
    expect(r.blocked).toBe(true);
    expect(r.issues[0].code).toBe("PICTURE_ATTRIBUTE_WITH_TEXT");
    expect(r.issues[0].message).toMatch(/QR code.*"1".*Apague/);
  });

  it("vazio não bloqueia", () => {
    expect(valida([{ id: QR.id, value_name: "  " }], [QR]).blocked).toBe(false);
  });
});

describe("número sem unidade (3708 — também em campo OPCIONAL)", () => {
  it("'1' em Ângulo máximo de abertura ⇒ bloqueia com exemplo de unidade", () => {
    const r = valida([{ id: ANGULO.id, value_name: "1" }], [ANGULO]);
    expect(r.blocked).toBe(true);
    expect(r.issues[0]).toMatchObject({ code: "NUMBER_WITHOUT_UNIT", severity: "block" });
    expect(r.issues[0].message).toMatch(/Ângulo máximo de abertura.*"10 °".*"1"/);
  });

  it("unidade que a categoria não aceita ⇒ bloqueia", () => {
    expect(valida([{ id: "WIDTH", value_name: "30 kg" }], [LARGURA]).blocked).toBe(true);
  });

  it("com unidade válida passa (sem espaço, caixa diferente, polegada)", () => {
    for (const v of ["30 cm", "30cm", "30 CM", "2.5 m", '12 "']) {
      const r = valida([{ id: "WIDTH", value_name: v }], [LARGURA]);
      expect(r.blocked, v).toBe(false);
    }
  });

  it("vírgula decimal vira ponto (mesmo número)", () => {
    const r = valida([{ id: "WIDTH", value_name: "10,5 cm" }], [LARGURA]);
    expect(r.blocked).toBe(false);
    expect(r.attributes[0].value_name).toBe("10.5 cm");
    expect(r.issues[0].code).toBe("NUMBER_DECIMAL_COMMA");
  });

  it("cache antigo sem as unidades aceitas ⇒ regra não roda", () => {
    expect(valida([{ id: "WIDTH", value_name: "30" }], [LARGURA_CACHE_ANTIGO]).issues).toEqual([]);
  });

  it("valor escolhido de lista (value_id) não é reavaliado", () => {
    expect(valida([{ id: "WIDTH", value_id: "123", value_name: "30" }], [LARGURA]).issues).toEqual([]);
  });
});

describe("GTIN (7711 / 7712)", () => {
  it.each(["2033029", "9813203880", "polopositivobateriapeugeot307", "754243m6a"])(
    "'%s' ⇒ bloqueia e aponta o campo Número da Peça",
    (v) => {
      const r = valida([{ id: "GTIN", value_name: v }], [GTIN]);
      expect(r.blocked).toBe(true);
      expect(r.issues[0].code).toBe("GTIN_INVALID_FORMAT");
      expect(r.issues[0].message).toMatch(/Número da Peça/);
    },
  );

  it.each(["12345670", "123456789012", "7891234567895", "17891234567892"])(
    "'%s' (8/12/13/14 dígitos) passa",
    (v) => {
      expect(valida([{ id: "GTIN", value_name: v }], [GTIN]).blocked).toBe(false);
    },
  );

  it.each(["24434865", "94705894"])(
    "'%s' (8 dígitos, verificador errado — recusado pelo ML na Xaxim) ⇒ bloqueia",
    (v) => {
      const r = valida([{ id: "GTIN", value_name: v }], [GTIN]);
      expect(r.blocked).toBe(true);
      expect(r.issues[0].message).toMatch(/dígito verificador/);
    },
  );

  it("gtinCheckDigitOk: GS1 para 8/12/13/14 dígitos", () => {
    expect(gtinCheckDigitOk("12345670")).toBe(true);
    expect(gtinCheckDigitOk("12345671")).toBe(false);
    expect(gtinCheckDigitOk("7891234567895")).toBe(true);
    expect(gtinCheckDigitOk("7891234567891")).toBe(false);
    expect(gtinCheckDigitOk("abc")).toBe(false);
  });

  it("em lista: um valor inválido basta para bloquear", () => {
    const r = valida(
      [{ id: "GTIN", values: [{ name: "7891234567895" }, { name: "abc" }] }],
      [GTIN],
    );
    expect(r.blocked).toBe(true);
  });
});

describe("OEM (402 repetido / 395 valor único)", () => {
  const oem = (...nomes: string[]) => [{ id: "OEM", values: nomes.map((name) => ({ name })) }];

  it.each([
    ["pé", "pe"],
    ["t-cross", "tcross"],
    ["porta-luvas", "portaluvas"],
    ["pára-lama", "paralama"],
  ])("'%s, %s' ⇒ bloqueia (o ML ignora acento e hífen)", (a, b) => {
    const r = valida(oem("5U0121049", a, b), [OEM_MULTI]);
    expect(r.blocked).toBe(true);
    expect(r.issues[0].code).toBe("OEM_DUPLICATE_VALUES");
    expect(r.issues[0].message).toContain(`"${a}, ${b}"`);
  });

  it("caixa diferente NÃO é repetição (código pode ser case-significativo)", () => {
    expect(valida(oem("AB123", "ab123"), [OEM_MULTI]).blocked).toBe(false);
  });

  it("categoria que aceita UM código só e o produto tem 2 ⇒ bloqueia", () => {
    const r = valida(oem("AB1", "CD2"), [OEM_UNICO]);
    expect(r.blocked).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("OEM_SINGLE_VALUE_ONLY");
  });

  it("cache antigo (multivalued desconhecido) não bloqueia por quantidade", () => {
    expect(valida(oem("AB1", "CD2"), [OEM_CACHE_ANTIGO]).blocked).toBe(false);
  });

  it("OEM singular (um código) nunca é afetado", () => {
    const attrs = [{ id: "OEM", value_name: "pé" }];
    const r = valida(attrs, [OEM_UNICO]);
    expect(r.issues).toEqual([]);
    expect(r.attributes[0]).toBe(attrs[0]);
  });
});

describe("mensagem e catálogo", () => {
  it("summarizeValueBlocks: nenhum ⇒ null; um ⇒ a mensagem; vários ⇒ contagem", () => {
    expect(summarizeValueBlocks([])).toBeNull();
    const r1 = valida([{ id: QR.id, value_name: "1" }], [QR]);
    expect(summarizeValueBlocks(r1.issues)).toMatch(/^O campo "QR code.*retomada\.$/);
    const r2 = valida(
      [
        { id: QR.id, value_name: "1" },
        { id: "GTIN", value_name: "abc" },
      ],
      [QR, GTIN],
    );
    expect(summarizeValueBlocks(r2.issues)).toMatch(/^A ficha técnica tem 2 valores/);
  });

  it("correção (fix) sozinha não gera mensagem de bloqueio", () => {
    const r = valida([{ id: "WIDTH", value_name: "10,5 cm" }], [LARGURA]);
    expect(summarizeValueBlocks(r.issues)).toBeNull();
  });

  it("normalize() do catálogo expõe unidades, multivalued e read_only do JSON cru do ML", () => {
    const n = normalizeMLCategoryAttribute({
      id: "WIDTH",
      name: "Largura",
      value_type: "number_unit",
      tags: { read_only: true, multivalued: true },
      allowed_units: [{ id: "cm", name: "cm" }, { id: '"', name: '"' }],
      default_unit: "cm",
    } as any);
    expect(n).toMatchObject({
      allowedUnits: ["cm", '"'],
      defaultUnit: "cm",
      multivaluedTag: true,
      readOnlyTag: true,
    });
    const semNada = normalizeMLCategoryAttribute({ id: "X", value_type: "string" } as any);
    expect(semNada.allowedUnits).toBeUndefined();
    expect(semNada.defaultUnit).toBeUndefined();
    expect(semNada.multivaluedTag).toBe(false);
  });
});

describe("medidas do pacote implausíveis (5401) — só aviso", () => {
  it("lado > 200 cm e peso > 70 kg geram aviso; medidas normais não", () => {
    expect(
      packagePlausibilityWarnings({ heightCm: 904, widthCm: 20, lengthCm: 30, weightKg: 116 }),
    ).toEqual(["altura 904 cm > 200 cm", "peso 116 kg > 70 kg"]);
    expect(
      packagePlausibilityWarnings({ heightCm: 20, widthCm: 20, lengthCm: 40, weightKg: "1.5" }),
    ).toEqual([]);
    expect(packagePlausibilityWarnings({})).toEqual([]);
  });
});

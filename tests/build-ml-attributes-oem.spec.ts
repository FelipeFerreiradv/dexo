import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Stub do prisma client para evitar conexão real ao DB durante import.
vi.mock("@/app/lib/prisma", () => ({
  default: {},
}));

import { ListingUseCase as ListingUseCaseClass } from "../app/marketplaces/usecases/listing.usercase";

// Helpers privados acessados via cast — padrão de build-ml-attributes-position.spec.ts.
const ListingUseCase: any = ListingUseCaseClass;

// Categoria de autopeça. Levantado na API real: as 38 categorias de autopeça
// verificadas expõem OEM (string, max 255, nunca required/hidden) e
// PART_NUMBER (required). Fora de autopeça, OEM não existe.
const CATEGORIA = "MLB193419";

const attr = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  valueType: "string",
  required: false,
  variationRequired: false,
  ...extra,
});

const COM_OEM = [
  attr("PART_NUMBER", { required: true }),
  attr("OEM"),
  attr("MPN", { hidden: true }),
  attr("MATERIAL"),
];

const SEM_OEM = [
  attr("PART_NUMBER", { required: true }),
  attr("MPN", { hidden: true }),
  attr("MATERIAL"),
];

const baseProduct = {
  sku: "SKU-OEM",
  name: "Cubo de roda dianteiro Gol",
  brand: "Volkswagen",
  model: "Gol",
  year: "2014",
  partNumber: "PN-INTERNO",
};

const byId = (out: any[]) =>
  new Map<string, any>(out.map((a: any) => [a.id, a]));
const oemOf = (out: any[]) => out.filter((a: any) => a.id === "OEM");

afterEach(() => {
  delete process.env.ML_OEM_ATTR_DISABLED;
});

describe("buildMLAttributes — código OEM", () => {
  it("categoria que expõe OEM: o valor do operador entra no payload", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    const oem = oemOf(out);
    expect(oem).toHaveLength(1);
    expect(oem[0].value_name).toBe("5U0121049");
    // Sem value_id: OEM é texto livre, nunca lista fechada.
    expect(oem[0].value_id).toBeUndefined();
  });

  it("categoria que NÃO expõe OEM: o atributo é removido do payload", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, SEM_OEM);
    expect(oemOf(out)).toHaveLength(0);
  });

  it("remover o OEM não leva junto nenhum outro atributo", () => {
    const product = {
      ...baseProduct,
      attributes: {
        OEM: { value_name: "5U0121049" },
        MATERIAL: { value_name: "Aço" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, SEM_OEM);
    const m = byId(out);
    expect(m.has("OEM")).toBe(false);
    expect(m.get("MATERIAL")?.value_name).toBe("Aço");
    expect(m.get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
    expect(m.get("SELLER_SKU")?.value_name).toBe("SKU-OEM");
    expect(m.get("BRAND")?.value_name).toBe("Volkswagen");
  });

  it("SEM categoryAttrs (fallback legado): payload inalterado, nada é removido", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA);
    // A guarda não age no escuro: o merge já mandava o OEM e continua mandando.
    expect(oemOf(out)).toHaveLength(1);
    expect(oemOf(out)[0].value_name).toBe("5U0121049");
  });

  it("categoryAttrs vazio também conta como ausente (não remove nada)", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, []);
    expect(oemOf(out)).toHaveLength(1);
  });

  it("KILL-SWITCH: ML_OEM_ATTR_DISABLED=1 restaura o pass-through", () => {
    process.env.ML_OEM_ATTR_DISABLED = "1";
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, SEM_OEM);
    expect(oemOf(out)).toHaveLength(1);
    expect(oemOf(out)[0].value_name).toBe("5U0121049");
  });

  it("OEM vazio: payload idêntico ao de um produto sem o campo", () => {
    const comVazio = ListingUseCase.buildMLAttributes(
      { ...baseProduct, attributes: { OEM: { value_name: "   " } } },
      CATEGORIA,
      COM_OEM,
    );
    const semCampo = ListingUseCase.buildMLAttributes(
      { ...baseProduct },
      CATEGORIA,
      COM_OEM,
    );
    expect(comVazio).toEqual(semCampo);
    expect(oemOf(comVazio)).toHaveLength(0);
  });

  it("produto sem OEM nenhum: mesma saída com e sem a guarda", () => {
    const semGuarda = (() => {
      process.env.ML_OEM_ATTR_DISABLED = "1";
      const r = ListingUseCase.buildMLAttributes(
        { ...baseProduct },
        CATEGORIA,
        SEM_OEM,
      );
      delete process.env.ML_OEM_ATTR_DISABLED;
      return r;
    })();
    const comGuarda = ListingUseCase.buildMLAttributes(
      { ...baseProduct },
      CATEGORIA,
      SEM_OEM,
    );
    expect(comGuarda).toEqual(semGuarda);
  });
});

describe("buildMLAttributes — PART_NUMBER não muda de fonte", () => {
  it("PART_NUMBER continua vindo de product.partNumber, não do OEM", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "OEM-999" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    expect(byId(out).get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
  });

  it("sem partNumber, o OEM NÃO preenche PART_NUMBER", () => {
    const product = {
      ...baseProduct,
      partNumber: undefined,
      attributes: { OEM: { value_name: "OEM-999" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    expect(byId(out).has("PART_NUMBER")).toBe(false);
    expect(oemOf(out)[0].value_name).toBe("OEM-999");
  });

  it("OEM não sobrescreve PART_NUMBER nem quando informado sob esse id", () => {
    const product = {
      ...baseProduct,
      attributes: {
        PART_NUMBER: { value_name: "TENTATIVA" },
        OEM: { value_name: "OEM-999" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    expect(byId(out).get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
  });
});

// A Revisão individual do anúncio em massa não grava em Product: o mapa da
// ficha vai como override por produto. O update pós-criação descarta `OEM`
// (IMMUTABLE_ATTRS), então o create é o único caminho possível para ele.
describe("withOemFromOverride — OEM da Revisão individual", () => {
  const chamar = (product: any, override: any) =>
    ListingUseCase.withOemFromOverride(product, override);

  it("traz o OEM do override quando o produto não tem nenhum", () => {
    const out = chamar({ ...baseProduct, attributes: {} }, {
      OEM: { value_name: "5U0121049" },
    });
    expect((out.attributes as any).OEM.value_name).toBe("5U0121049");
  });

  it("chega ao payload do ML pelo buildMLAttributes", () => {
    const efetivo = chamar({ ...baseProduct }, { OEM: { value_name: "OEM-77" } });
    const out = ListingUseCase.buildMLAttributes(efetivo, CATEGORIA, COM_OEM);
    expect(oemOf(out)[0].value_name).toBe("OEM-77");
  });

  it("o produto VENCE: override não sobrescreve OEM já cadastrado", () => {
    const out = chamar(
      { ...baseProduct, attributes: { OEM: { value_name: "DO-PRODUTO" } } },
      { OEM: { value_name: "DO-OVERRIDE" } },
    );
    expect((out.attributes as any).OEM.value_name).toBe("DO-PRODUTO");
  });

  it("OEM em branco no produto não bloqueia o override", () => {
    const out = chamar(
      { ...baseProduct, attributes: { OEM: { value_name: "   " } } },
      { OEM: { value_name: "DO-OVERRIDE" } },
    );
    expect((out.attributes as any).OEM.value_name).toBe("DO-OVERRIDE");
  });

  it("IGNORA todo o resto do override — só o OEM entra no create", () => {
    const produto = { ...baseProduct, attributes: { POSITION: { value_name: "Dianteira" } } };
    const out = chamar(produto, {
      OEM: { value_name: "OEM-77" },
      MATERIAL: { value_name: "NAO-DEVE-ENTRAR" },
      POSITION: { value_name: "NAO-DEVE-SOBRESCREVER" },
    });
    const attrs = out.attributes as any;
    expect(attrs.OEM.value_name).toBe("OEM-77");
    expect(attrs.MATERIAL).toBeUndefined();
    expect(attrs.POSITION.value_name).toBe("Dianteira");
  });

  it("MESMO objeto (byte-idêntico) quando não há nada a fazer", () => {
    const produto = { ...baseProduct, attributes: { POSITION: {} } };
    expect(chamar(produto, undefined)).toBe(produto);
    expect(chamar(produto, null)).toBe(produto);
    expect(chamar(produto, {})).toBe(produto);
    expect(chamar(produto, { MATERIAL: { value_name: "X" } })).toBe(produto);
    expect(chamar(produto, { OEM: { value_name: "  " } })).toBe(produto);
    expect(chamar(produto, { OEM: null })).toBe(produto);
  });

  it("override em formato inválido não derruba nem altera nada", () => {
    const produto = { ...baseProduct };
    expect(chamar(produto, [] as any)).toBe(produto);
    expect(chamar(produto, { OEM: "texto-cru" } as any)).toBe(produto);
  });
});

describe("buildMLAttributes — não regride o que já existia", () => {
  it("os atributos fixos seguem intactos com OEM presente", () => {
    const product = {
      ...baseProduct,
      attributes: { OEM: { value_name: "5U0121049" } },
    };
    const out = ListingUseCase.buildMLAttributes(product, CATEGORIA, COM_OEM);
    const m = byId(out);
    expect(m.get("BRAND")?.value_name).toBe("Volkswagen");
    expect(m.get("SELLER_SKU")?.value_name).toBe("SKU-OEM");
    expect(m.get("PART_NUMBER")?.value_name).toBe("PN-INTERNO");
    expect(m.has("MODEL")).toBe(true);
    expect(m.has("YEAR")).toBe(true);
  });

  it("POSITION do operador continua vencendo (spec irmã não regride)", () => {
    const product = {
      ...baseProduct,
      name: "Porta dianteira esquerda Palio",
      attributes: {
        POSITION: { value_id: "VID-DIANT-ESQ", value_name: "Dianteira esquerda" },
        OEM: { value_name: "5U0121049" },
      },
    };
    const out = ListingUseCase.buildMLAttributes(product, "MLB101763", COM_OEM);
    const pos = out.filter((a: any) => a.id === "POSITION");
    expect(pos).toHaveLength(1);
    expect(pos[0].value_id).toBe("VID-DIANT-ESQ");
  });
});

// ─── ML_REQUIRED_ATTRS_BLOCK=1: o que da ficha da revisão entra na criação ───
// Com o bloqueio de obrigatórios ligado, o lado/posição e os obrigatórios
// preenchidos na Revisão individual precisam chegar ao POST — senão o bloqueio
// barra o que o operador preencheu. Só ISSO entra: o resto da ficha continua
// no update pós-criação (cuja falha não derruba o anúncio).
describe("withAttributesFromOverride — ficha da revisão com a flag de obrigatórios", () => {
  const tag = (
    id: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    name: id,
    valueType: "string",
    required: false,
    variationRequired: false,
    hidden: false,
    requiredTag: false,
    catalogRequiredTag: false,
    conditionalRequiredTag: false,
    fixedTag: false,
    ...extra,
  });
  const SIDE = tag("SIDE", {
    valueType: "list",
    allowedValues: [
      { id: "ESQ", name: "Esquerdo" },
      { id: "DIR", name: "Direito" },
    ],
  });
  const CATALOGO = [
    tag("PART_NUMBER", { required: true, requiredTag: true }),
    tag("OEM"),
    tag("MATERIAL"),
    tag("GTIN", { hidden: true }),
    tag("PACKAGE_WEIGHT", { valueType: "number_unit" }),
    tag("VEHICLE_TYPE", { required: true, requiredTag: true, fixedTag: true }),
    tag("HID_REQ", { required: true, requiredTag: true, hidden: true }),
    tag("FUEL_TYPE", { required: true, requiredTag: true }),
    SIDE,
  ];
  const chamar = (product: any, override: any, cat: any = CATALOGO) =>
    ListingUseCase.withAttributesFromOverride(product, override, cat);
  let antesFlag: string | undefined;

  beforeEach(() => {
    antesFlag = process.env.ML_REQUIRED_ATTRS_BLOCK;
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
  });
  afterEach(() => {
    if (antesFlag === undefined) delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    else process.env.ML_REQUIRED_ATTRS_BLOCK = antesFlag;
  });

  it("O2: SIDE do override (value_id permitido) entra", () => {
    const out = chamar({ ...baseProduct }, { SIDE: { value_id: "DIR", value_name: "Direito" } });
    expect((out.attributes as any).SIDE.value_id).toBe("DIR");
  });

  it("O3: id que a categoria não expõe é descartado — e exposto mas opcional também", () => {
    const produto = { ...baseProduct };
    expect(chamar(produto, { NAO_EXPOSTO: { value_name: "x" } })).toBe(produto);
    expect(chamar(produto, { MATERIAL: { value_name: "Aço" } })).toBe(produto);
  });

  it("O4: value_id fora da lista fechada é descartado", () => {
    const produto = { ...baseProduct };
    expect(chamar(produto, { SIDE: { value_id: "XX", value_name: "Central" } })).toBe(produto);
  });

  it("O5: produto que já tem SIDE válido não é sobrescrito", () => {
    const out = chamar(
      { ...baseProduct, attributes: { SIDE: { value_id: "ESQ", value_name: "Esquerdo" } } },
      { SIDE: { value_id: "DIR", value_name: "Direito" } },
    );
    expect((out.attributes as any).SIDE.value_id).toBe("ESQ");
  });

  it("O6: catálogo indisponível → só o OEM, idêntico a withOemFromOverride", () => {
    const produto = { ...baseProduct, attributes: {} };
    const override = {
      OEM: { value_name: "OEM-1" },
      SIDE: { value_id: "DIR" },
      FUEL_TYPE: { value_name: "Diesel" },
    };
    // Chamada direta: o default do helper `chamar` trocaria undefined pelo catálogo.
    const out = ListingUseCase.withAttributesFromOverride(
      produto,
      override,
      undefined,
    );
    expect(out).toEqual(ListingUseCase.withOemFromOverride(produto, override));
    expect((out.attributes as any).SIDE).toBeUndefined();
    const vazio = chamar(produto, override, []);
    expect((vazio.attributes as any).OEM.value_name).toBe("OEM-1");
    expect((vazio.attributes as any).FUEL_TYPE).toBeUndefined();
  });

  it("O7: ML_OEM_ATTR_DISABLED=1 → OEM do override ignorado e SIDE entra", () => {
    process.env.ML_OEM_ATTR_DISABLED = "1";
    const out = chamar(
      { ...baseProduct },
      { OEM: { value_name: "OEM-1" }, SIDE: { value_id: "ESQ" } },
    );
    expect((out.attributes as any).OEM).toBeUndefined();
    expect((out.attributes as any).SIDE.value_id).toBe("ESQ");
  });

  it("O8: sem override (ou override inválido) → mesma referência", () => {
    const produto = { ...baseProduct };
    expect(chamar(produto, undefined)).toBe(produto);
    expect(chamar(produto, null)).toBe(produto);
    expect(chamar(produto, {})).toBe(produto);
    expect(chamar(produto, [] as any)).toBe(produto);
    expect(chamar(produto, { SIDE: { value_name: "  " } })).toBe(produto);
  });

  it("O9: produto com SIDE fora da lista + override permitido → entra o do override e o motor dá ok", async () => {
    const { evaluateMLRequiredAttributes } = await import(
      "../app/marketplaces/lib/ml-required-attributes.logic"
    );
    const sideObrigatorio = { ...SIDE, required: true, requiredTag: true };
    const cat = [sideObrigatorio];
    const produto = {
      ...baseProduct,
      name: "Retrovisor",
      attributes: { SIDE: { value_id: "VELHO", value_name: "Lado velho" } },
    };
    const out = chamar(produto, { SIDE: { value_id: "DIR", value_name: "Direito" } }, cat);
    expect((out.attributes as any).SIDE.value_id).toBe("DIR");
    const attrs = ListingUseCase.buildMLAttributes(out, CATEGORIA, cat);
    expect(
      evaluateMLRequiredAttributes({
        categoryAttributes: cat as any,
        payloadAttributes: attrs,
        catalogListing: false,
      }).status,
    ).toBe("ok");
    // Override também fora da lista: o do produto fica (e o motor bloqueia).
    const out2 = chamar(produto, { SIDE: { value_name: "Central" } }, cat);
    expect(out2).toBe(produto);
  });

  it("D6: ficha de catálogo com GTIN, number_unit, opcional e SIDE → só SIDE, obrigatório e OEM entram", () => {
    const out = chamar(
      { ...baseProduct, attributes: {} },
      {
        GTIN: { value_name: "7891234567890" },
        PACKAGE_WEIGHT: { value_name: "2 kg" },
        MATERIAL: { value_name: "Plástico" },
        VEHICLE_TYPE: { value_name: "Carro" }, // required + fixed: fica de fora
        HID_REQ: { value_name: "x" }, // required + hidden: fica de fora
        FUEL_TYPE: { value_name: "Diesel" }, // required: entra
        OEM: { value_name: "OEM-9" },
        SIDE: { value_id: "ESQ", value_name: "Esquerdo" },
      },
    );
    expect(Object.keys(out.attributes as any).sort()).toEqual([
      "FUEL_TYPE",
      "OEM",
      "SIDE",
    ]);
  });

  it("acceptedAttributeOverrides devolve exatamente o que entrou (para o placeholder)", () => {
    const aceitos = ListingUseCase.acceptedAttributeOverrides(
      { ...baseProduct },
      {
        MATERIAL: { value_name: "Aço" },
        SIDE: { value_id: "DIR" },
      },
      CATALOGO,
    );
    expect(aceitos).toEqual({ SIDE: { value_id: "DIR" } });
    expect(
      ListingUseCase.acceptedAttributeOverrides(
        { ...baseProduct },
        { OEM: { value_name: "OEM-2" }, SIDE: { value_id: "DIR" } },
        undefined,
      ),
    ).toEqual({ OEM: { value_name: "OEM-2" } });
  });
});

describe("buildMLCreateAttributes — flag desligada segue o caminho só-OEM de hoje", () => {
  afterEach(() => {
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    vi.restoreAllMocks();
  });

  it("O1: sem a flag, o create lê só o OEM do override (withAttributesFromOverride não é chamado)", async () => {
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    const { ListingPreflightService } = await import(
      "../app/marketplaces/services/listing-preflight.service"
    );
    vi.spyOn(ListingPreflightService, "checkML").mockImplementation(
      async (input: any) => ({
        ok: true,
        issues: [],
        enrichedAttributes: input.currentAttributes,
        missingRequired: [],
      }),
    );
    const espiao = vi.spyOn(ListingUseCase, "withAttributesFromOverride");
    const cat = [
      { ...attr("OEM"), requiredTag: false, fixedTag: false },
      { ...attr("SIDE"), valueType: "list", allowedValues: [{ id: "DIR", name: "Direito" }] },
    ];
    const built = await ListingUseCase.buildMLCreateAttributes({
      product: { ...baseProduct, attributes: {} },
      resolvedCategoryId: CATEGORIA,
      categoryIdForML: CATEGORIA,
      categoryAttrs: cat,
      attributeOverrides: {
        OEM: { value_name: "OEM-77" },
        SIDE: { value_id: "DIR" },
      },
    });
    expect(espiao).not.toHaveBeenCalled();
    const ids = built.attributes.map((a: any) => a.id);
    expect(ids).toContain("OEM");
    expect(ids).not.toContain("SIDE");
    expect(built.acceptedOverrides).toBeNull();
    expect(built.retryOverrides).toBeNull();
  });
});

describe("attributeOverridesForRetry — o que o placeholder guarda para o cron (D2)", () => {
  afterEach(() => {
    delete process.env.ML_OEM_ATTR_DISABLED;
  });

  const cat = [
    { ...attr("OEM"), requiredTag: false, fixedTag: false },
    {
      ...attr("SIDE"),
      valueType: "list",
      allowedValues: [{ id: "DIR", name: "Direito" }],
      requiredTag: true,
      fixedTag: false,
    },
  ];

  it("com catálogo: exatamente o que entrou na criação", () => {
    const aceitos = { SIDE: { value_id: "DIR" } };
    expect(
      ListingUseCase.attributeOverridesForRetry(
        { SIDE: { value_id: "DIR" }, MATERIAL: { value_name: "Aço" } },
        cat,
        aceitos,
      ),
    ).toBe(aceitos);
  });

  it("sem catálogo: todas as entradas PREENCHIDAS da ficha (a retentativa refiltra)", () => {
    expect(
      ListingUseCase.attributeOverridesForRetry(
        {
          SIDE: { value_id: "DIR" },
          OEM: { value_name: "OEM-1" },
          PART_NUMBER: { value_name: "PN-9" },
          BRANCO: { value_name: "   " },
          LIXO: "texto solto",
          LISTA: [1, 2],
        },
        undefined,
        { OEM: { value_name: "OEM-1" } },
      ),
    ).toEqual({
      SIDE: { value_id: "DIR" },
      OEM: { value_name: "OEM-1" },
      PART_NUMBER: { value_name: "PN-9" },
    });
  });

  it("sem catálogo com ML_OEM_ATTR_DISABLED=1: OEM fica de fora; nada preenchido → null", () => {
    process.env.ML_OEM_ATTR_DISABLED = "1";
    expect(
      ListingUseCase.attributeOverridesForRetry(
        { OEM: { value_name: "OEM-1" }, SIDE: { value_id: "DIR" } },
        [],
        null,
      ),
    ).toEqual({ SIDE: { value_id: "DIR" } });
    expect(
      ListingUseCase.attributeOverridesForRetry({ OEM: { value_name: "x" } }, [], null),
    ).toBeNull();
    expect(ListingUseCase.attributeOverridesForRetry(null, [], null)).toBeNull();
  });
});

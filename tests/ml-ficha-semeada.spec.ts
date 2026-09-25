import { describe, it, expect } from "vitest";
import {
  diffMlFicha,
  sameMlFicha,
  seedMlFicha,
} from "../app/produtos/lib/ml-ficha.logic";
import {
  buildPerProductOverrides,
  configFromDefaults,
  reviewFichaSeeds,
  type PerProductListingConfig,
} from "../app/produtos/components/bulk-review/per-product-types";
import {
  buildMlReviewCheckItems,
  mlRequiredCheckKey,
} from "../app/produtos/components/ml-required-attributes-check.client";
import { withoutClearedAttributes } from "../app/marketplaces/services/listing-overrides.service";
import { buildListingOverridesPayload } from "../app/produtos/components/edit-product-dialog.helpers";

/**
 * Ficha técnica do ML semeada com a do produto (Xaxim, 25/09/2026). A
 * Revisão individual e o "Editar produto" abriam a ficha VAZIA: a tela
 * escondia o INMETRO com texto de busca, a medida "1" e o QR com texto, e o
 * que a pessoa fazia ali não corrigia o que estava gravado.
 */

// Ficha REAL do SKU 3398 (Sensor Medidor Fluxo Ar) antes da limpeza.
const FICHA_3398 = {
  OEM: { value_name: "22680-7S000" },
  VEHICLE_TYPE: { value_id: "11377043", value_name: "Carro/Caminhonete" },
  INLET_CONNECTION_DIAMETER: { value_name: "1" },
  OUTLET_CONNECTION_DIAMETER: { value_name: "1" },
  INMETRO_CERTIFICATION_REGISTRATION_NUMBER: {
    value_name: "sensor maf medidor fluxo ar nissan tiida livina frontier march sentra 2008 2012 2.5 original",
  },
};

describe("seedMlFicha", () => {
  it("copia as entradas com valor; descarta forma estranha e vazio", () => {
    expect(
      seedMlFicha({
        A: { value_name: "x" },
        B: { value_id: "1", value_name: "Um" },
        C: { value_name: "  " },
        familyName: "texto solto",
        D: null,
        E: { value_id: null, value_name: 3 },
      }),
    ).toEqual({ A: { value_name: "x" }, B: { value_id: "1", value_name: "Um" } });
  });

  it("nada gravado ⇒ ficha vazia", () => {
    for (const raw of [null, undefined, [], "x", 1]) expect(seedMlFicha(raw)).toEqual({});
  });
});

describe("diffMlFicha — só o que a pessoa mudou", () => {
  const seed = seedMlFicha(FICHA_3398);

  it("abrir e não mexer ⇒ nada (o envio fica igual ao de antes)", () => {
    expect(diffMlFicha(seed, { ...seed })).toBeUndefined();
  });

  it("corrigir a medida e apagar o INMETRO ⇒ o valor novo + null no apagado", () => {
    const atual = { ...seed };
    atual.INLET_CONNECTION_DIAMETER = { value_name: "10 cm" };
    atual.OUTLET_CONNECTION_DIAMETER = { value_name: "10 cm" };
    delete (atual as Record<string, unknown>).INMETRO_CERTIFICATION_REGISTRATION_NUMBER;
    expect(diffMlFicha(seed, atual)).toEqual({
      INLET_CONNECTION_DIAMETER: { value_name: "10 cm" },
      OUTLET_CONNECTION_DIAMETER: { value_name: "10 cm" },
      INMETRO_CERTIFICATION_REGISTRATION_NUMBER: null,
    });
  });

  it("campo novo (que o produto não tinha) vai como valor, nunca como null", () => {
    expect(diffMlFicha({}, { COLOR: { value_name: "Preto" } })).toEqual({
      COLOR: { value_name: "Preto" },
    });
  });

  it("sem semente (produto sem ficha) ⇒ a ficha inteira, como antes", () => {
    const f = { A: { value_name: "1 cm" } };
    expect(diffMlFicha({}, f)).toEqual(f);
  });
});

describe("sameMlFicha", () => {
  it("ignora a ordem das chaves e entrada vazia", () => {
    expect(
      sameMlFicha(
        { B: { value_name: "2" }, A: { value_name: "1" } },
        { A: { value_name: "1" }, B: { value_name: "2" }, C: { value_name: "" } },
      ),
    ).toBe(true);
    expect(sameMlFicha({ A: { value_name: "1" } }, { A: { value_name: "2" } })).toBe(false);
    expect(sameMlFicha({ A: { value_name: "1" } }, {})).toBe(false);
    expect(sameMlFicha(undefined, {})).toBe(true);
  });
});

describe("Revisão individual: envio e checagem com a ficha semeada", () => {
  const DEFAULTS = {
    autoCategory: false,
    mlListingType: "gold_pro",
    mlItemCondition: "new",
    mlFreeShipping: true,
  } as any;
  const cfgCom = (attributes: Record<string, { value_id?: string; value_name?: string }>) =>
    ({ ...configFromDefaults(DEFAULTS, ["ml-1"], [], [], [], []), attributes }) as PerProductListingConfig;
  const seeds = reviewFichaSeeds([{ id: "p-3398", attributes: FICHA_3398 }]);

  it("sem mexer na ficha semeada ⇒ nenhum atributo vai (igual a hoje)", () => {
    const ppo = buildPerProductOverrides({ "p-3398": cfgCom({ ...seeds["p-3398"] }) }, ["ml-1"], [], [], [], [], seeds);
    expect(ppo["p-3398"]?.ml?.attributes).toBeUndefined();
  });

  it("corrigiu a medida e apagou o INMETRO ⇒ envio e checagem levam a MESMA diferença", () => {
    const atual = { ...seeds["p-3398"] };
    atual.INLET_CONNECTION_DIAMETER = { value_name: "10 cm" };
    delete (atual as Record<string, unknown>).INMETRO_CERTIFICATION_REGISTRATION_NUMBER;
    const map = { "p-3398": cfgCom(atual) };
    const esperado = {
      INLET_CONNECTION_DIAMETER: { value_name: "10 cm" },
      INMETRO_CERTIFICATION_REGISTRATION_NUMBER: null,
    };
    const ppo = buildPerProductOverrides(map, ["ml-1"], [], [], [], [], seeds);
    expect(ppo["p-3398"]?.ml?.attributes).toEqual(esperado);
    const check = buildMlReviewCheckItems(["p-3398"], map, seeds);
    expect(check.items[0].attributeOverrides).toEqual(esperado);
    // A chave de reavaliação distingue "apagar" de "não mexer".
    expect(check.keys["p-3398"]).not.toBe(
      mlRequiredCheckKey(undefined, { INLET_CONNECTION_DIAMETER: { value_name: "10 cm" } }),
    );
  });

  it("chamada SEM sementes ⇒ a ficha inteira do formulário (comportamento anterior)", () => {
    const f = { COLOR: { value_name: "Preto" } };
    const ppo = buildPerProductOverrides({ p: cfgCom(f) }, ["ml-1"], [], [], [], []);
    expect(ppo.p?.ml?.attributes).toEqual(f);
    expect(buildMlReviewCheckItems(["p"], { p: cfgCom(f) }).items[0].attributeOverrides).toEqual(f);
  });
});

describe("withoutClearedAttributes — o null do apagar nunca é gravado", () => {
  it("tira os null; sobra nada ⇒ null", () => {
    expect(withoutClearedAttributes({ A: { value_name: "1 cm" }, B: null })).toEqual({
      A: { value_name: "1 cm" },
    });
    expect(withoutClearedAttributes({ B: null })).toBeNull();
    expect(withoutClearedAttributes(undefined)).toBeNull();
  });
});

describe("Editar anúncio: a ficha agora abre com a do produto", () => {
  const base = {
    form: { attributes: seedMlFicha(FICHA_3398) },
    product: { attributes: FICHA_3398 },
    compatibilities: [],
    mlSettings: {},
    settingsSnapshot: {},
  } as any;

  it("abrir e salvar sem mexer ⇒ não vira override (o anúncio segue a ficha do produto)", () => {
    expect(buildListingOverridesPayload(base).attributesOverride).toBeNull();
  });

  it("mexeu ⇒ override é a ficha INTEIRA do formulário (não só o campo digitado)", () => {
    const form = { attributes: { ...seedMlFicha(FICHA_3398), COLOR: { value_name: "Preto" } } };
    const p = buildListingOverridesPayload({ ...base, form });
    expect(Object.keys(p.attributesOverride as object)).toHaveLength(6);
    expect((p.attributesOverride as any).COLOR).toEqual({ value_name: "Preto" });
  });
});

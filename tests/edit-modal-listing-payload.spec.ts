import { describe, expect, it } from "vitest";
import { buildListingOverridesPayload } from "../app/produtos/components/edit-product-dialog.helpers";

/**
 * O corpo do `PUT /listings/:id` que o modal envia no modo "editar anúncio".
 *
 * Duas invariantes valem mais que todo o resto aqui:
 *
 *  1. campo IGUAL ao produto vira `null` — na convenção da rota isso significa
 *     "limpa o override e volta a herdar". É o que impede o modal de empurrar
 *     `title`/`attributes` para o ML em anúncio que não aceita alterá-los
 *     (autopeças/catálogo), o clássico `BODY_INVALID_FIELDS`;
 *  2. setting ML só entra quando difere do snapshot da abertura, e nunca entra
 *     quando o snapshot daquele campo é `null` (sem baseline confiável). Sem
 *     isso o ML recusa shipping/warranty/condition com `field_not_modifiable`
 *     em anúncio com vendas.
 */

const PRODUTO = {
  name: "Fechadura Porta Dianteira Esquerda",
  description: "Peça original",
  price: 299.9,
  brand: "Fiat",
  model: "Uno",
  year: "1996",
  version: null,
  category: "Acessórios para Veículos",
  mlCategory: "MLB101763",
  mlCategoryId: "MLB101763",
  shopeeCategoryId: "SHP_100",
  partNumber: "51234567",
  quality: "SEMINOVO",
  heightCm: 10,
  widthCm: 20,
  lengthCm: 30,
  weightKg: 1.5,
  imageUrl: "https://img/1.jpg",
  imageUrls: ["https://img/1.jpg", "https://img/2.jpg"],
  attributes: { OEM: { value_name: "51234567" } },
  sourceVehicle: "Uno 1996",
};

const FORM_IGUAL = {
  name: PRODUTO.name,
  description: PRODUTO.description,
  price: PRODUTO.price,
  brand: PRODUTO.brand,
  model: PRODUTO.model,
  year: PRODUTO.year,
  version: PRODUTO.version,
  category: PRODUTO.category,
  mlCategory: PRODUTO.mlCategory,
  shopeeCategory: PRODUTO.shopeeCategoryId,
  partNumber: PRODUTO.partNumber,
  quality: PRODUTO.quality,
  heightCm: PRODUTO.heightCm,
  widthCm: PRODUTO.widthCm,
  lengthCm: PRODUTO.lengthCm,
  weightKg: PRODUTO.weightKg,
  imageUrls: PRODUTO.imageUrls,
  attributes: PRODUTO.attributes,
  sourceVehicle: PRODUTO.sourceVehicle,
};

const SETTINGS = {
  listingType: "gold_special",
  itemCondition: "new",
  hasWarranty: true,
  warrantyUnit: "meses",
  warrantyDuration: 3,
  shippingMode: "me2",
  freeShipping: false,
  localPickup: false,
  manufacturingTime: 0,
};

const SETTING_KEYS = Object.keys(SETTINGS);

function build(over: Record<string, any> = {}) {
  return buildListingOverridesPayload({
    form: FORM_IGUAL,
    product: PRODUTO,
    compatibilities: [],
    mlSettings: SETTINGS,
    settingsSnapshot: SETTINGS,
    ...over,
  } as any);
}

describe("buildListingOverridesPayload — overrides do produto", () => {
  it("form idêntico ao produto: todos os overrides viram null", () => {
    const p = build();
    for (const [k, v] of Object.entries(p)) {
      if (k === "compatibilitiesOverride") continue;
      expect([k, v]).toEqual([k, null]);
    }
  });

  it("campo alterado vira override; os outros continuam null", () => {
    const p = build({
      form: { ...FORM_IGUAL, name: "Título só deste anúncio" },
    });
    expect(p.titleOverride).toBe("Título só deste anúncio");
    expect(p.descriptionOverride).toBeNull();
    expect(p.brandOverride).toBeNull();
  });

  it("string vazia contra produto nulo não vira override", () => {
    const p = build({ form: { ...FORM_IGUAL, version: "" } });
    expect(p.versionOverride).toBeNull();
  });

  it("preço zero ou negativo nunca é persistido (o ML rejeita price=0)", () => {
    expect(build({ form: { ...FORM_IGUAL, price: 0 } }).priceOverride).toBeNull();
    expect(
      build({ form: { ...FORM_IGUAL, price: -5 } }).priceOverride,
    ).toBeNull();
    expect(
      build({ form: { ...FORM_IGUAL, price: 310.5 } }).priceOverride,
    ).toBe(310.5);
  });

  it("medida zerada é valor de verdade, não ausência", () => {
    const p = build({ form: { ...FORM_IGUAL, weightKg: 0 } });
    expect(p.weightKgOverride).toBe(0);
  });

  it("categoria ML compara contra mlCategory e, na falta dela, mlCategoryId", () => {
    const semMlCategory = { ...PRODUTO, mlCategory: null };
    expect(
      build({ product: semMlCategory, form: { ...FORM_IGUAL } })
        .mlCategoryOverride,
    ).toBeNull();
    expect(
      build({
        product: semMlCategory,
        form: { ...FORM_IGUAL, mlCategory: "MLB1747" },
      }).mlCategoryOverride,
    ).toBe("MLB1747");
  });

  it("imagens: mesma lista não vira override; lista diferente vira", () => {
    expect(build().imageUrlsOverride).toBeNull();
    const p = build({
      form: { ...FORM_IGUAL, imageUrls: ["https://img/9.jpg"] },
    });
    expect(p.imageUrlsOverride).toEqual(["https://img/9.jpg"]);
  });

  it("produto só com imageUrl (sem lista) é comparado como lista de um", () => {
    const prod = { ...PRODUTO, imageUrls: null };
    expect(
      build({ product: prod, form: { ...FORM_IGUAL, imageUrls: [prod.imageUrl] } })
        .imageUrlsOverride,
    ).toBeNull();
  });

  it("ficha técnica igual não vira override; diferente vira", () => {
    expect(build().attributesOverride).toBeNull();
    const p = build({
      form: { ...FORM_IGUAL, attributes: { OEM: { value_name: "OUTRO" } } },
    });
    expect(p.attributesOverride).toEqual({ OEM: { value_name: "OUTRO" } });
  });
});

describe("buildListingOverridesPayload — settings ML", () => {
  it("settings iguais ao snapshot não entram no corpo", () => {
    const p = build();
    for (const k of SETTING_KEYS) expect(p).not.toHaveProperty(k);
  });

  it("setting alterado entra; os demais continuam fora", () => {
    const p = build({
      mlSettings: { ...SETTINGS, shippingMode: "not_specified" },
    });
    expect(p.shippingMode).toBe("not_specified");
    expect(p).not.toHaveProperty("listingType");
    expect(p).not.toHaveProperty("freeShipping");
  });

  it("snapshot null no campo = sem baseline confiável ⇒ NÃO envia", () => {
    const p = build({
      settingsSnapshot: { ...SETTINGS, shippingMode: null },
      mlSettings: { ...SETTINGS, shippingMode: "not_specified" },
    });
    expect(p).not.toHaveProperty("shippingMode");
  });

  it("snapshot inteiro null (listing não carregou) ⇒ nenhum setting sai", () => {
    const p = build({
      settingsSnapshot: null,
      mlSettings: { ...SETTINGS, listingType: "bronze", freeShipping: true },
    });
    for (const k of SETTING_KEYS) expect(p).not.toHaveProperty(k);
  });

  it("false e 0 são alterações válidas quando o snapshot diz outra coisa", () => {
    const p = build({
      settingsSnapshot: { ...SETTINGS, freeShipping: true, manufacturingTime: 5 },
      mlSettings: { ...SETTINGS, freeShipping: false, manufacturingTime: 0 },
    });
    expect(p.freeShipping).toBe(false);
    expect(p.manufacturingTime).toBe(0);
  });
});

describe("buildListingOverridesPayload — omitKeys", () => {
  it("campo exibido em modo leitura não entra no corpo (= não mexer)", () => {
    const p = build({
      form: { ...FORM_IGUAL, mlCategory: "MLB1747" },
      omitKeys: ["mlCategoryOverride"],
    });
    expect(p).not.toHaveProperty("mlCategoryOverride");
    // e não afeta os vizinhos
    expect(p).toHaveProperty("categoryOverride");
  });

  it("omitir um setting também funciona", () => {
    const p = build({
      mlSettings: { ...SETTINGS, listingType: "bronze" },
      omitKeys: ["listingType"],
    });
    expect(p).not.toHaveProperty("listingType");
  });

  it("sem omitKeys nada é removido", () => {
    const p = build();
    expect(p).toHaveProperty("mlCategoryOverride");
  });
});

describe("REGRESSÃO: o corpo é de anúncio, não de produto nem de criação", () => {
  it("nenhuma chave de criação/dispatch vaza para o PUT do anúncio", () => {
    const p = build({ form: { ...FORM_IGUAL, name: "outro" } });
    const proibidas = [
      "requests",
      "productId",
      "accountId",
      "platform",
      "crossAccountIncrease",
      "categoryId",
      "mlSettings",
      "createMlListing",
      "stock",
      "costPrice",
      "markup",
      "location",
      "locationId",
      "mlCategorySource",
      "compatibilityPositions",
    ];
    for (const k of proibidas) expect(p).not.toHaveProperty(k);
  });

  it("só saem chaves *Override e os 9 settings ML", () => {
    const p = build({
      mlSettings: { ...SETTINGS, listingType: "bronze" },
      form: { ...FORM_IGUAL, name: "outro" },
    });
    for (const k of Object.keys(p)) {
      expect(k.endsWith("Override") || SETTING_KEYS.includes(k)).toBe(true);
    }
  });
});

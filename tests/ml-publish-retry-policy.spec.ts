import { describe, it, expect } from "vitest";
import {
  LAST_ERROR_MARKER,
  humanMessageForKind,
  isTerminalMarker,
  lastErrorMarkerFor,
  normalizeMLError,
} from "../app/marketplaces/lib/ml-error-normalizer";
import {
  pickReconciledItem,
  RECONCILE_TOLERANCE_MS,
} from "../app/marketplaces/lib/ml-reconcile.logic";
import { placeholderMlSettings } from "../app/marketplaces/lib/ml-placeholder-settings";
import { isPublishRelevantProductChange } from "../app/marketplaces/lib/ml-rearm.logic";
import {
  describeMLCause,
  pickActionableMLErrorForCategory,
} from "../app/marketplaces/services/ml-error-message.service";

/**
 * Política de falha na publicação do ML (PR-2, 22/09/2026).
 * Casos reais medidos nos logs de produção de 16 a 22/09.
 */

describe("marcador por classe de erro", () => {
  it("dado ⇒ [TERMINAL][CORRIGIVEL]; auth ⇒ [TERMINAL][RECONECTAR]", () => {
    expect(
      lastErrorMarkerFor({ kind: "VALIDATION", httpStatus: 400, timedOut: false }),
    ).toBe(LAST_ERROR_MARKER.CORRIGIVEL);
    expect(
      lastErrorMarkerFor({ kind: "AUTH", httpStatus: 401, timedOut: false }),
    ).toBe(LAST_ERROR_MARKER.RECONECTAR);
  });

  it("timeout, desconhecido e 5xx ⇒ [VERIFICAR] (pode ter criado no ML)", () => {
    expect(
      lastErrorMarkerFor({ kind: "UNKNOWN", httpStatus: null, timedOut: true }),
    ).toBe(LAST_ERROR_MARKER.VERIFICAR);
    expect(
      lastErrorMarkerFor({ kind: "TRANSIENT", httpStatus: 503, timedOut: false }),
    ).toBe(LAST_ERROR_MARKER.VERIFICAR);
  });

  it("429 e rede caída ⇒ sem marcador (nada foi criado, retry comum)", () => {
    expect(
      lastErrorMarkerFor({ kind: "RATE_LIMIT", httpStatus: 429, timedOut: false }),
    ).toBeNull();
    expect(
      lastErrorMarkerFor({ kind: "TRANSIENT", httpStatus: null, timedOut: false }),
    ).toBeNull();
  });

  it("isTerminalMarker só para os [TERMINAL]", () => {
    expect(isTerminalMarker(LAST_ERROR_MARKER.CORRIGIVEL)).toBe(true);
    expect(isTerminalMarker(LAST_ERROR_MARKER.RECONECTAR)).toBe(true);
    expect(isTerminalMarker(LAST_ERROR_MARKER.VERIFICAR)).toBe(false);
    expect(isTerminalMarker(null)).toBe(false);
  });
});

describe("mensagem humana por classe (nunca JSON)", () => {
  const base = normalizeMLError({ err: new Error("x") });
  it.each([
    ["VALIDATION", /recusou o anúncio/],
    ["AUTH", /reconectada/],
    ["RATE_LIMIT", /limitou/],
    ["TRANSIENT", /indisponível/],
    ["UNKNOWN", /não detalhou/],
  ] as const)("%s", (kind, re) => {
    const msg = humanMessageForKind({ ...base, kind });
    expect(msg).toMatch(re);
    expect(msg).not.toMatch(/[{}]/);
  });

  it("validação cita a causa do ML e o código", () => {
    expect(
      humanMessageForKind(
        { ...base, kind: "VALIDATION" },
        { firstCause: { cause_id: 9999, message: "Something odd" } },
      ),
    ).toBe(
      "O Mercado Livre recusou o anúncio: Something odd (código 9999). Corrija o cadastro do produto e tente publicar novamente.",
    );
  });

  it("timeout avisa que a Dexo confere antes de recriar", () => {
    expect(
      humanMessageForKind({ ...base, kind: "UNKNOWN", timedOut: true }),
    ).toMatch(/confere se o anúncio chegou a ser criado/);
  });
});

describe("causas reais que ficavam escondidas atrás do family_name", () => {
  it("3702 INMETRO com palavras de busca", () => {
    expect(
      describeMLCause({
        cause_id: 3702,
        type: "error",
        code: "item.attribute.invalid_sanitary_registry_value",
        message:
          'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
      }),
    ).toMatch(/Número de registro\/certificação INMETRO.*deixe-o em branco/);
  });

  it("3708 número sem unidade", () => {
    expect(
      describeMLCause({
        cause_id: 3708,
        type: "error",
        code: "item.attribute.number_invalid_format",
        message: 'O valor que você inseriu em "Largura" está incorreto.',
      }),
    ).toMatch(/"Largura".*"10 cm"/);
  });

  it("422 atributo do tipo imagem com texto", () => {
    expect(
      describeMLCause({
        cause_id: 422,
        type: "error",
        message:
          "Attribute REGULATORY_INFORMATION_QR_CODE of type picture has an invalid picture ID (1)",
      }),
    ).toMatch(/REGULATORY_INFORMATION_QR_CODE.*IMAGEM.*\("1"\)/);
  });

  it("5401 medidas implausíveis", () => {
    expect(
      describeMLCause({
        cause_id: 5401,
        type: "error",
        code: "item.attribute.invalid.seller.package.dimensions",
        message: "One or more attributes ... do not have proper values",
      }),
    ).toMatch(/medidas do pacote/);
  });

  it("3709 e 3704 (mensagem do ML já em português) são repassadas", () => {
    expect(
      describeMLCause({
        cause_id: 3709,
        type: "error",
        message:
          '"Unidades por kit": Preencha este campo porque você preencheu o "Unidade" no campo "Formato de venda".',
      }),
    ).toMatch(/^"Unidades por kit".*tente publicar novamente\.$/);
    expect(
      describeMLCause({
        cause_id: 3704,
        type: "error",
        message: 'O campo "Marca" é obrigatório e não foi adicionado.',
      }),
    ).toMatch(/"Marca" é obrigatório/);
  });

  it("4053 continua NÃO traduzido (aviso de carona — decisão de 05/08)", () => {
    expect(
      describeMLCause({
        cause_id: 4053,
        type: "warning",
        code: "shipping.lost_me1_by_user",
        message: "x",
      }),
    ).toBeNull();
  });
});

describe("pickActionableMLErrorForCategory — a causa é da categoria ESCOLHIDA", () => {
  const qr = {
    cause_id: 422,
    type: "error",
    message:
      "Attribute REGULATORY_INFORMATION_QR_CODE of type picture has an invalid picture ID (1)",
  };
  const vehicleType = {
    cause_id: 3510,
    type: "error",
    code: "invalid.item.attribute.values",
    message: "Attribute [VEHICLE_TYPE] is not valid, item values [(11377043:Carro/Caminhonete)]",
  };

  it("caso real MLB63736: mostra o QR code da categoria pedida, não o VEHICLE_TYPE da sugerida", () => {
    const msg = pickActionableMLErrorForCategory(
      [
        { causes: [{ cause_id: 369, type: "error" }], categoryId: "MLB63736" },
        { causes: [qr], categoryId: "MLB63736" },
        { causes: [vehicleType], categoryId: "MLB437856" },
      ],
      "MLB63736",
    );
    expect(msg).toMatch(/REGULATORY_INFORMATION_QR_CODE/);
    expect(msg).not.toMatch(/VEHICLE_TYPE/);
  });

  it("só a sugerida falou algo reconhecível ⇒ diz que era outra categoria", () => {
    const msg = pickActionableMLErrorForCategory(
      [
        { causes: [{ cause_id: 369, type: "error" }], categoryId: "MLB63736" },
        { causes: [vehicleType], categoryId: "MLB437856" },
      ],
      "MLB63736",
    );
    expect(msg).toMatch(/alternativa sugerida pelo próprio ML \(MLB437856\)/);
  });

  it("nada reconhecível ⇒ null (o chamador usa a frase por classe)", () => {
    expect(
      pickActionableMLErrorForCategory(
        [{ causes: [{ cause_id: 369, type: "error" }], categoryId: "MLB1" }],
        "MLB1",
      ),
    ).toBeNull();
  });
});

describe("reconciliação anti-duplicata", () => {
  const placeholder = new Date("2026-09-22T19:34:12.000Z");

  it("adota o item criado depois do placeholder (o mais recente)", () => {
    const r = pickReconciledItem(
      [
        { id: "MLB_ANTIGO", status: "closed", dateCreated: "2026-08-01T10:00:00.000Z" },
        { id: "MLB_NOVO", status: "active", dateCreated: "2026-09-22T19:34:40.000Z" },
        { id: "MLB_NOVO2", status: "under_review", dateCreated: "2026-09-22T19:36:00.000Z" },
      ],
      placeholder,
    );
    expect(r?.id).toBe("MLB_NOVO2");
  });

  it("não adota anúncio antigo da mesma peça (republicação legítima)", () => {
    expect(
      pickReconciledItem(
        [{ id: "MLB_ANTIGO", status: "closed", dateCreated: "2026-08-01T10:00:00.000Z" }],
        placeholder,
      ),
    ).toBeNull();
  });

  it("folga de relógio: item criado pouco ANTES do placeholder ainda conta", () => {
    const quase = new Date(placeholder.getTime() - RECONCILE_TOLERANCE_MS + 1000);
    expect(
      pickReconciledItem(
        [{ id: "MLB_X", status: "active", dateCreated: quase.toISOString() }],
        placeholder,
      )?.id,
    ).toBe("MLB_X");
  });

  it("sem data de criação ⇒ não adota (sem evidência)", () => {
    expect(
      pickReconciledItem([{ id: "MLB_X", status: "active", dateCreated: null }], placeholder),
    ).toBeNull();
  });
});

describe("configurações do placeholder no retry", () => {
  it("repassa tipo, frete e garantia; NUNCA a condição", () => {
    expect(
      placeholderMlSettings({
        listingType: "gold_premium",
        freeShipping: true,
        shippingMode: "not_specified",
        localPickup: true,
        hasWarranty: true,
        warrantyUnit: "dias",
        warrantyDuration: 30,
        manufacturingTime: 0,
        itemCondition: "new",
      } as any),
    ).toEqual({
      listingType: "gold_premium",
      freeShipping: true,
      shippingMode: "not_specified",
      localPickup: true,
      hasWarranty: true,
      warrantyUnit: "dias",
      warrantyDuration: 30,
      manufacturingTime: 0,
    });
  });

  it("linha sem nenhuma configuração ⇒ undefined (chamada igual à de sempre)", () => {
    expect(placeholderMlSettings({})).toBeUndefined();
    expect(placeholderMlSettings(null)).toBeUndefined();
    expect(
      placeholderMlSettings({ listingType: "  ", itemCondition: "new" } as any),
    ).toBeUndefined();
  });

  it("frete grátis FALSE é repassado (não some por ser falsy)", () => {
    expect(placeholderMlSettings({ freeShipping: false })).toEqual({
      freeShipping: false,
    });
  });
});

describe("re-armar só quando a edição pode mudar o resultado", () => {
  const antes = {
    name: "Farol Gol",
    price: 100,
    heightCm: 20,
    attributes: { GTIN: { value_name: "754243m6a" } },
    brand: "VW",
  };

  it("mudou a ficha técnica ⇒ re-arma", () => {
    expect(
      isPublishRelevantProductChange({ attributes: {} }, antes),
    ).toBe(true);
  });

  it("mudou medida, preço, título, marca ⇒ re-arma", () => {
    expect(isPublishRelevantProductChange({ heightCm: 25 }, antes)).toBe(true);
    expect(isPublishRelevantProductChange({ price: 120 }, antes)).toBe(true);
    expect(isPublishRelevantProductChange({ name: "Farol Gol G5" }, antes)).toBe(
      true,
    );
    expect(isPublishRelevantProductChange({ brand: "Volkswagen" }, antes)).toBe(
      true,
    );
  });

  it("só estoque/localização ⇒ NÃO re-arma", () => {
    expect(
      isPublishRelevantProductChange({ stock: 3, locationId: "L1" } as any, antes),
    ).toBe(false);
  });

  it("mandou os mesmos valores ⇒ NÃO re-arma", () => {
    expect(
      isPublishRelevantProductChange(
        { name: "Farol Gol", price: 100, heightCm: 20, brand: "VW" },
        antes,
      ),
    ).toBe(false);
  });

  it("preço Decimal (toNumber) compara pelo número", () => {
    expect(
      isPublishRelevantProductChange(
        { price: 100 },
        { price: { toNumber: () => 100 } },
      ),
    ).toBe(false);
  });
});

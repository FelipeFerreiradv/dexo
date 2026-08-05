import { describe, it, expect } from "vitest";
import {
  describeMLCause,
  pickActionableMLError,
} from "../ml-error-message.service";

/**
 * Causas MEDIDAS EM PRODUÇÃO em 05/08/2026.
 *
 * Origem: 14 anúncios parados com `lastError` de `family_name` foram
 * revalidados um a um contra `POST /items/validate` (que valida sem criar
 * nada), com o corpo que a escada JÁ envia na retentativa — com `family_name`
 * e sem `title`.
 *
 * O achado que motiva este arquivo: NENHUM dos 14 estava barrado por
 * `family_name`. A escada resolve isso sozinha desde sempre. As causas reais
 * eram outras — todas corrigíveis pelo operador — e nenhuma delas era
 * reconhecida, então caíam no `null` e o `lastError` seguia mostrando o erro da
 * primeira tentativa. É por isso que 136 anúncios ficaram meses parados sem
 * ninguém conseguir diagnosticar.
 *
 * As `message` abaixo são cópias literais do que o ML devolveu.
 */

/** 6 de 14. O operador digitou o número da peça no campo de código de barras. */
const GTIN_INVALIDO = {
  department: "items",
  cause_id: 7711,
  code: "item.attribute.product_identifier.invalid_format",
  message:
    "Product Identifier [GTIN] contains values with invalid format: [754243m6a]",
};

/** 3 de 14. */
const MEDIDAS_AUSENTES = {
  department: "items",
  cause_id: 5400,
  code: "item.attribute.missing.seller.package.dimensions",
  message:
    "The attributes [seller_package_height, seller_package_width, seller_package_length, seller_package_weight] are all required",
};

/** 2 de 14. */
const VALOR_INVALIDO = {
  department: "items",
  cause_id: 3510,
  code: "invalid.item.attribute.values",
  message:
    "Attribute [VEHICLE_TYPE] is not valid, item values [(13222040:Linha Pesada)]",
};

/** Vem de carona com as de cima. Tratada como AVISO — ver o módulo. */
const FRETE_AVISO = {
  department: "shipping",
  cause_id: 4053,
  code: "shipping.lost_me1_by_user",
  message: "User has not mode me1",
};

const FAMILY_NAME = {
  department: "items",
  cause_id: 369,
  code: "body.required_fields",
  message:
    "The body does not contains some or none of the following properties [family_name]",
};

/** Causas que o ML devolve junto e que não dizem nada ao operador. */
const RUIDO = [
  { cause_id: 301, code: "item.attributes.dropped", message: "dropped" },
  { cause_id: 306, code: "item.attributes.omitted", message: "omitted" },
];

describe("describeMLCause — GTIN em formato inválido", () => {
  it("explica que o campo é código de barras e aponta o valor recusado", () => {
    const msg = describeMLCause(GTIN_INVALIDO);
    expect(msg).toContain("754243m6a");
    expect(msg).toContain("Número da Peça");
    expect(msg).toContain("recrie o anúncio");
  });

  it("não vaza jargão da API para o operador", () => {
    const msg = describeMLCause(GTIN_INVALIDO) ?? "";
    expect(msg).not.toContain("product_identifier");
    expect(msg).not.toContain("invalid_format");
    expect(msg).not.toContain("GTIN]");
  });

  it("funciona mesmo sem conseguir extrair o valor da mensagem", () => {
    const msg = describeMLCause({
      ...GTIN_INVALIDO,
      message: "Product Identifier has invalid format",
    });
    expect(msg).toBeTruthy();
    expect(msg).toContain("código de barras");
  });
});

describe("describeMLCause — medidas do pacote", () => {
  it("pede as quatro medidas em português", () => {
    const msg = describeMLCause(MEDIDAS_AUSENTES) ?? "";
    expect(msg).toContain("altura");
    expect(msg).toContain("largura");
    expect(msg).toContain("comprimento");
    expect(msg).toContain("peso");
    expect(msg).not.toContain("seller_package");
  });
});

describe("describeMLCause — valor recusado pela categoria", () => {
  it("cita o atributo e o valor que o ML recusou", () => {
    const msg = describeMLCause(VALOR_INVALIDO) ?? "";
    expect(msg).toContain("Linha Pesada");
    expect(msg).not.toContain("invalid.item.attribute.values");
  });
});

describe("describeMLCause — o que NÃO é traduzido", () => {
  it("frete continua sendo aviso, não causa acionável", () => {
    // Decisão anterior a esta mudança, confirmada pela medição: o 4053 aparece
    // até em corpos sem nenhum outro problema. Traduzi-lo mandaria o operador
    // mexer no frete da conta quando o que falta é um campo do cadastro.
    expect(describeMLCause(FRETE_AVISO)).toBeNull();
  });

  it("family_name continua sem tradução — a escada já resolve sozinha", () => {
    expect(describeMLCause(FAMILY_NAME)).toBeNull();
  });

  it("ruído de atributo descartado/omitido não vira mensagem", () => {
    for (const c of RUIDO) expect(describeMLCause(c)).toBeNull();
  });

  it("causa desconhecida devolve null — contrato conservador do módulo", () => {
    expect(describeMLCause({ cause_id: 99999, code: "nunca.visto" })).toBeNull();
    expect(describeMLCause({} as never)).toBeNull();
  });
});

describe("pickActionableMLError — prioridade dentro da mesma tentativa", () => {
  it("o caso real: family_name na 1a tentativa, GTIN na retentativa", () => {
    const msg = pickActionableMLError([[FAMILY_NAME], [GTIN_INVALIDO]]);
    expect(msg).toContain("754243m6a");
    expect(msg).not.toContain("family_name");
  });

  it("ignora o ruído que vem junto e reporta a causa de verdade", () => {
    // Sequência literal de um dos 14: `301 + 306 + 3510`.
    const msg = pickActionableMLError([
      [FAMILY_NAME],
      [RUIDO[0], RUIDO[1], VALOR_INVALIDO],
    ]);
    expect(msg).toContain("Linha Pesada");
  });

  it("campo em branco vence valor recusado, venha na ordem que vier", () => {
    // A ordem das causas na resposta do ML não é garantida — a mensagem não
    // pode depender dela.
    const a = pickActionableMLError([[MEDIDAS_AUSENTES, GTIN_INVALIDO]]);
    const b = pickActionableMLError([[GTIN_INVALIDO, MEDIDAS_AUSENTES]]);
    expect(a).toBe(b);
    expect(a).toContain("altura");
  });

  it("o aviso de frete não rouba o lugar da causa real", () => {
    const a = pickActionableMLError([[FRETE_AVISO, GTIN_INVALIDO]]);
    const b = pickActionableMLError([[GTIN_INVALIDO, FRETE_AVISO]]);
    expect(a).toBe(b);
    expect(a).toContain("754243m6a");
  });

  it("prefere a tentativa mais recente, como antes", () => {
    const msg = pickActionableMLError([[GTIN_INVALIDO], [MEDIDAS_AUSENTES]]);
    expect(msg).toContain("altura");
  });

  it("KILL-SWITCH: somenteObrigatorios volta ao comportamento anterior", () => {
    // Com a flag ligada, só `item.attributes.missing_required` é reconhecido —
    // e nenhuma das causas novas produz mensagem.
    expect(
      pickActionableMLError([[GTIN_INVALIDO]], undefined, {
        somenteObrigatorios: true,
      }),
    ).toBeNull();
    expect(
      pickActionableMLError([[MEDIDAS_AUSENTES, VALOR_INVALIDO]], undefined, {
        somenteObrigatorios: true,
      }),
    ).toBeNull();
  });

  it("tolera cause[] malformado sem lançar", () => {
    expect(
      pickActionableMLError([null as never, [{} as never], undefined as never]),
    ).toBeNull();
  });
});

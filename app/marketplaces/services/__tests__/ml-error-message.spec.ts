import { describe, it, expect } from "vitest";
import {
  pickActionableMLError,
  describeMissingAttributesCause,
} from "../ml-error-message.service";

/**
 * Caso real de produção (base da Giovanna, produtos sem partNumber):
 *
 *   1ª tentativa → body.required_fields [family_name] (369)
 *   categoria sugerida → item.attributes.missing_required [PART_NUMBER] (147)
 *   escada esgota → re-lança o family_name original
 *
 * O operador via "family_name" — que a escada já tinha resolvido e que ele não
 * tem como corrigir — em vez do PART_NUMBER em branco, que ele corrige no
 * cadastro em 10 segundos.
 */

const FAMILY_NAME_CAUSE = {
  department: "items",
  cause_id: 369,
  type: "error",
  code: "body.required_fields",
  references: ["body"],
  message:
    "The body does not contains some or none of the following properties [family_name]",
};

const PART_NUMBER_CAUSE = {
  department: "items",
  cause_id: 147,
  code: "item.attributes.missing_required",
  message:
    "The attributes [PART_NUMBER] are required for category MLB7863 and channel marketplace",
};

const SHIPPING_WARNING_CAUSE = {
  department: "shipping",
  cause_id: 4053,
  code: "shipping.lost_me1_by_user",
  message: "User has not mode me1",
};

describe("describeMissingAttributesCause", () => {
  it("traduz PART_NUMBER para o rótulo do cadastro, citando a categoria", () => {
    const msg = describeMissingAttributesCause(PART_NUMBER_CAUSE);
    expect(msg).toContain("MLB7863");
    expect(msg).toContain("Número da Peça");
    expect(msg).toContain("recrie o anúncio");
    // Não deve vazar jargão da API para o operador.
    expect(msg).not.toContain("item.attributes.missing_required");
  });

  it("usa plural quando o ML exige mais de um atributo", () => {
    const msg = describeMissingAttributesCause({
      ...PART_NUMBER_CAUSE,
      message:
        "The attributes [PART_NUMBER, BRAND] are required for category MLB7863",
    });
    expect(msg).toContain("Número da Peça");
    expect(msg).toContain("Marca");
    expect(msg).toContain("os campos");
  });

  it("cai para a categoria do payload quando a mensagem não cita nenhuma", () => {
    const msg = describeMissingAttributesCause(
      { ...PART_NUMBER_CAUSE, message: "The attributes [PART_NUMBER] are required" },
      "MLB1744",
    );
    expect(msg).toContain("MLB1744");
  });

  it("ignora causas que não são de atributo obrigatório", () => {
    expect(describeMissingAttributesCause(FAMILY_NAME_CAUSE)).toBeNull();
    expect(describeMissingAttributesCause(SHIPPING_WARNING_CAUSE)).toBeNull();
  });

  it("ignora a causa quando ela não cita nenhum atributo", () => {
    expect(
      describeMissingAttributesCause({
        code: "item.attributes.missing_required",
        message: "The attributes are required",
      }),
    ).toBeNull();
  });
});

describe("pickActionableMLError", () => {
  it("reporta o PART_NUMBER da retentativa, não o family_name da 1ª tentativa", () => {
    // Exatamente a sequência do log de produção.
    const msg = pickActionableMLError([
      [FAMILY_NAME_CAUSE],
      [PART_NUMBER_CAUSE, SHIPPING_WARNING_CAUSE],
    ]);
    expect(msg).toContain("Número da Peça");
    expect(msg).not.toContain("family_name");
  });

  it("mantém a mensagem atual quando só há family_name (nada mais acionável)", () => {
    expect(pickActionableMLError([[FAMILY_NAME_CAUSE]])).toBeNull();
  });

  it("mantém a mensagem atual quando não há causa nenhuma", () => {
    expect(pickActionableMLError([])).toBeNull();
    expect(pickActionableMLError([[]])).toBeNull();
  });

  it("tolera cause[] malformado sem lançar", () => {
    expect(
      pickActionableMLError([null as any, undefined as any, [{} as any]]),
    ).toBeNull();
  });

  it("prefere a tentativa mais recente quando várias são acionáveis", () => {
    const msg = pickActionableMLError([
      [{ ...PART_NUMBER_CAUSE, message: "The attributes [BRAND] are required for category MLB111" }],
      [PART_NUMBER_CAUSE],
    ]);
    // A última tentativa é a que reflete o payload mais evoluído da escada.
    expect(msg).toContain("MLB7863");
    expect(msg).toContain("Número da Peça");
  });

  it("não confunde o warning de shipping com uma causa acionável", () => {
    expect(pickActionableMLError([[SHIPPING_WARNING_CAUSE]])).toBeNull();
  });
});

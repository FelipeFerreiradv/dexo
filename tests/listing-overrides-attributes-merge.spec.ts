import { describe, it, expect, afterEach } from "vitest";
import {
  applyOverridesToProduct,
  mergeAttributeOverride,
} from "../app/marketplaces/services/listing-overrides.service";

/**
 * `attributesOverride` substitui o mapa inteiro de ficha técnica. Isso é certo
 * para a edição unitária (o modal manda o mapa completo), mas apaga o que o
 * override não menciona quando ele é PARCIAL — que é o caso da Revisão
 * individual em massa. Efeito prático: o lado/posição informado no cadastro do
 * produto sumia do anúncio no re-sync seguinte.
 *
 * O merge fica atrás de ML_ATTR_OVERRIDE_MERGE_ENABLED porque muda o payload de
 * anúncios vivos. Com a flag ausente o comportamento é o de sempre.
 */

const product = {
  id: "prod-1",
  name: "Farol Dianteiro Esquerdo Gol",
  attributes: {
    POSITION: { value_id: "DE", value_name: "Dianteira Esquerda" },
    COLOR: { value_id: "BLK", value_name: "Preto" },
  },
} as any;

afterEach(() => {
  delete process.env.ML_ATTR_OVERRIDE_MERGE_ENABLED;
});

describe("mergeAttributeOverride", () => {
  it("preserva as chaves que o override não menciona", () => {
    const out = mergeAttributeOverride(product.attributes, {
      COLOR: { value_id: "WHT", value_name: "Branco" },
    });
    expect(out).toEqual({
      POSITION: { value_id: "DE", value_name: "Dianteira Esquerda" },
      COLOR: { value_id: "WHT", value_name: "Branco" },
    });
  });

  it("apaga a chave quando o override manda null explicitamente", () => {
    const out = mergeAttributeOverride(product.attributes, {
      POSITION: null,
    });
    expect(out).not.toHaveProperty("POSITION");
    expect(out).toHaveProperty("COLOR");
  });

  it("devolve o override cru quando o produto não tem ficha técnica", () => {
    const over = { POSITION: { value_id: "DE" } };
    expect(mergeAttributeOverride(null, over)).toEqual(over);
    expect(mergeAttributeOverride(undefined, over)).toEqual(over);
    expect(mergeAttributeOverride([], over)).toEqual(over);
  });

  it("não tenta fundir override em formato de array", () => {
    const arr = [{ id: "POSITION" }] as any;
    expect(mergeAttributeOverride(product.attributes, arr)).toBe(arr);
  });

  it("override null devolve null (limpar continua limpando)", () => {
    expect(mergeAttributeOverride(product.attributes, null)).toBeNull();
  });
});

describe("applyOverridesToProduct — attributes", () => {
  it("flag ausente: substitui o mapa inteiro (comportamento atual)", () => {
    const out = applyOverridesToProduct(product, {
      attributesOverride: { COLOR: { value_id: "WHT", value_name: "Branco" } },
    } as any);
    expect(out.attributes).toEqual({
      COLOR: { value_id: "WHT", value_name: "Branco" },
    });
    expect(out.attributes).not.toHaveProperty("POSITION");
  });

  it("flag ligada: override parcial não apaga o lado/posição herdado", () => {
    process.env.ML_ATTR_OVERRIDE_MERGE_ENABLED = "true";
    const out = applyOverridesToProduct(product, {
      attributesOverride: { COLOR: { value_id: "WHT", value_name: "Branco" } },
    } as any);
    expect(out.attributes).toEqual({
      POSITION: { value_id: "DE", value_name: "Dianteira Esquerda" },
      COLOR: { value_id: "WHT", value_name: "Branco" },
    });
  });

  it("flag ligada: override pode apagar de propósito com null", () => {
    process.env.ML_ATTR_OVERRIDE_MERGE_ENABLED = "true";
    const out = applyOverridesToProduct(product, {
      attributesOverride: { POSITION: null },
    } as any);
    expect(out.attributes).not.toHaveProperty("POSITION");
    expect(out.attributes).toHaveProperty("COLOR");
  });

  it("sem attributesOverride, a ficha do produto fica intacta nos dois modos", () => {
    const semFlag = applyOverridesToProduct(product, { priceOverride: 10 } as any);
    expect(semFlag.attributes).toEqual(product.attributes);

    process.env.ML_ATTR_OVERRIDE_MERGE_ENABLED = "true";
    const comFlag = applyOverridesToProduct(product, { priceOverride: 10 } as any);
    expect(comFlag.attributes).toEqual(product.attributes);
  });

  it("flag ligada não altera o resultado quando o override é completo", () => {
    // Caminho da edição unitária: diffJson manda o mapa inteiro, então merge
    // e replace precisam produzir exatamente a mesma coisa.
    const completo = {
      POSITION: { value_id: "TD", value_name: "Traseira Direita" },
      COLOR: { value_id: "WHT", value_name: "Branco" },
    };
    const replace = applyOverridesToProduct(product, {
      attributesOverride: completo,
    } as any);

    process.env.ML_ATTR_OVERRIDE_MERGE_ENABLED = "true";
    const merge = applyOverridesToProduct(product, {
      attributesOverride: completo,
    } as any);

    expect(merge.attributes).toEqual(replace.attributes);
  });
});

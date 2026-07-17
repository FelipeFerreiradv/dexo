import { describe, it, expect } from "vitest";
import {
  PART_TYPE_CATEGORY_MAP,
  basePartTypeKey,
  lookupPartTypeCategory,
  type PartTypeCategoryMap,
} from "../app/marketplaces/lib/category-inference/part-type-category-map";

/**
 * Lookup do mapa tipo-de-peça → categoria (Sinal A do motor de inferência).
 * O mapa sintético isola a semântica do lookup; o bloco "canário" prende as
 * chaves de altíssimo valor do mapa REAL (se uma regeneração derrubar "farol",
 * o teste avisa antes do PR mergear).
 */

const MAP: PartTypeCategoryMap = {
  parachoque: { ml: "MLB_BASE", shopee: "111", source: "prod-mode" },
  "parachoque-dianteiro": { ml: "MLB_DIANT", source: "prod-mode" },
  farol: { ml: "MLB_FAROL", source: "manual" },
};

describe("basePartTypeKey", () => {
  it("remove o sufixo de posição dobrado", () => {
    expect(basePartTypeKey("cubo-de-roda-dianteiro", "dianteiro")).toBe(
      "cubo-de-roda",
    );
    expect(
      basePartTypeKey("fechadura-traseiro-esquerdo", "traseiro-esquerdo"),
    ).toBe("fechadura");
  });

  it("sem posição (ou sufixo divergente) devolve a chave como está", () => {
    expect(basePartTypeKey("farol", null)).toBe("farol");
    // "tampa-traseira" é label próprio do PART_TYPES (feminino), não dobra de
    // posição ("traseiro") — não pode ser truncado.
    expect(basePartTypeKey("tampa-traseira", "traseiro")).toBe(
      "tampa-traseira",
    );
  });
});

describe("lookupPartTypeCategory", () => {
  it("chave dobrada exata vence a chave-base", () => {
    const hit = lookupPartTypeCategory("parachoque-dianteiro", "dianteiro", MAP);
    expect(hit).toMatchObject({
      key: "parachoque-dianteiro",
      exact: true,
      entry: { ml: "MLB_DIANT" },
    });
  });

  it("cai para a chave-base quando a dobrada não existe", () => {
    const hit = lookupPartTypeCategory(
      "parachoque-traseiro-esquerdo",
      "traseiro-esquerdo",
      MAP,
    );
    expect(hit).toMatchObject({
      key: "parachoque",
      exact: false,
      entry: { ml: "MLB_BASE", shopee: "111" },
    });
  });

  it("null para tipo desconhecido ou ausente", () => {
    expect(lookupPartTypeCategory("virabrequim", null, MAP)).toBeNull();
    expect(lookupPartTypeCategory(null, null, MAP)).toBeNull();
  });
});

describe("mapa real: overrides por campo aplicados sobre o gerado", () => {
  it("override corrige só o lado Shopee preservando o ML gerado", () => {
    // farol: ML vem do gerado (moda de produção), Shopee vem do override
    // (a moda histórica era "Grade de Farol de Milha" — poluição de import).
    const farol = PART_TYPE_CATEGORY_MAP["farol"];
    expect(farol?.ml).toBe("MLB7863");
    expect(farol?.shopee).toBe("102297");
  });

  it("override com null remove o campo poluído", () => {
    const painel = PART_TYPE_CATEGORY_MAP["painel"];
    // painel tinha SÓ o lado Shopee poluído → entrada some inteira.
    expect(painel).toBeUndefined();
  });
});

describe("mapa real: canário das chaves de alto valor", () => {
  it.each([
    "farol",
    "lanterna",
    // A árvore ML separa para-choques por posição — a base não tem folha
    // genérica; o que importa é a dobrada estar coberta.
    "parachoque-dianteiro",
    "parachoque-traseiro",
    "retrovisor",
    "porta",
    "capo",
    "fechadura",
    "macaneta",
    "amortecedor",
  ])("'%s' está mapeado com categoria ML", (key) => {
    const hit = lookupPartTypeCategory(key, null);
    expect(hit?.entry.ml, `chave "${key}" sumiu do mapa`).toMatch(/^MLB\d+$/);
  });

  it("'parachoque' base cobre ao menos a Shopee (título sem posição)", () => {
    expect(PART_TYPE_CATEGORY_MAP["parachoque"]?.shopee).toBe("102286");
  });

  it("labels ambíguos NUNCA entram no mapa (gate do gerador)", () => {
    for (const key of ["motor", "sensor", "caixa", "capa", "freio", "tampa"]) {
      expect(
        PART_TYPE_CATEGORY_MAP[key],
        `"${key}" é ambíguo e não pode ter entrada própria`,
      ).toBeUndefined();
    }
  });
});

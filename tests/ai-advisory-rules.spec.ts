import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CANAIS,
  LIMITES_MERCADO_ENVIOS,
  SHOPEE_DESCRIPTION_MAX_LEN,
  SHOPEE_DESCRIPTION_SAFE_LEN,
  SHOPEE_TITLE_MAX_LEN,
  checarMercadoEnvios,
  regrasDeDescricao,
  regrasDeTitulo,
  type Canal,
} from "../app/ai/advisory/channel-rules";
import {
  ML_SAFE_MAX_DIM_CM,
  ML_SAFE_MAX_SUM_CM,
  ML_SAFE_MAX_WEIGHT_KG,
} from "../app/lib/ml-measurements";
import { ML_TITLE_MAX_LEN } from "../app/marketplaces/lib/ml-title";

// ===========================================================================
// As regras de canal que o Bitz repassa ao lojista.
//
// ⭐ O CORAÇÃO DESTE ARQUIVO É O GRUPO "os números batem com o código real".
//
// Uma tool que diz "o limite da Shopee é 120 caracteres" está afirmando algo
// sobre o COMPORTAMENTO DO DEXO, não sobre a Shopee. Se alguém mudar o corte em
// `ListingUseCase` e o Bitz continuar dizendo 120, ele passa a mentir com toda
// a confiança de um número exato — e ninguém descobre, porque nada quebra.
//
// Três desses números vivem em `private static` de um arquivo de 6 mil linhas,
// fora do escopo autorizado desta entrega. Não dá para importar; dá para PINAR.
// ===========================================================================

const LISTING_USECASE = readFileSync(
  join(
    __dirname,
    "..",
    "app",
    "marketplaces",
    "usecases",
    "listing.usercase.ts",
  ),
  "utf8",
);

/** O corpo de um método privado de `ListingUseCase`, a partir da assinatura. */
function corpoDe(metodo: string, linhas = 45): string {
  const i = LISTING_USECASE.indexOf(`private static ${metodo}`);
  expect(i, `método ${metodo} sumiu de listing.usercase.ts`).toBeGreaterThan(
    -1,
  );
  return LISTING_USECASE.slice(i).split("\n").slice(0, linhas).join("\n");
}

describe("⭐ os números batem com o código real", () => {
  it("o teto de título da Shopee é o mesmo que buildShopeeTitle aplica", () => {
    const corpo = corpoDe("buildShopeeTitle");
    expect(
      corpo,
      `channel-rules.ts diz ${SHOPEE_TITLE_MAX_LEN}; confira o corte em buildShopeeTitle`,
    ).toContain(String(SHOPEE_TITLE_MAX_LEN));
  });

  it("os tetos de descrição da Shopee batem com as constantes do usecase", () => {
    expect(LISTING_USECASE).toContain(
      `SHOPEE_MAX_DESCRIPTION = ${SHOPEE_DESCRIPTION_MAX_LEN}`,
    );
    expect(LISTING_USECASE).toContain(
      `SHOPEE_DESC_SAFE_LIMIT = ${SHOPEE_DESCRIPTION_SAFE_LEN}`,
    );
  });

  it("a Shopee de fato ANEXA marca/modelo/ano/PN ao título — a regra não é opinião", () => {
    const corpo = corpoDe("buildShopeeTitle");
    for (const campo of ["brand", "model", "year", "version", "partNumber"]) {
      expect(corpo, `buildShopeeTitle não usa mais ${campo}`).toContain(
        `product.${campo}`,
      );
    }
  });

  it("a Shopee de fato ANEXA o bloco de ficha técnica à descrição", () => {
    const corpo = corpoDe("buildShopeeDescription", 40);
    expect(corpo).toMatch(/Detalhes T\S*cnicos/);
    expect(corpo).toMatch(/SKU:/);
  });

  it("os limites do Mercado Envios são os do próprio ml-measurements", () => {
    expect(LIMITES_MERCADO_ENVIOS).toEqual({
      maiorLadoCm: ML_SAFE_MAX_DIM_CM,
      somaDosLadosCm: ML_SAFE_MAX_SUM_CM,
      pesoKg: ML_SAFE_MAX_WEIGHT_KG,
    });
  });

  it("o teto de título do ML é o mesmo da criação de anúncio", () => {
    expect(regrasDeTitulo("mercado_livre")[0].rule).toContain(
      String(ML_TITLE_MAX_LEN),
    );
  });
});

describe("checagem do Mercado Envios", () => {
  it("medida dentro dos limites não gera problema", () => {
    expect(
      checarMercadoEnvios({
        alturaCm: 30,
        larguraCm: 40,
        comprimentoCm: 50,
        pesoKg: 4,
      }),
    ).toEqual([]);
  });

  it("lado grande demais é apontado", () => {
    const p = checarMercadoEnvios({ comprimentoCm: 150 });
    expect(p.join(" ")).toMatch(/maior lado/);
  });

  it("soma dos lados grande demais é apontada mesmo com cada lado dentro", () => {
    // 90+80+70 = 240: nenhum lado passa de 100, mas a soma passa de 200.
    const p = checarMercadoEnvios({
      alturaCm: 90,
      larguraCm: 80,
      comprimentoCm: 70,
    });
    expect(p.join(" ")).toMatch(/soma dos lados/);
    expect(p.join(" ")).not.toMatch(/maior lado/);
  });

  it("peso acima do limite é apontado", () => {
    expect(checarMercadoEnvios({ pesoKg: 45 }).join(" ")).toMatch(/peso/);
  });

  it("medida ausente não vira problema inventado", () => {
    expect(checarMercadoEnvios({})).toEqual([]);
  });
});

describe("cobertura das regras", () => {
  it.each(CANAIS)("%s tem regra de título e de descrição", (canal) => {
    expect(regrasDeTitulo(canal as Canal).length).toBeGreaterThan(0);
    expect(regrasDeDescricao(canal as Canal).length).toBeGreaterThan(0);
  });

  it.each(CANAIS)("%s: toda regra tem rótulo curto e detalhe útil", (canal) => {
    for (const r of [
      ...regrasDeTitulo(canal as Canal),
      ...regrasDeDescricao(canal as Canal),
    ]) {
      // O `rule` vira uma LINHA do card de fontes; o `detalhe` é o que o modelo
      // repassa. Confundir os dois enche o card de parágrafo.
      expect(r.rule.length, r.rule).toBeLessThanOrEqual(140);
      expect(r.rule.length).toBeGreaterThan(10);
      expect(r.detalhe.length).toBeGreaterThan(30);
    }
  });

  it("o limite PROVISÓRIO do Magalu é declarado como provisório", () => {
    // magalu-constants.ts:91 diz em voz alta que os limites não foram
    // confirmados. Repassar o número sem essa ressalva seria transformar um
    // palpite do código num fato dito pelo agente.
    const texto = [...regrasDeTitulo("magalu"), ...regrasDeDescricao("magalu")]
      .map((r) => r.detalhe)
      .join(" ");
    expect(texto).toMatch(/PROVISÓRIO/i);
  });
});
